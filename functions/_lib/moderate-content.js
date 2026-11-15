import { loadLexicon, scanLexicon } from './lexicon.js';

const NVAPI_MODEL = 'nvidia/nemotron-3.5-content-safety';
const NVAPI_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVAPI_TIMEOUT_MS = 15000;
const NVAPI_MAX_ATTEMPTS = 2;

/**
 * 解析 NIM 输出。只认最后一次出现的判定，避免推理文本里的字样干扰。
 */
function verdictFromText(outText) {
  if (!outText) return { verdict: 'uncertain', reason: 'empty_output' };
  const matches = [...outText.matchAll(/user safety:\s*(safe|unsafe)/gi)];
  const last = matches.length ? matches[matches.length - 1][1].toLowerCase() : '';
  if (last === 'safe') return { verdict: 'safe', reason: 'model_safe' };
  if (last === 'unsafe') return { verdict: 'blocked', reason: 'model_unsafe' };
  return { verdict: 'uncertain', reason: 'unparsed_output' };
}

/**
 * 两级审核
 *   L1 本地词库：零网络开销，命中即阻断转人工（含图片的留言同样执行）
 *   L2 NVIDIA nemotron-3.5-content-safety：仅纯文本，明确输出 safe 才通过
 *
 * 返回 { verdict, reason, hits }
 *   verdict: 'safe' | 'blocked' | 'uncertain' | 'timeout' | 'error'
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

  // ---- L2 NIM ----
  // 有图片直接跳过API，转入人工
  if (imageUrls && imageUrls.length > 0) {
    console.log('[AI Check] 留言包含图片，跳过AI自动审核，转入人工');
    return { verdict: 'uncertain', reason: 'image' };
  }

  const nvApiKey = env.NVAPI_KEY;
  if (!nvApiKey) {
    console.error('[AI Check] NVAPI_KEY 环境变量缺失');
    return { verdict: 'error', reason: 'missing_key' };
  }

  const payload = {
    model: NVAPI_MODEL,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: contentText }]
      }
    ],
    max_tokens: 100,
    temperature: 0.01,
    top_p: 0.95,
    chat_template_kwargs: {
      request_categories: '/no_categories',
      enable_thinking: false
    }
  };

  const headers = {
    Authorization: `Bearer ${nvApiKey}`,
    'Content-Type': 'application/json'
  };

  console.log(`[AI Check] 请求 NIM，文本长度 ${contentText.length}`);

  for (let attempt = 1; attempt <= NVAPI_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NVAPI_TIMEOUT_MS);
    let retryable = false;

    try {
      const resp = await fetch(NVAPI_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (resp.ok) {
        const apiResult = await resp.json();
        const outText = apiResult.choices?.[0]?.message?.content?.trim() ?? '';
        console.log(`[AI Check] 判定结果: ${outText.replace(/\s+/g, ' ').slice(0, 200)}`);
        return verdictFromText(outText);
      }

      const errText = await resp.text().catch(() => '');
      if (resp.status === 429 || resp.status >= 500) {
        console.error(`[AI Check] 可重试状态 ${resp.status}：`, errText.slice(0, 300));
        retryable = true;
      } else {
        console.error(`[AI Check] 非重试错误 ${resp.status}：`, errText.slice(0, 300));
        return { verdict: 'error', reason: `http_${resp.status}` };
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        console.error(`[AI Check] 请求超时 > ${NVAPI_TIMEOUT_MS}ms`);
      } else {
        console.error('[AI Check] 请求异常：', e?.message);
      }
      retryable = true;
    } finally {
      clearTimeout(timeoutId);
      controller.abort();
    }

    if (retryable && attempt < NVAPI_MAX_ATTEMPTS) {
      const backoff = 500 * attempt;
      console.log(`[AI Check] ${backoff}ms 后重试（第 ${attempt + 1} 次）`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    return { verdict: 'uncertain', reason: 'upstream_unavailable' };
  }

  return { verdict: 'uncertain', reason: 'upstream_unavailable' };
}
