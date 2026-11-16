begin;

-- Run on the same database as the live forum. Earlier deployments remain compatible.
alter table public.messages add column if not exists is_featured boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.messages'::regclass and conname = 'messages_featured_root_state'
  ) then
    alter table public.messages add constraint messages_featured_root_state
      check (not is_featured or (reply_to is null and flag is not null and flag in (0, 1)));
  end if;
end;
$$;

-- Keep the quota even after a submission is rejected, demoted, or removed.
create schema if not exists forum_private;
revoke all on schema forum_private from public, anon, authenticated;
create table if not exists forum_private.featured_daily_usage (
  user_id uuid not null,
  submission_day date not null,
  used integer not null check (used between 1 and 3),
  primary key (user_id, submission_day)
);
alter table forum_private.featured_daily_usage enable row level security;
revoke all on table forum_private.featured_daily_usage from public, anon, authenticated;

create or replace function forum_private.count_featured_submission()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_day date := (statement_timestamp() at time zone 'Asia/Shanghai')::date;
begin
  if v_user is null or new.business_user_id is distinct from v_user
    or new.flag is distinct from 0 or new.reply_to is not null then
    raise exception using errcode = '42501', message = 'invalid_featured_submission';
  end if;

  -- The unique key serializes concurrent submissions for the same account and day.
  insert into forum_private.featured_daily_usage as usage (user_id, submission_day, used)
  values (v_user, v_day, 1)
  on conflict (user_id, submission_day) do update
    set used = usage.used + 1
    where usage.used < 3;

  if not found then
    raise exception using errcode = 'P0001', message = 'featured_daily_limit';
  end if;
  return new;
end;
$$;
revoke all on function forum_private.count_featured_submission() from public, anon, authenticated;

drop trigger if exists forum_featured_quota_insert on public.messages;
create trigger forum_featured_quota_insert after insert on public.messages
for each row when (new.is_featured)
execute function forum_private.count_featured_submission();

create or replace function public.forum_featured_remaining()
returns integer
language sql stable security definer set search_path = ''
as $$
  select case when auth.uid() is null then 0 else 3 - coalesce((
    select u.used from forum_private.featured_daily_usage u
    where u.user_id = auth.uid()
      and u.submission_day = (statement_timestamp() at time zone 'Asia/Shanghai')::date
  ), 0) end;
$$;
revoke all on function public.forum_featured_remaining() from public, anon;
grant execute on function public.forum_featured_remaining() to authenticated;

-- The asynchronous reviewer only receives ordinary text submissions.
create or replace function forum_private.enqueue_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.flag = 0 and not new.is_featured and new.business_user_id is not null
    and coalesce(to_jsonb(new.pic_url), '[]'::jsonb) = '[]'::jsonb then
    insert into forum_private.review_jobs(id) values(new.id);
  end if;
  return new;
end;
$$;

-- Preserve the installed public projection, including anonymous media and badge rules.
-- Append a computed flag from the approved row. Never publish account IDs.
do $$
declare
  view_definition text;
begin
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.approved_messages_public'::regclass
      and attname = 'is_featured' and not attisdropped
  ) then
    select pg_get_viewdef('public.approved_messages_public'::regclass, true)
    into view_definition;
    execute format(
      'create or replace view public.approved_messages_public with (security_barrier = true) as
       select feed.*, m.is_featured
       from (%s) feed join public.messages m on m.id = feed.id and m.flag = 1',
      rtrim(rtrim(view_definition), ';')
    );
  end if;
end;
$$;

create or replace function public.moderate_business_message(
  p_message_id uuid,
  p_action text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from integer;
  v_to integer;
  v_user_id uuid;
  v_title text;
  v_content text;
begin
  if not exists (
    select 1 from public.business_users u
    where u.user_id = auth.uid() and u.is_checker = true
  ) then
    raise exception 'forbidden';
  end if;

  if p_action = 'approve' then v_from := 0; v_to := 1; v_title := '留言审核通过'; v_content := '你的留言、评论或回复已审核通过并公开显示';
  elsif p_action = 'approve_featured' then v_from := 0; v_to := 1; v_title := '精华投稿已发表'; v_content := '你的留言已作为精华公开发表';
  elsif p_action = 'reject' then v_from := 0; v_to := 2; v_title := '留言未通过审核'; v_content := '拒绝原因：' || trim(p_reason);
  elsif p_action = 'delete' then v_from := null; v_to := 2; v_title := '留言已被删除'; v_content := '删除原因：' || trim(p_reason);
  elsif p_action = 'restore' then v_from := 2; v_to := 1; v_title := '留言已恢复'; v_content := '你的留言已恢复并重新公开显示';
  else raise exception 'invalid moderation action';
  end if;

  if p_action in ('reject', 'delete') and coalesce(char_length(trim(p_reason)), 0) = 0 then
    raise exception 'moderation reason required';
  end if;

  update public.messages
    set flag = v_to,
        is_featured = (p_action = 'approve_featured'),
        reject_reason = case when v_to = 2 then left(trim(p_reason), 1000) else null end
  where id = p_message_id
    and ((p_action = 'delete' and flag in (0, 1)) or flag = v_from)
    and (p_action <> 'approve_featured' or (is_featured and reply_to is null))
  returning business_user_id into v_user_id;

  if not found then raise exception 'message state conflict'; end if;

  insert into public.business_moderation_logs (operator_user_id, message_id, action, reason)
  values (auth.uid(), p_message_id,
    case when p_action = 'approve_featured' then 'approve' else p_action end,
    case when p_action = 'approve_featured' then '精华发表' else nullif(left(trim(p_reason), 1000), '') end);

  if v_user_id is not null then
    insert into public.business_notifications (user_id, title, content, type, related_id)
    values (v_user_id, v_title, v_content, 'audit', p_message_id);
  end if;
end;
$$;

revoke all on function public.moderate_business_message(uuid, text, text) from public, anon;
grant execute on function public.moderate_business_message(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
