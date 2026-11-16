import { authenticateApi } from '../_lib/api.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { uploadBusinessObject, requestBusinessData, listAvatarObjects, deleteAvatarObjects } from '../_lib/supabase.js';

import { thumbnailPath } from '../_lib/forum-media.js';
import { validateAvatar, AVATAR_LIMIT, AVATAR_RETENTION_MS } from '../_lib/avatar.js';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function extensionFor(type) {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[type];
}

function avatarStorageError(error) {
  const status = error.storageStatus || error.status;
  const text = `${error.code || ''} ${error.reason || ''}`.toLowerCase();
  if (['NoSuchBucket', 'BucketNotFound'].includes(error.code) || text.includes('bucket not found')) return 'avatar_bucket_missing';
  // Checked before 403: Storage reports a bad signature as 403 "Unauthorized".
  if (status === 401 || ['InvalidJWT', 'InvalidSignature'].includes(error.code) || /invalid signature|jwt/.test(text)) return 'avatar_storage_auth_failed';
  if (status === 403 || ['AccessDenied', 'Unauthorized', '42501'].includes(error.code) || text.includes('row-level security')) return 'avatar_storage_denied';
  // The bucket's own type and size limits.
  if (status === 415 || error.code === 'invalid_mime_type' || text.includes('mime type')) return 'avatar_type_rejected';
  if (status === 413 || ['EntityTooLarge', 'Payload too large'].includes(error.code) || text.includes('exceeded the maximum allowed size')) return 'avatar_too_large';
  return 'avatar_storage_unavailable';
}

// "avatar_storage_unavailable" covers every failure Storage did not name, which left
// nothing to act on. The answer therefore carries the step that failed and what Storage
// said: its status, code and message describe this one request and hold no secrets.
function storageFailure(stage, error) {
  const clean = (value, length) => String(value ?? '').replace(/[^\w .:,'()\/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
  const detail = {
    stage,
    status: error.storageStatus || error.status || null,
    // Without an HTTP status the request never completed: a timeout or a network error.
    code: clean(error.code, 60) || (error.status ? null : clean(error.message, 60)) || null,
    reason: clean(error.reason, 120) || null
  };
  console.error(`[uploads] avatar stage=${stage} status=${detail.status} code=${detail.code} reason=${detail.reason}`);
  return { error: avatarStorageError(error), detail };
}

async function ownAvatarObjects(env, session) {
  const own = [];
  for (let offset = 0; ; offset += 100) {
    const page = await listAvatarObjects(env, session, offset);
    if (!Array.isArray(page)) throw new Error('invalid_storage_response');
    own.push(...page.filter(item => item.name?.startsWith(session.user_id + '.')));
    if (page.length < 100) return own;
    if (offset >= 900) throw new Error('avatar_storage_limit');
  }
}

// Thumbnails are made on the visitor's device (forum-ui.js) and stored as
// <hash>.thumb.jpg beside the image. They are optional: a missing, oversized or
// non-JPEG one is skipped and the page shows the original instead.
const THUMB_LIMIT = 200 * 1024;
async function storeThumbnail(env, session, thumb, path) {
  if (!thumb || typeof thumb === 'string' || thumb.type !== 'image/jpeg' || !thumb.size || thumb.size > THUMB_LIMIT) return;
  const head = new Uint8Array(await thumb.slice(0, 3).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return;
  try {
    await uploadBusinessObject(env, session, 'message-pics', thumbnailPath(path), thumb, false, true);
  } catch { /* The original is stored; the page falls back to it. */ }
}

export async function onRequestPost({ request, env }) {
  const auth = await authenticateApi(request, env);
  if (auth.response) return auth.response;
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'invalid_request' }, 400, auth.headers); }
  const kind = form.get('kind') === 'avatar' ? 'avatar' : 'message';
  const files = form.getAll('files').filter(value => typeof value !== 'string');
  const maxFiles = kind === 'avatar' ? 1 : 5;
  if (!files.length || files.length > maxFiles || files.some(file => !file.size || !ALLOWED_TYPES.has(file.type) || file.size > 5 * 1024 * 1024)) {
    return json({ error: 'invalid_upload' }, 400, auth.headers);
  }
  const bucket = kind === 'avatar' ? 'avatars' : 'message-pics';
  let avatarPath;
  if (kind === 'avatar') {
    let hash;
    try { hash = await validateAvatar(files[0]); }
    catch { return json({ error: 'invalid_avatar_image' }, 400, auth.headers); }
    avatarPath = `business/${auth.session.user_id}.${hash}.webp`;
    let stage = 'list';
    try {
      const own = await ownAvatarObjects(env, auth.session);
      if (own.some(item => 'business/' + item.name === avatarPath)) {
        const base = String(env.BUSINESS_SUPABASE_URL).replace(/\/$/, '');
        return json({ urls: [base + '/storage/v1/object/public/avatars/' + avatarPath] }, 201, auth.headers);
      }
      const expired = own.filter(item => Date.now() - Date.parse(item.created_at) > AVATAR_RETENTION_MS);
      let remaining = own.length;
      if (expired.length) {
        stage = 'cleanup';
        try {
          const rows = await requestBusinessData(env, auth.session, `business_users?user_id=eq.${encodeURIComponent(auth.session.user_id)}&select=avatar_url&limit=1`);
          if (!Array.isArray(rows) || rows.length !== 1) throw new Error('profile_unavailable');
          const currentPath = rows[0].avatar_url ? new URL(rows[0].avatar_url).pathname : null;
          const obsolete = expired.filter(item => '/storage/v1/object/public/avatars/business/' + item.name !== currentPath);
          if (obsolete.length) {
            await deleteAvatarObjects(env, auth.session, obsolete.map(item => 'business/' + item.name));
            // A successful delete can still affect zero rows under a Storage policy.
            if (remaining >= AVATAR_LIMIT) remaining = (await ownAvatarObjects(env, auth.session)).length;
          }
        } catch (error) {
          // Below quota, housekeeping can wait until the next upload.
          if (remaining >= AVATAR_LIMIT) throw error;
        }
      }
      if (remaining >= AVATAR_LIMIT) return json({ error: 'avatar_storage_limit' }, 429, auth.headers);
    } catch (error) {
      if (error.message === 'avatar_storage_limit') return json({ error: 'avatar_storage_limit' }, 429, auth.headers);
      return json(storageFailure(stage, error), 503, auth.headers);
    }
  }
  const urls = [];
  try {
    for (const file of files) {
      const hash = kind === 'message'
        ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('')
        : null;
      const path = kind === 'avatar'
        ? avatarPath
        : `business/${auth.session.user_id}/${hash}.${extensionFor(file.type)}`;
      if (kind === 'message') {
        let ready = true;
        try {
          ready = await requestBusinessData(env, auth.session, 'rpc/prepare_forum_media', {
            method: 'POST', body: JSON.stringify({ object_name: path })
          });
        } catch {
          // 迁移未执行时跳过登记，沿用旧上传流程
        }
        if (ready === false) throw new Error('upload_cleanup_pending');
      }
      const stored = {};
      urls.push(await uploadBusinessObject(env, auth.session, bucket, path, file, false, true, stored));
      // The thumbnail is stored only next to an image written by this very request. An
      // image that already existed may be in an approved post, and a thumbnail added
      // later would show in the feed without having been reviewed.
      if (kind === 'message' && !stored.reused) {
        await storeThumbnail(env, auth.session, form.get('thumb' + (urls.length - 1)), path);
      }
    }
    return json({ urls }, 201, auth.headers);
  } catch (error) {
    return json(kind === 'avatar' ? storageFailure('upload', error) : { error: 'upload_failed' }, 503, auth.headers);
  }
}

export function onRequest() {
  return methodNotAllowed('POST');
}
