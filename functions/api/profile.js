import { authenticateApi, cleanText } from '../_lib/api.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { isOfficialNickname, OFFICIAL_USER_ID, resolveProfileNickname } from '../_lib/official-profile.js';
import { requestBusinessData } from '../_lib/supabase.js';

const MAX_NICKNAME_LENGTH = 40;
const RESERVED_NICKNAMES = new Set([
  '匿名用户',
  'sam.li',
  'jerry',
  'maod1e',
  'bychhh',
  '曹颢喆 jerry'
]);

export function normalizeNickname(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function validNickname(value, userId) {
  return value.length >= 1
    && value.length <= MAX_NICKNAME_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
    && (!isOfficialNickname(value) || userId === OFFICIAL_USER_ID)
    && !RESERVED_NICKNAMES.has(value.toLocaleLowerCase('zh-CN'));
}

export async function onRequestGet({ request, env }) {
  const auth = await authenticateApi(request, env);
  if (auth.response) return auth.response;
  try {
    const rows = await requestBusinessData(env, auth.session, `business_users?user_id=eq.${encodeURIComponent(auth.session.user_id)}&select=nickname,display_name,avatar_url&limit=1`);
    const row = rows[0] || {};
    return json({
      nickname: resolveProfileNickname(
        auth.session.user_id, row.nickname,
        row.display_name || auth.session.display_name || auth.session.email?.split('@')[0] || '校园用户'
      ),
      customNickname: row.nickname || null,
      avatarUrl: row.avatar_url || null
    }, 200, auth.headers);
  } catch { return json({ error: 'profile_unavailable' }, 503, auth.headers); }
}

export async function onRequestPut({ request, env }) {
  const auth = await authenticateApi(request, env);
  if (auth.response) return auth.response;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_request' }, 400, auth.headers); }
  const patch = {};

  if (Object.hasOwn(body, 'nickname')) {
    const nickname = normalizeNickname(body.nickname);
    if (!validNickname(nickname, auth.session.user_id)) return json({ error: 'invalid_nickname' }, 400, auth.headers);
    patch.nickname = cleanText(resolveProfileNickname(auth.session.user_id, nickname), MAX_NICKNAME_LENGTH);
  }

  if (Object.hasOwn(body, 'avatarUrl')) {
    let avatar;
    try { avatar = new URL(body.avatarUrl); } catch { return json({ error: 'invalid_avatar' }, 400, auth.headers); }
    const base = new URL(String(env.BUSINESS_SUPABASE_URL));
    const requiredPrefix = `/storage/v1/object/public/avatars/business/${auth.session.user_id}.`;
    const suffix = avatar.pathname.slice(requiredPrefix.length);
    if (avatar.origin !== base.origin || avatar.username || avatar.password || avatar.search || avatar.hash || !avatar.pathname.startsWith(requiredPrefix) || !/^[a-f0-9]{64}\.png$/.test(suffix)) return json({ error: 'invalid_avatar' }, 400, auth.headers);
    patch.avatar_url = avatar.toString();
  }

  if (!Object.keys(patch).length) return json({ error: 'invalid_request' }, 400, auth.headers);
  try {
    await requestBusinessData(env, auth.session, `business_users?user_id=eq.${encodeURIComponent(auth.session.user_id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch)
    });
    return json({
      ok: true,
      nickname: patch.nickname,
      avatarUrl: patch.avatar_url
    }, 200, auth.headers);
  } catch { return json({ error: 'profile_save_failed' }, 503, auth.headers); }
}

export function onRequest() {
  return methodNotAllowed('GET, PUT');
}
