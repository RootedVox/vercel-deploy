-- Apply to the shared business database before deploying the updated messages API.
-- Only a boolean is published. Anonymous messages do not carry the badge.
create or replace view public.approved_messages_public
with (security_barrier = true)
as
select m.id, m.username, m.content, m.zone, m.pic_url, m.created_at, m.reply_to,
       case when m.username = '匿名用户' then null else u.avatar_url end as avatar_url,
       coalesce(m.username <> '匿名用户' and m.business_user_id = '2da104a0-6662-4cb8-ac95-7781383c98f2'::uuid, false) as is_official
from public.messages m
left join public.business_users u on u.user_id = m.business_user_id
where m.flag = 1;

notify pgrst, 'reload schema';
