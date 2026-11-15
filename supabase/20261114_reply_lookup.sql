begin;

-- Walk only the target's visible ancestors. UNION also terminates malformed cycles.
create or replace function public.public_forum_reply(root_id uuid, target_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with recursive ancestors(id, reply_to) as (
    select p.id, p.reply_to from public.approved_messages_public p where p.id = target_id
    union
    select p.id, p.reply_to from public.approved_messages_public p
    join ancestors child on p.id = child.reply_to
  ), root as (
    select p.* from public.approved_messages_public p where p.id = root_id and p.reply_to is null
  ), target as (
    select p.* from public.approved_messages_public p
    where p.id = target_id and p.id <> root_id
      and exists (select from ancestors where id = root_id and reply_to is null)
  )
  select jsonb_build_object(
    'messages', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from root r)
             || (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from target t),
    'parentName', (select p.username from target t join public.approved_messages_public p on p.id = t.reply_to)
  );
$$;
revoke all on function public.public_forum_reply(uuid,uuid) from public;
grant execute on function public.public_forum_reply(uuid,uuid) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
