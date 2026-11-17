import { runAiCheck } from './moderate-content.js';
import { resolveProviderChain } from './ai-providers.js';
import { withDeadline } from './fetch-timeout.js';
import { serviceKeyHeaders } from './supabase.js';

async function serviceRequest(env, path, method, args) {
  const headers = serviceKeyHeaders(env, { 'Content-Type': 'application/json' });
  if (!headers) throw new Error('moderation_store_not_configured');
  return withDeadline(async signal => {
    const response = await fetch(`${env.BUSINESS_SUPABASE_URL.replace(/\/$/, '')}/${path}`, {
      method, headers, body: JSON.stringify(args), signal
    });
    if (!response.ok) throw new Error('moderation_store_unavailable');
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  });
}

function call(env, name, args) {
  return serviceRequest(env, 'rest/v1/rpc/' + name, 'POST', args);
}

export async function cleanExpiredMedia(env) {
  const rows = await call(env, 'claim_forum_media_cleanup', {});
  const names = rows.map(row => row.object_name);
  if (!names.length) return 0;
  await serviceRequest(env, 'storage/v1/object/message-pics', 'DELETE', { prefixes: names });
  await call(env, 'finish_forum_media_cleanup', { names });
  return names.length;
}

// One scheduled run. The first claim tells whether anything is waiting; only then are
// more claimed, so an idle queue costs one database call instead of four.
//
// Batch size is bounded by the runtime connection limit: Cloudflare Workers allows 6
// simultaneous open connections per invocation, and each review now fans out to every
// configured provider. 4 jobs x 3 providers would queue past the deadline, so scale the
// batch down to what the fanout allows. Vercel has no such limit and keeps `size`.
export function moderationBatchSize(env, size = 4) {
  const fanout = Math.max(1, resolveProviderChain(env).length);
  return Math.max(1, Math.min(size, Math.floor(6 / fanout)));
}

export async function processModerationBatch(env, size = 4) {
  const batch = moderationBatchSize(env, size);
  if (!await processNextModeration(env)) return 0;
  const rest = await Promise.all(Array.from({ length: batch - 1 }, () => processNextModeration(env)));
  return 1 + rest.filter(Boolean).length;
}

export async function processNextModeration(env, id = null) {
  const job = await call(env, 'claim_forum_review', { target: id });
  if (!job) return false;
  const result = await runAiCheck(job.content, [], env);
  await call(env, 'finish_forum_review', {
    target: job.id, lease: job.lease, decision: result.verdict, reason: result.reason
  });
  return true;
}
