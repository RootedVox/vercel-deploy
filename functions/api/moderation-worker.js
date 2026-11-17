import { cleanExpiredMedia, processModerationBatch } from '../_lib/moderation-worker.js';
import { json, methodNotAllowed } from '../_lib/http.js';
import { timingSafeEqual } from '../_lib/crypto.js';

export async function onRequestPost({ request, env }) {
  const expected = `Bearer ${env.FORUM_WORKER_SECRET}`;
  if (!env.FORUM_WORKER_SECRET || !timingSafeEqual(request.headers.get('Authorization') || '', expected)) {
    return json({ error: 'forbidden' }, 403);
  }
  try {
    // Cleanup runs after the review batch rather than alongside it: Cloudflare Workers
    // allows 6 simultaneous open connections per invocation, and each review now fans
    // out to every configured provider. Overlapping the two would queue past the deadline.
    const processed = await processModerationBatch(env);
    const cleaned = await cleanExpiredMedia(env);
    return json({ processed, cleaned });
  } catch { return json({ error: 'worker_unavailable' }, 503); }
}
export function onRequest() { return methodNotAllowed('POST'); }
