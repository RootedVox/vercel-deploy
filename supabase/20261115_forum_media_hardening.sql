begin;
-- Run after 20261113_forum_optimization.sql. Safe to run more than once.

-- Every content-addressed object a post has referenced. Cleanup checks this by
-- primary key instead of scanning every post's image list. Rows are never removed:
-- a stale entry only keeps a file, it never deletes one.
create table if not exists forum_private.attached_media (
  object_name text primary key
);
insert into forum_private.attached_media(object_name)
select distinct r.object_name from (
  select substring(u.url from '/storage/v1/object/public/message-pics/(business/[0-9a-f-]+/[0-9a-f]{64}\.(?:png|jpg|gif|webp))$') as object_name
  from public.messages m,
    lateral jsonb_array_elements_text(coalesce(nullif(to_jsonb(m.pic_url),'null'::jsonb),'[]'::jsonb)) u(url)
) r
where r.object_name is not null
on conflict do nothing;

-- A post may only attach new uploads stored under its own business user ID.
create or replace function forum_private.attach_media() returns trigger
language plpgsql security definer set search_path='' as $$
declare image text; media_path text; deleting_now boolean;
begin
  for image in select jsonb_array_elements_text(coalesce(nullif(to_jsonb(new.pic_url),'null'::jsonb),'[]'::jsonb)) loop
    media_path := substring(image from '/storage/v1/object/public/message-pics/(business/[0-9a-f-]+/[0-9a-f]{64}\.(?:png|jpg|gif|webp))$');
    if media_path is null then continue; end if;
    if new.business_user_id is null or media_path not like ('business/' || new.business_user_id::text || '/%') then
      raise exception 'invalid media owner';
    end if;
    select p.deleting into deleting_now from forum_private.pending_media p where p.object_name=media_path for update;
    if deleting_now then raise exception 'upload expired'; end if;
    if not found and not exists(select from storage.objects o where o.bucket_id='message-pics' and o.name=media_path) then
      raise exception 'upload missing';
    end if;
    delete from forum_private.pending_media p where p.object_name=media_path;
    insert into forum_private.attached_media(object_name) values(media_path) on conflict do nothing;
  end loop;
  return new;
end;
$$;

create or replace function public.claim_forum_media_cleanup()
returns table(object_name text) language sql security definer set search_path='' as $$
  -- A repeated upload can register a hash already in use. Never remove it.
  delete from forum_private.pending_media p where p.touched_at<now()-interval '7 days'
    and exists (select from forum_private.attached_media a where a.object_name=p.object_name);
  update forum_private.pending_media p set deleting=true, touched_at=now()
    where p.object_name in (select q.object_name from forum_private.pending_media q
      where q.touched_at < now()-case when q.deleting then interval '10 minutes' else interval '7 days' end
        and not exists (select from forum_private.attached_media a where a.object_name=q.object_name)
      order by q.touched_at limit 25 for update skip locked)
    returning p.object_name;
$$;
revoke all on function public.claim_forum_media_cleanup() from public,anon,authenticated;
grant execute on function public.claim_forum_media_cleanup() to service_role;

notify pgrst,'reload schema';
commit;
