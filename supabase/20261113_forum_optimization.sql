begin;
-- Match the official business account and legacy posts with only a legacy author ID.
-- Only a boolean is published. Anonymous messages do not carry the badge.
create or replace view public.approved_messages_public
with (security_barrier = true)
as
select m.id, m.username, m.content, m.zone, m.pic_url, m.created_at, m.reply_to,
       case when m.username = '匿名用户' then null else u.avatar_url end as avatar_url,
       coalesce(m.username <> '匿名用户' and (
         m.business_user_id = '3ec4494f-05a7-5033-809a-ba9a66ee6383'::uuid
         or (m.business_user_id is null and m.user_id = '2da104a0-6662-4cb8-ac95-7781383c98f2'::uuid)
       ), false) as is_official
from public.messages m
left join public.business_users u on u.user_id = m.business_user_id
where m.flag = 1;

-- public_forum_thread reads only through the approved, anonymous-safe projection.
-- Walk children from a real root so descendants of hidden parents stay hidden.
create or replace function public.public_forum_thread(root_id text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with recursive thread as (
    select m.* from public.approved_messages_public m
    where m.id::text = lower(root_id) and m.reply_to is null
    union all
    select child.* from public.approved_messages_public child
    join thread parent on child.reply_to = parent.id
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]'::jsonb) from thread t;
$$;
grant execute on function public.public_forum_thread(text) to anon, authenticated;
-- New clients request one depth-first page. The original full-thread RPC stays
-- available to existing callers. Each path sorts by time and ID at every level.
create or replace function public.public_forum_thread_page(root_id uuid, after_id uuid default null, page_size integer default 20)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with recursive tree(id, path) as (
    select p.id, array[to_char(p.created_at at time zone 'UTC','YYYYMMDDHH24MISSUS') || p.id::text]
    from public.approved_messages_public p where p.id=root_id and p.reply_to is null
    union all
    select c.id, t.path || (to_char(c.created_at at time zone 'UTC','YYYYMMDDHH24MISSUS') || c.id::text)
    from tree t join public.approved_messages_public c on c.reply_to=t.id
  ), slice as (
    select id,path from tree
    where after_id is null or path > (select path from tree where id=after_id)
    order by path limit least(100,greatest(1,page_size))+1
  ), visible as (
    select * from slice order by path limit least(100,greatest(1,page_size))
  )
  select jsonb_build_object(
    'exists', exists(select from tree where id=root_id),
    'cursorValid', after_id is null or exists(select from tree where id=after_id),
    'messages', coalesce((select jsonb_agg(to_jsonb(p) order by v.path) from visible v
       join public.approved_messages_public p on p.id=v.id),'[]'::jsonb),
    'nextCursor', case when (select count(*) from slice)>least(100,greatest(1,page_size))
       then (select id from visible order by path desc limit 1) end
  );
$$;
grant execute on function public.public_forum_thread_page(uuid,uuid,integer) to anon,authenticated;
create index if not exists messages_approved_replies_idx on public.messages(reply_to, created_at, id) where flag = 1;

create or replace function public.public_forum_overview()
returns table (id uuid, username text, content text, zone text, created_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select m.id, m.username::text, m.content::text, z.zone, m.created_at
  from (values ('日常分享'), ('学习互助'), ('活动社团'), ('失物招领')) z(zone)
  cross join lateral (
    select p.id,p.username,p.content,p.created_at from public.approved_messages_public p
    where p.reply_to is null and (p.zone=z.zone or (z.zone='日常分享' and p.zone='校园生活'))
    order by p.created_at desc,p.id desc limit 2
  ) m order by m.created_at desc,m.id desc;
$$;
grant execute on function public.public_forum_overview() to anon, authenticated;

-- The public write still obeys messages_insert_self_pending. Only this leased
-- service-role worker may conditionally approve an unchanged pending record.
create schema if not exists forum_private;
revoke all on schema forum_private from public, anon, authenticated;
create table if not exists forum_private.review_jobs (
  id uuid primary key references public.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  lease_id uuid, available_at timestamptz not null default now(), attempts integer not null default 0
);
create index if not exists forum_review_available on forum_private.review_jobs(available_at,created_at);
create table if not exists forum_private.review_counts (
  day date not null, outcome text not null, total bigint not null default 0, primary key(day,outcome)
);
create or replace function forum_private.enqueue_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.flag = 0 and new.business_user_id is not null and coalesce(to_jsonb(new.pic_url),'[]'::jsonb) = '[]'::jsonb then
    insert into forum_private.review_jobs(id) values(new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists forum_review_insert on public.messages;
create trigger forum_review_insert after insert on public.messages for each row execute function forum_private.enqueue_review();

create or replace function public.claim_forum_review(target uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job uuid; token uuid := gen_random_uuid(); body text;
begin
  select j.id, m.content into job, body from forum_private.review_jobs j
  join public.messages m on m.id=j.id
  where j.available_at <= now() and (target is null or j.id=target) and m.flag=0
  order by j.available_at,j.created_at limit 1 for update of j skip locked;
  if job is null then return null; end if;
  update forum_private.review_jobs set lease_id=token,available_at=now()+interval '2 minutes',attempts=attempts+1 where id=job;
  return jsonb_build_object('id',job,'lease',token,'content',body);
end;
$$;

create or replace function public.finish_forum_review(target uuid, lease uuid, decision text, reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare tries integer;
begin
  -- Use the same lock order as a human moderation update (message, then job).
  perform 1 from public.messages where id=target and flag=0 for update;
  if not found then return false; end if;
  select attempts into tries from forum_private.review_jobs where id=target and lease_id=lease for update;
  if not found then return false; end if;
  if reason in ('upstream_unavailable','missing_key','lexicon_unavailable') and tries < 3 then
    update forum_private.review_jobs set lease_id=null,available_at=now()+interval '5 minutes' where id=target;
    return false;
  end if;
  if decision='safe' and reason='model_safe' then
    update public.messages set flag=1 where id=target and flag=0;
  end if;
  delete from forum_private.review_jobs where id=target;
  insert into forum_private.review_counts(day,outcome,total)
    values((now() at time zone 'UTC')::date,reason,1)
    on conflict(day,outcome) do update set total=forum_private.review_counts.total+1;
  return true;
end;
$$;
create or replace function forum_private.close_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from forum_private.review_jobs where id=new.id;
  return new;
end;
$$;
drop trigger if exists forum_review_closed on public.messages;
create trigger forum_review_closed after update of flag on public.messages for each row
when (old.flag=0 and new.flag<>0) execute function forum_private.close_review();
revoke all on function public.claim_forum_review(uuid), public.finish_forum_review(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.claim_forum_review(uuid), public.finish_forum_review(uuid,uuid,text,text) to service_role;
-- Mark through the newest notification shown to the user. A later arrival
-- remains unread and can keep the red dot visible.
create or replace function public.read_forum_notifications(through_id bigint default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.business_notifications n set read=true
    where n.user_id=auth.uid() and n.read=false and (through_id is null or n.id<=through_id);
  return exists(select from public.business_notifications n where n.user_id=auth.uid() and n.read=false);
end;
$$;
revoke all on function public.read_forum_notifications(bigint) from public,anon;
grant execute on function public.read_forum_notifications(bigint) to authenticated;

-- Track only new content-addressed uploads. Storage deletion goes through its API.
create table if not exists forum_private.pending_media (
  object_name text primary key, touched_at timestamptz not null default now(), deleting boolean not null default false
);
create index if not exists forum_pending_media_age on forum_private.pending_media(touched_at);

create or replace function public.prepare_forum_media(object_name text) returns boolean
language plpgsql security definer set search_path='' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or object_name !~ ('^business/' || uid::text || '/[0-9a-f]{64}\.(png|jpg|gif|webp)$') then
    raise exception 'invalid media owner';
  end if;
  insert into forum_private.pending_media as p(object_name) values($1)
    on conflict on constraint pending_media_pkey do update set touched_at=now() where not p.deleting;
  return found;
end;
$$;

create or replace function forum_private.attach_media() returns trigger
language plpgsql security definer set search_path='' as $$
declare image text; media_path text; deleting_now boolean;
begin
  for image in select jsonb_array_elements_text(coalesce(nullif(to_jsonb(new.pic_url),'null'::jsonb),'[]'::jsonb)) loop
    media_path := substring(image from '/storage/v1/object/public/message-pics/(business/[0-9a-f-]+/[0-9a-f]{64}\.(?:png|jpg|gif|webp))$');
    if media_path is null then continue; end if;
    select p.deleting into deleting_now from forum_private.pending_media p where p.object_name=media_path for update;
    if deleting_now then raise exception 'upload expired'; end if;
    if not found and not exists(select from storage.objects o where o.bucket_id='message-pics' and o.name=media_path) then
      raise exception 'upload missing';
    end if;
    delete from forum_private.pending_media p where p.object_name=media_path;
  end loop;
  return new;
end;
$$;
drop trigger if exists forum_media_attached on public.messages;
create trigger forum_media_attached before insert on public.messages for each row execute function forum_private.attach_media();

create or replace function public.claim_forum_media_cleanup()
returns table(object_name text) language sql security definer set search_path='' as $$
  -- A repeated upload can register a hash already in use. Never remove it.
  delete from forum_private.pending_media p where p.touched_at<now()-interval '7 days'
    and exists (select from public.messages m, lateral jsonb_array_elements_text(
      coalesce(nullif(to_jsonb(m.pic_url),'null'::jsonb),'[]'::jsonb)) u(url)
      where right(u.url,length('/message-pics/'||p.object_name))='/message-pics/'||p.object_name);
  update forum_private.pending_media p set deleting=true, touched_at=now()
    where p.object_name in (select q.object_name from forum_private.pending_media q
      where q.touched_at < now()-case when q.deleting then interval '10 minutes' else interval '7 days' end
      order by q.touched_at limit 25 for update skip locked)
    returning p.object_name;
$$;
create or replace function public.finish_forum_media_cleanup(names text[]) returns void
language sql security definer set search_path='' as $$
  delete from forum_private.pending_media p where p.deleting and p.object_name=any(names);
$$;
revoke all on function public.prepare_forum_media(text) from public,anon;
grant execute on function public.prepare_forum_media(text) to authenticated;
revoke all on function public.claim_forum_media_cleanup(),public.finish_forum_media_cleanup(text[]) from public,anon,authenticated;
grant execute on function public.claim_forum_media_cleanup(),public.finish_forum_media_cleanup(text[]) to service_role;

notify pgrst,'reload schema';
commit;
