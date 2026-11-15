-- Publish post-scoped image URLs for both existing and future anonymous posts.
-- Preserve the installed pic_url type (including text[] and jsonb).
-- Original object names remain available to the owner and moderation backend.
begin;
create or replace view public.approved_messages_public
with (security_barrier = true)
as
select m.id, m.username, m.content, m.zone,
       case when m.username = '匿名用户' and m.pic_url is not null then
         (jsonb_populate_record(null::public.messages, jsonb_build_object('pic_url', (
           select coalesce(jsonb_agg('/api/messages?media=' || m.id::text || '&slot=' || (a.pos-1)::text order by a.pos), '[]'::jsonb)
           from jsonb_array_elements(case when jsonb_typeof(to_jsonb(m.pic_url)) = 'array'
             then to_jsonb(m.pic_url) else '[]'::jsonb end) with ordinality a(value,pos)
         )))).pic_url
       else m.pic_url end as pic_url, m.created_at, m.reply_to,
       case when m.username = '匿名用户' then null else u.avatar_url end as avatar_url,
       coalesce(m.username <> '匿名用户' and (
         m.business_user_id = '3ec4494f-05a7-5033-809a-ba9a66ee6383'::uuid
         or (m.business_user_id is null and m.user_id = '2da104a0-6662-4cb8-ac95-7781383c98f2'::uuid)
       ), false) as is_official
from public.messages m
left join public.business_users u on u.user_id = m.business_user_id
where m.flag = 1;

notify pgrst,'reload schema';
commit;
