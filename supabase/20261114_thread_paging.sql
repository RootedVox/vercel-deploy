begin;

-- A stable snapshot keeps cursor validation and traversal on the same moderated tree.
create or replace function public.public_forum_thread_page(root_id uuid, after_id uuid default null, page_size integer default 20)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  n integer := least(100, greatest(1, page_size));
  node public.approved_messages_public%rowtype;
  children uuid[];
  pos integer;
  parent_id uuid;
  ids uuid[] := '{}';
  batch jsonb;
  last_id uuid;
begin
  select * into node from public.approved_messages_public where id=root_id and reply_to is null;
  if not found then
    return jsonb_build_object('exists',false,'cursorValid',after_id is null,'messages','[]'::jsonb,'nextCursor',null);
  end if;
  if after_id is null then
    ids := array[root_id];
  else
    -- UNION stops on a cycle. A cursor behind a hidden parent is stale.
    if not exists (
      with recursive ancestors(id,reply_to) as (
        select p.id,p.reply_to from public.approved_messages_public p where p.id=after_id
        union
        select p.id,p.reply_to from ancestors a cross join lateral (
          select v.id,v.reply_to from public.approved_messages_public v where v.id=a.reply_to limit 1
        ) p
      ) select from ancestors where id=root_id
    ) then
      return jsonb_build_object('exists',true,'cursorValid',false,'messages','[]'::jsonb,'nextCursor',null);
    end if;
    select * into node from public.approved_messages_public where id=after_id;
  end if;

  -- Batch adjacent siblings. Descend at the first branch; climb only when a level ends.
  parent_id := node.id;
  -- First batch begins at the first child. Subsequent batches seek past an ancestor.
  select array_agg(s.id order by s.created_at,s.id) into children from (
    select p.id,p.created_at from public.approved_messages_public p where p.reply_to=parent_id
    order by p.reply_to,p.created_at,p.id limit (n+1-cardinality(ids))
  ) s;
  <<walk>>
  while cardinality(ids) <= n loop
    if children is not null then
      -- Only siblings up to the first one with a visible child belong to this batch.
      select q.pos into pos from unnest(children) with ordinality q(id,pos)
        cross join lateral (select 1 from public.approved_messages_public p where p.reply_to=q.id limit 1) child
        order by q.pos limit 1;
      ids := ids || children[1:coalesce(pos,cardinality(children))];
      exit when cardinality(ids)>n;
      if pos is not null then
        parent_id := children[pos];
        select array_agg(s.id order by s.created_at,s.id) into children from (
          select p.id,p.created_at from public.approved_messages_public p where p.reply_to=parent_id
          order by p.reply_to,p.created_at,p.id limit (n+1-cardinality(ids))
        ) s;
        continue walk;
      end if;
    end if;
    exit when parent_id=root_id;
    select p.* into node from public.approved_messages_public p where p.id=parent_id;
    parent_id := node.reply_to;
    select array_agg(s.id order by s.created_at,s.id) into children from (
      select p.id,p.created_at from public.approved_messages_public p
      where p.reply_to=parent_id and (p.created_at,p.id)>(node.created_at,node.id)
      order by p.reply_to,p.created_at,p.id limit (n+1-cardinality(ids))
    ) s;
  end loop;
  if cardinality(ids)>n then last_id := ids[n]; end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by i.pos),'[]'::jsonb) into batch
    from unnest(ids[1:n]) with ordinality i(id,pos) cross join lateral (
      select v.* from public.approved_messages_public v where v.id=i.id limit 1
    ) p;
  return jsonb_build_object('exists',true,'cursorValid',true,'messages',batch,'nextCursor',last_id);
end;
$$;
notify pgrst,'reload schema';
commit;
