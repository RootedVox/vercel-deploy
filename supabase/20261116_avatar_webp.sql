-- RootedVox: avatar uploads are WebP. Run after 20261105_avatar_lifecycle.sql.
--
-- The avatars bucket stores WebP to keep avatars small, and the avatar editor now exports
-- a 256x256 WebP named <user>.<sha256>.webp. The insert check from
-- 20261105_avatar_lifecycle.sql only allowed <user>.<sha256>.png, so it would refuse
-- every new avatar. This replaces that one function with the same body and the .webp
-- name. The bucket, the policies and existing files are not touched. Safe to run again.
begin;
create or replace function public.isa_avatar_can_insert(object_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid text := auth.uid()::text; n integer;
begin
  if uid is null or object_name !~ ('^business/' || uid || '\.[a-f0-9]{64}\.webp$') then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('isa-avatar:' || uid, 0));
  select count(*) into n from storage.objects where bucket_id='avatars' and name like 'business/' || uid || '.%';
  return n < 64;
end;
$$;
revoke all on function public.isa_avatar_can_insert(text) from public, anon;
grant execute on function public.isa_avatar_can_insert(text) to authenticated;
notify pgrst, 'reload schema';
commit;

-- Check: returns true when the function accepts .webp names.
--   select pg_get_functiondef('public.isa_avatar_can_insert(text)'::regprocedure) like '%.webp$%';
