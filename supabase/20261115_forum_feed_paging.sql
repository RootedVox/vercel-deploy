begin;
-- Run after 20261113_forum_optimization.sql. Safe to run more than once.
--
-- approved_messages_public is a security_barrier view, so PostgreSQL cannot push the
-- feed's ORDER BY / LIMIT into it: every list request sorted all approved posts. These
-- functions page through public.messages on an index first, then read the page's rows
-- from the same view, so the published columns and their rules stay in one place.

create index if not exists messages_approved_feed_idx
  on public.messages (created_at desc, id desc)
  where flag = 1 and reply_to is null;
create index if not exists messages_approved_zone_feed_idx
  on public.messages (zone, created_at desc, id desc)
  where flag = 1 and reply_to is null;

-- Top-level approved posts, newest (or oldest) first. A cursor is the last row's
-- (created_at, id); without one, p_skip keeps old page-number links working.
create or replace function public.public_forum_feed(
  p_zones text[] default null,
  p_ascending boolean default false,
  p_after_time timestamptz default null,
  p_after_id uuid default null,
  p_skip integer default 0,
  p_page_size integer default 21,
  p_search text default null
) returns setof public.approved_messages_public
language plpgsql stable security definer set search_path = '' as $$
declare
  page_size integer := least(greatest(coalesce(p_page_size, 21), 1), 51);
  skip integer := least(greatest(coalesce(p_skip, 0), 0), 1000000);
  pattern text := case when coalesce(p_search, '') = '' then null
    else '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  ids uuid[];
begin
  if (p_after_time is null) <> (p_after_id is null) then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  if p_ascending then
    ids := array(
      select m.id from public.messages m
      where m.flag = 1 and m.reply_to is null
        and (p_zones is null or m.zone = any(p_zones))
        and (pattern is null or m.content ilike pattern)
        and (m.created_at, m.id) > (coalesce(p_after_time, '-infinity'), coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'))
      order by m.created_at, m.id
      offset skip limit page_size);
    -- "id = any(array)" is leakproof, so it reaches the view's primary-key index.
    return query select v.* from public.approved_messages_public v
      where v.id = any(ids) order by v.created_at, v.id;
  else
    ids := array(
      select m.id from public.messages m
      where m.flag = 1 and m.reply_to is null
        and (p_zones is null or m.zone = any(p_zones))
        and (pattern is null or m.content ilike pattern)
        and (m.created_at, m.id) < (coalesce(p_after_time, 'infinity'), coalesce(p_after_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'))
      order by m.created_at desc, m.id desc
      offset skip limit page_size);
    return query select v.* from public.approved_messages_public v
      where v.id = any(ids) order by v.created_at desc, v.id desc;
  end if;
end;
$$;
revoke all on function public.public_forum_feed(text[],boolean,timestamptz,uuid,integer,integer,text) from public;
grant execute on function public.public_forum_feed(text[],boolean,timestamptz,uuid,integer,integer,text) to anon, authenticated;

-- Same result as before (two newest approved top-level posts per zone), read by index.
create or replace function public.public_forum_overview()
returns table (id uuid, username text, content text, zone text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select v.id, v.username::text, v.content::text,
         case when v.zone = '校园生活' then '日常分享' else v.zone end, v.created_at
  from public.approved_messages_public v
  where v.id = any(array(
    select page.id
    from (values ('日常分享'), ('学习互助'), ('活动社团'), ('失物招领')) z(zone)
    cross join lateral (
      select m.id from public.messages m
      where m.flag = 1 and m.reply_to is null
        and (m.zone = z.zone or (z.zone = '日常分享' and m.zone = '校园生活'))
      order by m.created_at desc, m.id desc limit 2
    ) page))
  order by v.created_at desc, v.id desc;
$$;
revoke all on function public.public_forum_overview() from public;
grant execute on function public.public_forum_overview() to anon, authenticated;

analyze public.messages;
notify pgrst, 'reload schema';
commit;
