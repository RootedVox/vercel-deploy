begin;

-- A reply notification stores the reply id. Opening the thread needs the root, so walk
-- up the visible ancestor chain. Only approved rows participate, which means a reply that
-- is still pending or was deleted resolves to null and the client can say so instead of
-- opening an unrelated page. UNION (not UNION ALL) also terminates a malformed cycle.
create or replace function public.public_forum_reply_root(target_id uuid)
returns uuid
language sql stable security invoker set search_path = ''
as $$
  with recursive chain(id, reply_to) as (
    select p.id, p.reply_to from public.approved_messages_public p where p.id = target_id
    union
    select p.id, p.reply_to from public.approved_messages_public p
    join chain child on p.id = child.reply_to
  )
  select id from chain where reply_to is null limit 1;
$$;
revoke all on function public.public_forum_reply_root(uuid) from public;
grant execute on function public.public_forum_reply_root(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
