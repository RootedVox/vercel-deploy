-- Apply once to the shared forum database. A failed insert rolls back the job
-- completion, so the scheduled worker can retry after the lease expires.
begin;
create or replace function public.finish_forum_lexicon_review(target uuid, lease uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.finish_forum_review(target, lease, 'blocked', 'lexicon') then
    return false;
  end if;
  insert into public.business_notifications (user_id, title, content, type, related_id)
    select business_user_id, '留言转为人工审核', '你的留言触发了词库检查，正在等待人工复核。', 'audit', id
    from public.messages where id = target and flag = 0 and business_user_id is not null;
  return true;
end;
$$;
revoke all on function public.finish_forum_lexicon_review(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finish_forum_lexicon_review(uuid, uuid) to service_role;
commit;
