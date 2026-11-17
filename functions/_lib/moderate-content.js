import { loadLexicon, scanLexicon } from './lexicon.js';
import { resolveProviderChain } from './ai-providers.js';

const PROVIDER_DETAIL_MAX = 120;

/**
 * 合并多家供应商的判定。
 *
 * 判定顺序固定，谁先命中就听谁的：
 *
 *   1. 任一家 blocked        -> 拦截        （一票否决）
 *   2. 任一家 controversial  -> 转人工      （模型明确说擦边，不是故障）
 *   3. 任一家 safe           -> 放行        （一票放行，配几家都不会更容易进人工）
 *   4. 全部 error            -> 转人工      （upstream_unavailable）
 *
 * 关键区分：controversial 是**模型给的结论**，error 是**没拿到结论**。
 * 前者要转人工，后者只跳过。把两者混成一个 'uncertain' 会让「一家超时」
 * 等同于「全站转人工」，那配第二家反而是负收益。
 *
 * 审核不可用 != 站点不可用：即便全部供应商失败，留言仍然写入成功（flag=0），
 * 只是进人工队列，而不是发帖失败。
 */
export function mergeVerdicts(results) {
  const summary = results.map(r => ({
    id: r.id,
    verdict: r.verdict,
    reason: r.reason,
    ...(r.detail ? { detail: String(r.detail).slice(0, PROVIDER_DETAIL_MAX) } : {}),
    ...(r.error ? { error: String(r.error).slice(0, PROVIDER_DETAIL_MAX) } : {})
  }));

  const blocked = results.find(r => r.verdict === 'blocked');
  if (blocked) {
    return { verdict: 'blocked', reason: blocked.reason || 'model_unsafe', providers: summary };
  }

  const controversial = results.find(r => r.verdict === 'controversial');
  if (controversial) {
    return { verdict: 'uncertain', reason: controversial.reason || 'model_controversial', providers: summary };
  }

  if (results.some(r => r.verdict === 'safe')) {
    return { verdict: 'safe', reason: 'model_safe', providers: summary };
  }

  return { verdict: 'uncertain', reason: 'upstream_unavailable', providers: summary };
}

/**
 * 两级审核
 *   L1 本地词库：零网络开销，命中即阻断转人工（含图片的留言同样执行）
 *   L2 模型审核：并发调用所有已配置的供应商（默认 Qwen3Guard + GLM-4-Flash + NVIDIA NIM），
 *               再按 mergeVerdicts() 合并。任一家挂了不影响其余判定。
 *
 * 返回 { verdict, reason, hits?, providers? }
 *   verdict: 'safe' | 'blocked' | 'uncertain'
 *   reason : 'lexicon' | 'model_safe' | 'model_unsafe' | 'image' | ...
 * 仅 verdict === 'safe' 时放行，其余一律 flag=0 转人工。
 */
export async function runAiCheck(contentText, imageUrls, env) {
  // ---- L1 词库 ----
  const lex = await loadLexicon(env);

  // 🎯 核心补丁：Fail-Safe 拦截防线
  if (!lex) {
    console.error('[AI Check] 词库不可用，触发 Fail-Safe，强制转人工审核以阻断绕过！');
    return { verdict: 'uncertain', reason: 'lexicon_unavailable' };
  }

  const scan = scanLexicon(contentText, lex);
  if (scan.hit) {
    console.log(`[AI Check] 词库命中 ${scan.words.length} 条，转人工`);
    return { verdict: 'blocked', reason: 'lexicon', hits: scan.words };
  }

  // ---- L2 模型审核 ----
  // 有图片直接跳过API，转入人工
  if (imageUrls && imageUrls.length > 0) {
    console.log('[AI Check] 留言包含图片，跳过AI自动审核，转入人工');
    return { verdict: 'uncertain', reason: 'image' };
  }

  const chain = resolveProviderChain(env);
  if (!chain.length) {
    // 复用 missing_key：finish_forum_review 只对这个 reason 做重试（3 次后转人工），
    // 新增 reason 会绕过重试直接把任务消掉，反而不利。
    console.error('[AI Check] 没有任何可用的审核供应商（缺少 API key），转人工');
    return { verdict: 'uncertain', reason: 'missing_key' };
  }

  const text = String(contentText ?? '');
  console.log(`[AI Check] 并发调用 ${chain.map(p => p.id).join('+')}，文本长度 ${text.length}`);

  const results = await Promise.all(chain.map(async provider => {
    try {
      const outcome = await provider.review(text, env);
      console.log(`[AI Check] ${provider.id} -> ${outcome.verdict}/${outcome.reason}`);
      return { id: provider.id, ...outcome };
    } catch (error) {
      console.error(`[AI Check] ${provider.id} 调用失败：`, error?.message);
      return { id: provider.id, verdict: 'error', reason: 'provider_error', error: error?.message };
    }
  }));

  const merged = mergeVerdicts(results);
  console.log(`[AI Check] 合并判定 ${merged.verdict}/${merged.reason}`);
  return merged;
}
