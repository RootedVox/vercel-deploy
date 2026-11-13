import { applyPage, pageResult } from '../_lib/pagination.js';
import { authenticateApi, integerParam } from '../_lib/api.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { requestBusinessData } from '../_lib/supabase.js';

export async function onRequestGet({ request, env }) {
  const auth = await authenticateApi(request, env);
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const page = integerParam(url.searchParams.get('page'), 0, 0, 10000);
  const limit = integerParam(url.searchParams.get('limit'), 10, 1, 50);
  const unreadOnly = url.searchParams.get('unread') === '1';
  const params = new URLSearchParams({
    user_id: `eq.${auth.session.user_id}`,
    select: 'id,title,content,type,related_id,read,created_at'
  });
  if (!applyPage(params, url, page, limit)) return json({ error: 'invalid_cursor' }, 400, auth.headers);
  if (url.searchParams.get('exists') === '1') {
    params.set('select', 'id');
    params.set('limit', '1');
    params.set('read', 'eq.false');
    try {
      const rows = await requestBusinessData(env, auth.session, `business_notifications?${params}`);
      return json({ hasUnread: rows.length > 0 }, 200, auth.headers);
    } catch { return json({ error: 'notifications_unavailable' }, 503, auth.headers); }
  }
  if (unreadOnly) params.set('read', 'eq.false');
  try {
    const rows = await requestBusinessData(env, auth.session, `business_notifications?${params}`);
    return json(pageResult(rows, limit, 'notifications'), 200, auth.headers);
  } catch { return json({ error: 'notifications_unavailable' }, 503, auth.headers); }
}

export async function onRequestPatch({ request, env }) {
  const auth = await authenticateApi(request, env);
  if (auth.response) return auth.response;
  try {
    const through = new URL(request.url).searchParams.get('through');
    if (through !== null && !/^\d{1,19}$/.test(through)) return json({ error: 'invalid_request' }, 400, auth.headers);
    const hasUnread = await requestBusinessData(env, auth.session, 'rpc/read_forum_notifications', {
      method: 'POST', body: JSON.stringify({ through_id: through })
    });
    return json({ ok: true, hasUnread }, 200, auth.headers);
  } catch { return json({ error: 'notifications_update_failed' }, 503, auth.headers); }
}

export function onRequest() {
  return methodNotAllowed('GET, PATCH');
}
