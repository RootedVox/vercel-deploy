import { publicMessageMedia, readAnonymousImage } from '../_lib/forum-media.js';
import { processNextModeration } from '../_lib/moderation-worker.js';
import { authenticateApi, cleanText, integerParam } from '../_lib/api.js';
import { json, methodNotAllowed, SECURITY_HEADERS } from '../_lib/http.js';
import { applyPage, pageResult } from '../_lib/pagination.js';
import { profileNickname } from '../_lib/official-profile.js';
import { identityUserId, isMissingRpc, readOwnProfile, requestBusinessData, requestPublicData } from '../_lib/supabase.js';

const LEGACY_DAILY_ZONE = '校园生活';
const DAILY_ZONE = '日常分享';
const ZONES = new Set([DAILY_ZONE, '学习互助', '活动社团', '失物招领']);
const MESSAGE_ID = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function normalizeMessageZone(message) {
  return message.zone === LEGACY_DAILY_ZONE ? { ...message, zone: DAILY_ZONE } : message;
}

function publicMessage(row) {
  return publicMessageMedia(normalizeMessageZone(row));
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
  return groups.flat().map(publicMessage);
}

// Indexed paging (20261115_forum_feed_paging.sql). Returns null when the database has
// not been migrated or still uses numeric IDs, so the caller falls back to the view.
async function forumFeed(env, url, { page, limit, zone, search, ascending }) {
  const args = { p_ascending: ascending, p_page_size: limit + 1, p_skip: page * limit };
  const cursor = url.searchParams.get('cursor');
  if (cursor) {
    const [time, id] = cursor.split('|');
    if (/^\d+$/.test(id)) return null;
    Object.assign(args, { p_after_time: time, p_after_id: id.toLowerCase(), p_skip: 0 });
  }
  if (zone === DAILY_ZONE || zone === LEGACY_DAILY_ZONE) args.p_zones = [DAILY_ZONE, LEGACY_DAILY_ZONE];
  else if (ZONES.has(zone)) args.p_zones = [zone];
  if (search) args.p_search = search;
  try {
    return await requestPublicData(env, 'rpc/public_forum_feed', { method: 'POST', body: JSON.stringify(args) });
  } catch (error) {
    if (isMissingRpc(error)) return null;
    throw error;
  }
}

function isMissingColumn(error) {
  return error?.status === 400 && ['42703', 'PGRST204'].includes(error.code);
}

async function focusedReply(env, thread, target) {
  const query = new URLSearchParams({ root_id: thread, target_id: target });
  if (!/^\d+$/.test(thread) && !/^\d+$/.test(target)) {
    try {
      const result = await requestPublicData(env, `rpc/public_forum_reply?${query}`);
      return { messages: result.messages.map(publicMessage), parentName: result.parentName };
    } catch (error) {
      if (!isMissingRpc(error)) throw error;
    }
  }
  // The legacy RPC already restricts results to visible descendants of this root.
  query.delete('target_id');
  const rows = await requestPublicData(env, `rpc/public_forum_thread?${query}`);
  const messages = rows.filter(row => [thread, target].includes(String(row.id))).map(publicMessage);
  const reply = messages.find(row => String(row.id) === target);
  const parent = reply && rows.find(row => String(row.id) === String(reply.reply_to));
  return { messages, parentName: parent?.username ?? null };
}

// "💬 N 条评论" in the feed (20261116_forum_reply_counts.sql). Counting is optional:
// before the migration, or if the read fails, posts go out without reply_count and the
// page shows the link without a number. It is one more database read in the same
// Functions request, never an extra request from the browser.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let replyCountsMissingUntil = 0;
async function withReplyCounts(env, page) {
  const ids = page.messages.map(message => String(message.id)).filter(id => UUID.test(id));
  if (!ids.length || Date.now() < replyCountsMissingUntil) return page;
  try {
    const rows = await requestPublicData(env, 'rpc/public_forum_reply_counts', {
      method: 'POST', body: JSON.stringify({ p_ids: ids })
    }, 800);
    const counts = new Map(rows.map(row => [String(row.id), Number(row.replies) || 0]));
    return { ...page, messages: page.messages.map(message => counts.has(String(message.id))
      ? { ...message, reply_count: counts.get(String(message.id)) } : message) };
  } catch (error) {
    // Not migrated yet: stop asking for a while instead of on every feed load.
    if (isMissingRpc(error)) replyCountsMissingUntil = Date.now() + 10 * 60_000;
    return page;
  }
}

async function featuredFirstFeed(env, url, params, limit, publicColumns, direction) {
  const rawCursor = url.searchParams.get('cursor');
  const section = rawCursor?.slice(0, 2);
  if (rawCursor && !['f:', 'n:'].includes(section)) return json({ error: 'invalid_cursor' }, 400);
  const cursorUrl = new URL(url);
  if (rawCursor) cursorUrl.searchParams.set('cursor', rawCursor.slice(2));
  const query = new URLSearchParams(params);
  if (!applyPage(query, cursorUrl, 0, limit, direction)) return json({ error: 'invalid_cursor' }, 400);
  const fields = publicColumns + ',avatar_url,is_official,is_featured';
  query.set('select', fields + ',is_developer');
  async function readGroup(featured) {
    query.set('is_featured', featured ? 'eq.true' : 'eq.false');
    try {
      return await requestPublicData(env, 'approved_messages_public?' + query);
    } catch (error) {
      if (!isMissingColumn(error) || query.get('select') === fields) throw error;
      query.set('select', fields);
      return requestPublicData(env, 'approved_messages_public?' + query);
    }
  }

  let rows = [];
  if (section !== 'n:') {
    rows = await readGroup(true);
    if (rows.length <= limit) {
      query.delete('or');
      query.delete('offset');
    }
  }
  if (rows.length <= limit) {
    query.set('limit', String(limit + 1 - rows.length));
    rows.push(...await readGroup(false));
  }
  const result = pageResult(rows.map(publicMessage), limit, 'messages');
  if (result.nextCursor) result.nextCursor = (result.messages.at(-1).is_featured ? 'f:' : 'n:') + result.nextCursor;
  return json(await withReplyCounts(env, result));
}

async function listMessages(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.has('media')) {
    const id = url.searchParams.get('media');
    if (!MESSAGE_ID.test(id)) return json({ error: 'invalid_request' }, 400);
    return readAnonymousImage(env, id, url.searchParams.get('slot'));
  }
  if (url.searchParams.get('featuredQuota') === '1') {
    const auth = await authenticateApi(request, env);
    if (auth.response) return auth.response;
    const remaining = await requestBusinessData(env, auth.session, 'rpc/forum_featured_remaining', {
      method: 'POST', body: '{}'
    });
    return json({ remaining }, 200, auth.headers);
  }
  const thread = url.searchParams.get('thread');
  const publicColumns = 'id,username,content,zone,pic_url,created_at,reply_to';
  const params = new URLSearchParams();

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
        return json({ messages: result.messages.map(publicMessage), nextCursor: result.nextCursor });
      } catch (error) {
        if (!isMissingRpc(error)) throw error;
        // 分页 RPC 随 20261113 迁移上线；未迁移时退回旧接口，一次返回整栋楼
      }
    }
    // The RPC returns a JSON array to avoid PostgREST's global table row cap.
    const rows = await requestPublicData(env, `rpc/public_forum_thread?${root}`);
    if (!rows.length) return json({ error: 'not_found' }, 404);
    return json({ messages: rows.map(publicMessage) });
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
  const filter = zoneFilter(zone);
  if (filter) params.set('zone', filter);
  if (search) params.set('content', `ilike.*${search.replace(/[,*()]/g, ' ')}*`);
  if (url.searchParams.get('featuredFirst') === '1') {
    return featuredFirstFeed(env, url, params, limit, publicColumns, direction);
  }
  if (!applyPage(params, url, page, limit, direction)) return json({ error: 'invalid_cursor' }, 400);
  const feed = await forumFeed(env, url, { page, limit, zone, search, ascending: direction === 'asc' });
  if (feed) return json({ ...await withReplyCounts(env, pageResult(feed.map(publicMessage), limit, 'messages')), page });
  // Keep older database schemas readable and default absent badges to false.
  for (const suffix of [',avatar_url,is_official,is_developer,is_featured', ',avatar_url,is_official,is_developer', ',avatar_url,is_official', ',avatar_url', '']) {
    params.set('select', publicColumns + suffix);
    try {
      const rows = await requestPublicData(env, `approved_messages_public?${params}`);
      return json({ ...await withReplyCounts(env, pageResult(rows.map(publicMessage), limit, 'messages')), page });
    } catch (error) {
      if (!suffix || !isMissingColumn(error)) throw error;
      if (suffix.endsWith(',is_featured') && error.reason?.includes('is_developer')) {
        params.set('select', publicColumns + ',avatar_url,is_official,is_featured');
        try {
          const rows = await requestPublicData(env, 'approved_messages_public?' + params);
          return json({ ...await withReplyCounts(env, pageResult(rows.map(publicMessage), limit, 'messages')), page });
        } catch (fallbackError) {
          if (!isMissingColumn(fallbackError)) throw fallbackError;
        }
      }
    }
  }
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
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (content.length > 1000) return json({ error: 'content_too_long' }, 400, auth.headers);
  // The database normalizes the legacy value once the zone migration is applied.
  const zone = ZONES.has(body.zone) && body.zone !== DAILY_ZONE ? body.zone : LEGACY_DAILY_ZONE;
  const replyTo = body.replyTo == null ? null : String(body.replyTo);
  const featured = body.featured === true;
  if (featured && replyTo !== null) return json({ error: 'featured_root_only' }, 400, auth.headers);
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

  // These reads do not depend on each other, so they share one round trip to the
  // database. Their results are still checked in the original order.
  const failed = Symbol('failed');
  const [profile, target] = await Promise.all([
    body.anonymous === true ? null
      : readOwnProfile(env, auth.session, 'nickname,display_name').then(row => row || {}, () => failed),
    replyTo ? requestPublicData(
      env,
      `approved_messages_public?id=eq.${encodeURIComponent(replyTo)}&select=id&limit=1`
    ).catch(() => failed) : null
  ]);

  let username = '匿名用户';
  if (profile) {
    if (profile === failed) return json({ error: 'profile_unavailable' }, 503, auth.headers);
    username = cleanText(profileNickname(auth.session, profile), 80);
  }

  if (target) {
    // Nothing was written yet, so the client can simply retry.
    if (target === failed) return json({ error: 'message_save_failed' }, 503, auth.headers);
    if (!target.length) return json({ error: 'reply_target_not_found' }, 404, auth.headers);
  }

  // 公开发布权只属于云端审核流程：本站写入永远停在 flag=0。
  // 此前“队列不可用时同步跑 AI 并写 flag=1”的降级分支已移除——它试图绕过
  // messages_insert_self_pending 的 RLS（只允许 flag=0），且会给登录用户
  // 留下自我放行的路径。迁移未执行时新留言留在待审核队列，由人工/定时任务处理。
  const flag = 0;

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
        ...(featured ? { is_featured: true } : {}),
        reply_to: replyTo || null
      })
    });
    const messageId = rows[0].id;
    // Text-only posts are reviewed right after the response. No probe for the review
    // queue comes first: where it is missing the claim fails and the post simply waits
    // for the scheduled worker or a human, exactly as before.
    if (!featured && waitUntil && env.AUTH_STORE_SUPABASE_SECRET_KEY && !imageUrls.length) {
      waitUntil(processNextModeration(env, messageId).catch(() => {}));
    }
    return json({ ok: true, id: messageId, published: flag === 1 }, 201, auth.headers);
  } catch (error) {
    if (error.code === 'P0001' && error.reason === 'featured_daily_limit') {
      return json({ error: 'featured_daily_limit' }, 429, auth.headers);
    }
    if (postId && error.code === '23505') {
      try {
        const replay = await previousSubmission();
        if (replay) return replay;
      } catch { /* The client can retry if the confirmation read is unavailable. */ }
    }
    return json({ error: 'message_save_failed' }, 503, auth.headers);
  }
}

// The homepage overview and the first page of each feed view are the same for every
// visitor, so a warm instance answers repeats from memory for a few seconds instead of
// asking the database again; concurrent requests share one read. Only these public
// parameters qualify: threads, search, later pages, images and anything tied to an
// account are always read fresh. Posts appear only after moderation, so a few seconds
// of delay changes nothing a visitor can notice.
const PUBLIC_PARAMS = new Set(['overview', 'zone', 'sort', 'limit', 'featuredFirst', 'page']);
const recentReads = new Map();
export function clearPublicReadCache() { recentReads.clear(); }

function publicReadKey(url) {
  const params = new URLSearchParams(url.searchParams);
  for (const name of params.keys()) if (!PUBLIC_PARAMS.has(name)) return null;
  if ((params.get('page') ?? '0') !== '0') return null;
  params.sort();
  return params.toString();
}

async function cachedPublicRead(request, env) {
  const url = new URL(request.url);
  const key = publicReadKey(url);
  if (key === null) return listMessages(request, env);
  const now = Date.now();
  let entry = recentReads.get(key);
  if (!entry || entry.until <= now) {
    for (const [name, old] of recentReads) if (old.until <= now) recentReads.delete(name);
    if (recentReads.size >= 100) recentReads.clear();
    const body = listMessages(request, env).then(async response => {
      if (response.status !== 200) throw response;
      return response.text();
    });
    entry = { body, until: now + (url.searchParams.has('overview') ? 30_000 : 15_000) };
    recentReads.set(key, entry);
    // Failures are never kept: the next visitor asks the database again.
    body.catch(() => { if (recentReads.get(key) === entry) recentReads.delete(key); });
  }
  try {
    return new Response(await entry.body, {
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json;charset=utf-8' }
    });
  } catch (failure) {
    if (failure instanceof Response) return failure.clone();
    throw failure;
  }
}

export async function onRequestGet({ request, env }) {
  try {
    return await cachedPublicRead(request, env);
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
