begin;
-- Run after 20261115_forum_feed_paging.sql. Safe to run more than once.
--
-- The feed shows "💬 N 条评论" under each post. N counts every approved reply in the
-- thread, at any depth, reached through approved replies only: a reply under a hidden
-- or deleted comment is not shown in the thread, so it is not counted either. Until
-- this has been run the feed simply shows "💬 评论" without a number.

create or replace function public.public_forum_reply_counts(p_ids uuid[])
returns table(id uuid, replies integer)
language sql stable security definer set search_path = '' as $$
  with recursive tree(root, id, depth) as (
    select m.id, m.id, 0
    from public.messages m
    where m.id = any(p_ids[1:50]) and m.flag = 1 and m.reply_to is null
    union all
    -- messages_approved_replies_idx (reply_to) where flag = 1 serves this join.
    select t.root, r.id, t.depth + 1
    from tree t
    join public.messages r on r.reply_to = t.id and r.flag = 1
    where t.depth < 100
  )
  select t.root, (count(*) - 1)::integer from tree t group by t.root;
$$;
revoke all on function public.public_forum_reply_counts(uuid[]) from public;
grant execute on function public.public_forum_reply_counts(uuid[]) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
