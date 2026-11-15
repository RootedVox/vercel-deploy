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

// 迁移未执行时，审核队列不存在。只缓存可用状态，迁移上线后下一次请求即生效。
let queueReadyAt = 0;
export async function moderationQueueAvailable(env) {
  if (Date.now() - queueReadyAt < 60_000) return true;
  if (!env.AUTH_STORE_SUPABASE_SECRET_KEY) return false;
  try {
    await call(env, 'claim_forum_review', { target: crypto.randomUUID() });
    queueReadyAt = Date.now();
    return true;
  } catch {
    return false;
  }
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
