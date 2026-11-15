-- RootedVox: let the avatars bucket accept the avatar editor's PNG output.
--
-- The bucket was set up for the old client, which uploaded <user>.webp. The avatar editor
-- uploads a 256x256 PNG of up to 1 MB named <user>.<sha256>.png. Storage answers a type
-- outside allowed_mime_types with 415 and a body above file_size_limit with 413, and the
-- site reported both as "头像存储服务暂不可用". No <user>.<sha256>.png object exists in
-- the bucket, so no editor upload has succeeded so far.
--
-- Only the avatars bucket changes, and only by widening: an unrestricted type list or size
-- limit stays unrestricted. Nothing is deleted. Safe to run more than once.
begin;

update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'image/png')
where id = 'avatars'
  and cardinality(allowed_mime_types) > 0
  and not ('image/png' = any(allowed_mime_types) or 'image/*' = any(allowed_mime_types));

update storage.buckets
set file_size_limit = 1048576
where id = 'avatars'
  and file_size_limit is not null
  and file_size_limit < 1048576;

commit;

-- Check the result: allowed_mime_types is empty/null or contains image/png, and
-- file_size_limit is null or at least 1048576.
--   select id, public, allowed_mime_types, file_size_limit from storage.buckets where id = 'avatars';
-- 20261105_avatar_lifecycle.sql is still required; this returns one row once it has run:
--   select proname from pg_proc where proname = 'isa_avatar_can_insert';
