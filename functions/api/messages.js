import { moderationQueueAvailable, processNextModeration } from '../_lib/moderation-worker.js';
import { runAiCheck } from '../_lib/moderate-content.js';
import { authenticateApi, cleanText, integerParam } from '../_lib/api.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { applyPage, pageResult } from '../_lib/pagination.js';
import { resolveProfileNickname } from '../_lib/official-profile.js';
import { identityUserId, isMissingRpc, requestBusinessData, requestPublicData } from '../_lib/supabase.js';

const LEGACY_DAILY_ZONE = '校园生活';
const DAILY_ZONE = '日常分享';
const ZONES = new Set([DAILY_ZONE, '学习互助', '活动社团', '失物招领']);
const MESSAGE_ID = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function normalizeMessageZone(message) {
  return message.zone === LEGACY_DAILY_ZONE ? { ...message, zone: DAILY_ZONE } : message;
}

function zoneFilter(zone) {
  if (zone === DAILY_ZONE || zone === LEGACY_DAILY_ZONE) return `in.(${DAILY_ZONE},${LEGACY_DAILY_ZONE})`;
  return ZONES.has(zone) ? `eq.${zone}` : null;
}

async function forumOverview(env) {
  try {
    return await requestPublicData(env, 'rpc/public_forum_overview');
  } catch (error) {
    if (!isMissingRpc(error)) throw error;
  }
  const groups = await Promise.all([...ZONES].map(zone => {
    const params = new URLSearchParams({
      select: 'id,username,content,zone,created_at', reply_to: 'is.null',
      zone: zoneFilter(zone), order: 'created_at.desc,id.desc', limit: '2'
    });
    return requestPublicData(env, `approved_messages_public?${params}`);
  }));
  return groups.flat().map(normalizeMessageZone);
}

function isMissingColumn(error) {
  return error?.status === 400 && ['42703', 'PGRST204'].includes(error.code);
}

async function focusedReply(env, thread, target) {
  const query = new URLSearchParams({ root_id: thread, target_id: target });
  if (!/^\d+$/.test(thread) && !/^\d+$/.test(target)) {
    try {
      const result = await requestPublicData(env, `rpc/public_forum_reply?${query}`);
      return { messages: result.messages.map(normalizeMessageZone), parentName: result.parentName };
    } catch (error) {
      if (!isMissingRpc(error)) throw error;
    }
  }
  // The legacy RPC already restricts results to visible descendants of this root.
  query.delete('target_id');
  const rows = await requestPublicData(env, `rpc/public_forum_thread?${query}`);
  const messages = rows.filter(row => [thread, target].includes(String(row.id))).map(normalizeMessageZone);
  const reply = messages.find(row => String(row.id) === target);
  const parent = reply && rows.find(row => String(row.id) === String(reply.reply_to));
  return { messages, parentName: parent?.username ?? null };
}

async function listMessages(request, env) {
  const url = new URL(request.url);
  const thread = url.searchParams.get('thread');
  const params = new URLSearchParams({
    select: 'id,username,content,zone,pic_url,created_at,reply_to,avatar_url,is_official'
  });

  if (thread) {
    if (!MESSAGE_ID.test(thread)) return json({ error: 'invalid_request' }, 400);
    if (url.searchParams.has('reply')) {
      const target = url.searchParams.get('reply');
      if (!MESSAGE_ID.test(target)) return json({ error: 'invalid_request' }, 400);
      const result = await focusedReply(env, thread.toLowerCase(), target.toLowerCase());
      return result.messages.length ? json(result) : json({ error: 'not_found' }, 404);
    }
    const root = new URLSearchParams({ root_id: thread });
    if (url.searchParams.has('batch') && !/^\d+$/.test(thread)) {
      const query = new URLSearchParams(root);
      query.set('page_size', String(integerParam(url.searchParams.get('batch'), 20, 1, 100)));
      const after = url.searchParams.get('after');
      if (after) {
        if (!MESSAGE_ID.test(after) || /^\d+$/.test(after)) return json({ error: 'invalid_cursor' }, 400);
        query.set('after_id', after);
      }
      try {
        const result = await requestPublicData(env, `rpc/public_forum_thread_page?${query}`);
        if (!result.exists) return json({ error: 'not_found' }, 404);
        if (!result.cursorValid) return json({ error: 'stale_cursor' }, 409);
        return json({ messages: result.messages.map(normalizeMessageZone), nextCursor: result.nextCursor });
      } catch (error) {
        if (!isMissingRpc(error)) throw error;
        // 分页 RPC 随 20261113 迁移上线；未迁移时退回旧接口，一次返回整栋楼
      }
    }
    // The RPC returns a JSON array to avoid PostgREST's global table row cap.
    const rows = await requestPublicData(env, `rpc/public_forum_thread?${root}`);
    if (!rows.length) return json({ error: 'not_found' }, 404);
    return json({ messages: rows.map(normalizeMessageZone) });
  }
  if (url.searchParams.get('overview') === '1') {
    return json({ messages: await forumOverview(env) });
  }

  const page = integerParam(url.searchParams.get('page'), 0, 0, 100000);
  const limit = integerParam(url.searchParams.get('limit'), 20, 1, 50);
  const zone = url.searchParams.get('zone');
  const search = cleanText(url.searchParams.get('search'), 100);

  params.set('reply_to', 'is.null');
  const direction = url.searchParams.get('sort') === 'oldest' ? 'asc' : 'desc';
  if (!applyPage(params, url, page, limit, direction)) return json({ error: 'invalid_cursor' }, 400);
  const filter = zoneFilter(zone);
  if (filter) params.set('zone', filter);
  if (search) params.set('content', `ilike.*${search.replace(/[,*()]/g, ' ')}*`);

  let rows;
  try {
    rows = await requestPublicData(env, `approved_messages_public?${params}`);
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    // 旧库缺少 is_official；未迁移时退回旧字段集，官方标识按 false 处理
    params.set('select', 'id,username,content,zone,pic_url,created_at,reply_to,avatar_url');
    try {
      rows = await requestPublicData(env, `approved_messages_public?${params}`);
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
      // 更早的头像迁移也未执行时去掉 avatar_url
      params.set('select', 'id,username,content,zone,pic_url,created_at,reply_to');
      rows = await requestPublicData(env, `approved_messages_public?${params}`);
    }
  }
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

  if (!body || typeof body !== 'object') return json({ error: 'invalid_request' }, 400, auth.headers);
  const submission = body.submissionId;
  if (submission !== undefined && (typeof submission !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(submission))) {
    return json({ error: 'invalid_submission_id' }, 400, auth.headers);
  }
  const content = cleanText(body.content, 1000);
  // The database normalizes the legacy value once the zone migration is applied.
  const zone = ZONES.has(body.zone) && body.zone !== DAILY_ZONE ? body.zone : LEGACY_DAILY_ZONE;
  const replyTo = body.replyTo == null ? null : String(body.replyTo);
  const imageUrls = validateImageUrls(env, body.imageUrls || [], auth.session.user_id);

  if (!content || (replyTo !== null && !MESSAGE_ID.test(replyTo)) || imageUrls === null) {
    return json({ error: 'invalid_request' }, 400, auth.headers);
  }

  // Both deployments derive the same primary key for a retry by the same account.
  const postId = submission ? await identityUserId('forum-post:' + auth.session.user_id, submission.toLowerCase()) : null;
  async function previousSubmission() {
    const params = new URLSearchParams({
      id: 'eq.' + postId, business_user_id: 'eq.' + auth.session.user_id,
      select: 'id,content,zone,reply_to,pic_url,username,flag', limit: '1'
    });
    const [saved] = await requestBusinessData(env, auth.session, 'messages?' + params);
    if (!saved) return null;
    const matches = saved.content === content && (saved.reply_to ?? null) === replyTo &&
      normalizeMessageZone(saved).zone === normalizeMessageZone({ zone }).zone &&
      (saved.username === '匿名用户') === (body.anonymous === true) &&
      JSON.stringify(saved.pic_url || []) === JSON.stringify(imageUrls);
    return matches ? json({ ok: true, id: postId, published: saved.flag === 1 }, 200, auth.headers)
      : json({ error: 'submission_changed' }, 409, auth.headers);
  }

  if (postId && body.retry === true) {
    try {
      const replay = await previousSubmission();
      if (replay) return replay;
    } catch { return json({ error: 'message_save_failed' }, 503, auth.headers); }
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

  const queued = await moderationQueueAvailable(env);
  let flag = 0;
  if (!queued) {
    // 20261113 迁移未执行时退回同步审核：只有模型明确通过才直接发布
    try {
      const review = await runAiCheck(content, imageUrls, env);
      if (review.verdict === 'safe' && review.reason === 'model_safe') flag = 1;
    } catch {
      flag = 0;
    }
  }

  try {
    const rows = await requestBusinessData(env, auth.session, 'messages?select=id', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        ...(postId ? { id: postId } : {}),
        business_user_id: auth.session.user_id,
        username,
        content,
        zone,
        pic_url: imageUrls.length ? imageUrls : null,
        contact_email: auth.session.email || null,
        flag,
        reply_to: replyTo || null
      })
    });
    const messageId = rows[0].id;
    if (queued && waitUntil && env.AUTH_STORE_SUPABASE_SECRET_KEY && !imageUrls.length) {
      waitUntil(processNextModeration(env, messageId).catch(() => {}));
    }
    return json({ ok: true, id: messageId, published: flag === 1 }, 201, auth.headers);
  } catch (error) {
    if (postId && error.code === '23505') {
      try {
        const replay = await previousSubmission();
        if (replay) return replay;
      } catch { /* The client can retry if the confirmation read is unavailable. */ }
    }
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
