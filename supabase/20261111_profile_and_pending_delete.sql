-- ISA Spectrum: user-editable nickname/avatar projection and moderator removal
-- of either pending or already-published posts.
-- Run in the BUSINESS Supabase project SQL editor. Safe to run more than once.

begin;

alter table public.business_users
  add column if not exists nickname text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_users'::regclass
      and conname = 'business_users_nickname_check'
  ) then
    alter table public.business_users
      add constraint business_users_nickname_check
      check (nickname is null or char_length(nickname) between 1 and 40);
  end if;
end $$;

-- RLS remains authoritative: business_users_update_self only permits a user to
-- update their own row, and is_checker is deliberately not granted.
grant update (nickname, avatar_url)
  on table public.business_users to authenticated;

-- Only the avatar of an approved, non-anonymous message is public. No account id,
-- email or identity-provider field is exposed by this view.
drop view if exists public.approved_messages_public;
create view public.approved_messages_public
with (security_barrier = true)
as
select m.id, m.username, m.content, m.zone, m.pic_url, m.created_at, m.reply_to,
       case when m.username = '匿名用户' then null else u.avatar_url end as avatar_url
from public.messages m
left join public.business_users u on u.user_id = m.business_user_id
where m.flag = 1;

revoke all on table public.approved_messages_public from public;
grant select on table public.approved_messages_public to anon, authenticated;

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
        reject_reason = case when v_to = 2 then left(trim(p_reason), 1000) else null end
  where id = p_message_id
    and ((p_action = 'delete' and flag in (0, 1)) or flag = v_from)
  returning business_user_id into v_user_id;

  if not found then raise exception 'message state conflict'; end if;

  insert into public.business_moderation_logs (operator_user_id, message_id, action, reason)
  values (auth.uid(), p_message_id, p_action, nullif(left(trim(p_reason), 1000), ''));

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
