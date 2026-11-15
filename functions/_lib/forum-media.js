import { json, SECURITY_HEADERS } from './http.js';
import { withDeadline } from './fetch-timeout.js';

export function publicMessageMedia(row) {
  if (row.username !== '匿名用户' || !Array.isArray(row.pic_url)) return row;
  return { ...row, pic_url: row.pic_url.map((_, index) => `/api/messages?media=${row.id}&slot=${index}`) };
}

// Keep original object names inside the backend. A post can be withdrawn, so
// recheck its moderation state on each read and do not cache the response.
export async function readAnonymousImage(env, id, slot) {
  if (!/^(?:0|[1-9]\d{0,3})$/.test(slot ?? '')) return json({ error: 'invalid_request' }, 400);
  const database = new URL(env.BUSINESS_SUPABASE_URL);
  if (database.protocol !== 'https:') return json({ error: 'media_unavailable' }, 503);
  const origin = database.origin;
  const key = env.AUTH_STORE_SUPABASE_SECRET_KEY;
  if (!key) return json({ error: 'media_unavailable' }, 503);
  const headers = { apikey: key };
  if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
  const select = new URLSearchParams({ id: 'eq.' + id, username: 'eq.匿名用户', flag: 'eq.1', select: 'pic_url', limit: '1' });
  const rows = await withDeadline(async signal => {
    const res = await fetch(origin + '/rest/v1/messages?' + select, { headers, signal, redirect: 'error' });
    if (!res.ok) throw new Error('media_lookup_failed');
    return res.json();
  });
  const images = rows[0]?.pic_url;
  const value = Array.isArray(images) ? images[Number(slot)] : null;
  if (typeof value !== 'string' || !URL.canParse(value)) return json({ error: 'not_found' }, 404);
  const source = new URL(value);
  if (source.protocol !== 'https:' || source.origin !== origin || source.username || source.password ||
      !source.pathname.startsWith('/storage/v1/object/public/message-pics/')) return json({ error: 'not_found' }, 404);
  // Forward only image bytes. Neither redirects nor Storage headers are public.
  const file = await fetch(origin + source.pathname, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  const type = file.headers.get('Content-Type')?.split(';')[0].toLowerCase();
  if (!file.ok || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) {
    await file.body?.cancel();
    return json({ error: 'image_unavailable' }, file.status >= 500 ? 503 : 404);
  }
  return new Response(file.body, { headers: { ...SECURITY_HEADERS, 'Content-Type': type,
    'Content-Security-Policy': "sandbox; default-src 'none'" } });
}
