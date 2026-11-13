import { processNextModeration } from '../_lib/moderation-worker.js';
import { authenticateApi, cleanText, integerParam } from '../_lib/api.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { applyPage, pageResult } from '../_lib/pagination.js';
import { resolveProfileNickname } from '../_lib/official-profile.js';
import { requestBusinessData, requestPublicData } from '../_lib/supabase.js';

const LEGACY_DAILY_ZONE = '校园生活';
const DAILY_ZONE = '日常分享';
const ZONES = new Set([DAILY_ZONE, '学习互助', '活动社团', '失物招领']);
const MESSAGE_ID = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function normalizeMessageZone(message) {
  return message.zone === LEGACY_DAILY_ZONE ? { ...message, zone: DAILY_ZONE } : message;
}

async function listMessages(request, env) {
  const url = new URL(request.url);
  const thread = url.searchParams.get('thread');
  const params = new URLSearchParams({
    select: 'id,username,content,zone,pic_url,created_at,reply_to,avatar_url,is_official'
  });

  if (thread) {
    if (!MESSAGE_ID.test(thread)) return json({ error: 'invalid_request' }, 400);
    const query = new URLSearchParams({ root_id: thread });
    if (url.searchParams.has('batch') && !/^\d+$/.test(thread)) {
      query.set('page_size', String(integerParam(url.searchParams.get('batch'), 20, 1, 100)));
      const after = url.searchParams.get('after');
      if (after) {
        if (!MESSAGE_ID.test(after) || /^\d+$/.test(after)) return json({ error: 'invalid_cursor' }, 400);
        query.set('after_id', after);
      }
      const result = await requestPublicData(env, `rpc/public_forum_thread_page?${query}`);
      if (!result.exists) return json({ error: 'not_found' }, 404);
      if (!result.cursorValid) return json({ error: 'stale_cursor' }, 409);
      return json({ messages: result.messages.map(normalizeMessageZone), nextCursor: result.nextCursor });
    }
    // The RPC returns a JSON array to avoid PostgREST's global table row cap.
    const rows = await requestPublicData(env, `rpc/public_forum_thread?${query}`);
    if (!rows.length) return json({ error: 'not_found' }, 404);
    return json({ messages: rows.map(normalizeMessageZone) });
  }
  if (url.searchParams.get('overview') === '1') {
    return json({ messages: await requestPublicData(env, 'rpc/public_forum_overview') });
  }

  const page = integerParam(url.searchParams.get('page'), 0, 0, 100000);
  const limit = integerParam(url.searchParams.get('limit'), 20, 1, 50);
  const zone = url.searchParams.get('zone');
  const search = cleanText(url.searchParams.get('search'), 100);

  params.set('reply_to', 'is.null');
  const direction = url.searchParams.get('sort') === 'oldest' ? 'asc' : 'desc';
  if (!applyPage(params, url, page, limit, direction)) return json({ error: 'invalid_cursor' }, 400);
  if (zone === DAILY_ZONE || zone === LEGACY_DAILY_ZONE) {
    params.set('zone', `in.(${DAILY_ZONE},${LEGACY_DAILY_ZONE})`);
  } else if (ZONES.has(zone)) {
    params.set('zone', `eq.${zone}`);
  }
  if (search) params.set('content', `ilike.*${search.replace(/[,*()]/g, ' ')}*`);

  const rows = await requestPublicData(env, `approved_messages_public?${params}`);
  return json({ ...pageResult(rows.map(normalizeMessageZone), limit, 'messages'), page });
}

function validateImageUrls(env, values, userId) {
  if (!Array.isArray(values) || values.length > 5) return null;
  const base = new URL(String(env.BUSINESS_SUPABASE_URL));
  const prefix = `/storage/v1/object/public/message-pics/business/${userId}/`;
  const result = [];
  for (const value of values) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return null;
    result.push(url.toString());
  }
  return result;
}

async function createMessage(request, env, waitUntil) {
  const auth = await authenticateApi(request, env);
  if (auth.response) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_request' }, 400, auth.headers);
  }

  const content = cleanText(body.content, 1000);
  // The database normalizes the legacy value once the zone migration is applied.
  const zone = ZONES.has(body.zone) && body.zone !== DAILY_ZONE ? body.zone : LEGACY_DAILY_ZONE;
  const replyTo = body.replyTo == null ? null : String(body.replyTo);
  const imageUrls = validateImageUrls(env, body.imageUrls || [], auth.session.user_id);

  if (!content || (replyTo !== null && !MESSAGE_ID.test(replyTo)) || imageUrls === null) {
    return json({ error: 'invalid_request' }, 400, auth.headers);
  }

  let username = '匿名用户';
  if (body.anonymous !== true) {
    let profile;
    try {
      const rows = await requestBusinessData(
        env,
        auth.session,
        `business_users?user_id=eq.${encodeURIComponent(auth.session.user_id)}&select=nickname,display_name&limit=1`
      );
      profile = rows[0] || {};
    } catch {
      return json({ error: 'profile_unavailable' }, 503, auth.headers);
    }
    username = cleanText(
      resolveProfileNickname(
        auth.session.user_id, profile.nickname,
        profile.display_name || auth.session.display_name || auth.session.email?.split('@')[0] || '校园用户'
      ),
      80
    );
  }

  if (replyTo) {
    const target = await requestPublicData(
      env,
      `approved_messages_public?id=eq.${encodeURIComponent(replyTo)}&select=id&limit=1`
    );
    if (!target.length) return json({ error: 'reply_target_not_found' }, 404, auth.headers);
  }

  try {
    const rows = await requestBusinessData(env, auth.session, 'messages?select=id', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        business_user_id: auth.session.user_id,
        username,
        content,
        zone,
        pic_url: imageUrls.length ? imageUrls : null,
        contact_email: auth.session.email || null,
        flag: 0,
        reply_to: replyTo || null
      })
    });
    const messageId = rows[0].id;
    if (waitUntil && env.AUTH_STORE_SUPABASE_SECRET_KEY && !imageUrls.length) {
      waitUntil(processNextModeration(env, messageId).catch(() => {}));
    }
    return json({ ok: true, id: messageId }, 201, auth.headers);
  } catch {
    return json({ error: 'message_save_failed' }, 503, auth.headers);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    return await listMessages(request, env);
  } catch {
    return json({ error: 'messages_unavailable' }, 503);
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  return createMessage(request, env, waitUntil);
}

export function onRequest() {
  return methodNotAllowed('GET, POST');
}
