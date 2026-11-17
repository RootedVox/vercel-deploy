import { cleanExpiredMedia, processModerationBatch } from '../_lib/moderation-worker.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { timingSafeEqual } from '../_lib/crypto.js';

export async function onRequestPost({ request, env }) {
  const expected = `Bearer ${env.FORUM_WORKER_SECRET}`;
  if (!env.FORUM_WORKER_SECRET || !timingSafeEqual(request.headers.get('Authorization') || '', expected)) {
    return json({ error: 'forbidden' }, 403);
  }
  try {
    const [processed, cleaned] = await Promise.all([processModerationBatch(env), cleanExpiredMedia(env)]);
    return json({ processed, cleaned });
  } catch { return json({ error: 'worker_unavailable' }, 503); }
}
export function onRequest() { return methodNotAllowed('POST'); }
