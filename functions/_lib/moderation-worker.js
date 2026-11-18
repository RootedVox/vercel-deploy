import { runAiCheck } from './moderate-content.js';
import { resolveProviderChain } from './ai-providers.js';
import { withDeadline } from './fetch-timeout.js';
import { isMissingRpc, serviceKeyHeaders } from './supabase.js';

async function serviceRequest(env, path, method, args, extraHeaders = {}) {
  const headers = serviceKeyHeaders(env, { 'Content-Type': 'application/json', ...extraHeaders });
  if (!headers) throw new Error('moderation_store_not_configured');
  return withDeadline(async signal => {
    const response = await fetch(`${env.BUSINESS_SUPABASE_URL.replace(/\/$/, '')}/${path}`, {
      method, headers, body: args === undefined ? undefined : JSON.stringify(args), signal
    });
    if (!response.ok) {
      const error = new Error('moderation_store_unavailable');
      error.status = response.status;
      if (response.status === 404) error.code = (await response.json().catch(() => null))?.code;
      throw error;
    }
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
// batch down to what the fanout allows. The same code runs on Vercel, which has no such
// limit; there the smaller batch only means fewer jobs per scheduled run.
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

// A human approval tells the author through the notification centre
// (moderate_business_message); the automatic one did not, although the compose form
// promises that the result is always sent. Same title, text and type as a human approval.
// Only ordinary text posts with an author are queued for AI review (enqueue_review), so
// the featured wording never applies here.
export const AI_APPROVAL_NOTICE = { title: '留言审核通过', content: '你的留言、评论或回复已审核通过并公开显示', type: 'audit' };

// Any verdict short of a rejection leaves the post at flag=0, waiting for a human: a
// split unsafe call, an off-topic borderline call, a lexicon hit, or no verdict at all.
// To the author these are the same situation, so they get one amber "a human is looking
// at it" notice rather than a rejection. The wording must not imply the post was refused
// — it is still in the queue.
export const AI_MANUAL_NOTICE = { title: '留言转为人工审核', content: '你的留言已由 AI 初审，正在人工复核，通过后会公开显示', type: 'audit' };

// Unanimous unsafe. The post becomes flag=2, the same terminal state as a human
// rejection, so it needs the same notice — otherwise the author only sees the post
// vanish. The reason is deliberately generic (the category names are internal) and
// points at the appeal path, since this decision was made without a person reading it.
export const AI_REJECT_NOTICE = { title: '留言未通过审核', content: '拒绝原因：内容安全模型一致判定为不适宜公开发布。如认为误判，可联系管理员复核', type: 'audit' };

async function loadAuthor(env, id) {
  const rows = await serviceRequest(env,
    `rest/v1/messages?id=eq.${encodeURIComponent(id)}&select=business_user_id,flag&limit=1`, 'GET');
  return rows?.[0] ?? null;
}

async function pushNotice(env, id, userId, notice) {
  await serviceRequest(env, 'rest/v1/business_notifications', 'POST', {
    user_id: userId, ...notice, related_id: id
  }, { Prefer: 'return=minimal' });
  return true;
}

async function notifyApproved(env, id) {
  const row = await loadAuthor(env, id);
  // Only tell the author it is public when it really is.
  if (!row?.business_user_id || row.flag !== 1) return false;
  return pushNotice(env, id, row.business_user_id, AI_APPROVAL_NOTICE);
}

async function notifyManual(env, id) {
  const row = await loadAuthor(env, id);
  // Still pending. If a human already settled it (flag 1) or it was deleted, stay quiet so
  // the author never gets "a human is reviewing this" after the review is over.
  if (!row?.business_user_id || row.flag !== 0) return false;
  return pushNotice(env, id, row.business_user_id, AI_MANUAL_NOTICE);
}

async function notifyRejected(env, id) {
  const row = await loadAuthor(env, id);
  if (!row?.business_user_id) return false;
  if (row.flag === 2) return pushNotice(env, id, row.business_user_id, AI_REJECT_NOTICE);
  // flag=0 means the migration that teaches finish_forum_review about flag=2 has not run
  // yet. The verdict is still unanimous-unsafe, but the post is in fact sitting in the
  // human queue, so say that instead of claiming a refusal that did not happen.
  if (row.flag === 0) return pushNotice(env, id, row.business_user_id, AI_MANUAL_NOTICE);
  // flag=1: a human restored it (or approved while the AI was thinking). Stay quiet.
  return false;
}

export async function processNextModeration(env, id = null) {
  const job = await call(env, 'claim_forum_review', { target: id });
  if (!job) return false;
  // The image argument is always empty because enqueue_review only queues posts whose
  // pic_url is empty; posts with images and featured submissions never reach this worker.
  const result = await runAiCheck(job.content, [], env);
  if (result.reason === 'lexicon') {
    try {
      // Finish the lease and insert the author's notice in one database transaction.
      await call(env, 'finish_forum_lexicon_review', { target: job.id, lease: job.lease });
      return true;
    } catch (error) {
      if (!isMissingRpc(error)) throw error;
      // During rollout an older database still uses the existing manual notice path.
    }
  }
  // true once the job is settled; false when the database schedules a retry instead.
  const finished = await call(env, 'finish_forum_review', {
    target: job.id, lease: job.lease, decision: result.verdict, reason: result.reason
  });
  if (finished === true) {
    const notify = result.verdict === 'safe' && result.reason === 'model_safe' ? notifyApproved
      : result.verdict === 'blocked' && result.reason === 'model_unsafe' ? notifyRejected
      : notifyManual;
    // The review outcome is already stored; a failed notice must not undo or repeat it.
    try { await notify(env, job.id); }
    catch (error) {
      console.error('[AI Check] 审核结果通知发送失败：', error?.message);
    }
  }
  return true;
}
