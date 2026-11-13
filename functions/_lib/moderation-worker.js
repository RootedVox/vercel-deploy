import { runAiCheck } from './moderate-content.js';
import { withDeadline } from './fetch-timeout.js';

async function serviceRequest(env, path, method, args) {
  const key = env.AUTH_STORE_SUPABASE_SECRET_KEY;
  if (!key) throw new Error('moderation_store_not_configured');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
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

export async function processNextModeration(env, id = null) {
  const job = await call(env, 'claim_forum_review', { target: id });
  if (!job) return false;
  const result = await runAiCheck(job.content, [], env);
  await call(env, 'finish_forum_review', {
    target: job.id, lease: job.lease, decision: result.verdict, reason: result.reason
  });
  return true;
}
