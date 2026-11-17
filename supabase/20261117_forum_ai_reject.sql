-- AI 初审多家供应商一致判定为不安全时，直接把留言置为拒绝态（flag=2），
-- 不再留在 flag=0 让人工把同样的判断重复做一遍。
--
-- 只对 decision='blocked' 且 reason='model_unsafe' 生效，原因有两条：
--   1. L1 词库命中（reason='lexicon'）误判率明显高于模型，命中只代表"需要人看"，
--      继续保持 flag=0 转人工，不能自动拒绝。
--   2. reason 是判定结果的一部分，换 reason 就等于换语义，这里显式配对写死，
--      避免以后新增 reason 时被意外当成拒绝依据。
--
-- flag=2 与人工 reject 完全同构：reject_reason 有值，作者会收到"留言未通过审核"，
-- 审核端可以 restore（2 -> 1）纠正误判，所以这不是不可挽回的操作。
--
-- 自动化审核没有 operator_user_id，因此不写 business_moderation_logs（该表
-- operator_user_id 非空，只记录人工操作）；AI 的判定分布记录在 review_counts。

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
  elsif decision='blocked' and reason='model_unsafe' then
    update public.messages
      set flag=2,
          reject_reason='内容安全模型一致判定为不适宜公开发布'
    where id=target and flag=0;
  end if;
  delete from forum_private.review_jobs where id=target;
  insert into forum_private.review_counts(day,outcome,total)
    values((now() at time zone 'UTC')::date,reason,1)
    on conflict(day,outcome) do update set total=forum_private.review_counts.total+1;
  return true;
end;
$$;
revoke all on function public.finish_forum_review(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.finish_forum_review(uuid,uuid,text,text) to service_role;
