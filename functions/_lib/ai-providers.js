/**
 * L2 内容审核的供应商注册表。
 *
 * 设计要点
 * - 每家只暴露 { id, label, isConfigured(env), review(text, env) }，新增一家只需改这个文件。
 * - review() 契约：返回 { verdict, reason, detail? }
 *     verdict: 'safe' | 'blocked' | 'uncertain'
 *     抛错表示这家不可用，由调用方按 Fail-Safe 处理，绝不当成放行。
 * - 三家都是 OpenAI 兼容的 chat/completions，差别只在请求体和输出解析。
 * - 免费额度、注册地址见 docs/AI_REVIEW_PROVIDERS.zh-CN.md。
 *
 * 为什么要多供应商：单家挂掉时审核链路不能整体瘫痪。判定合并策略见
 * moderate-content.js 的 mergeVerdicts()——任一 blocked 即拦截，其余情况只要
 * 有任一家明确 safe 就放行，全部不可用才转人工。
 */

import { withDeadline } from './fetch-timeout.js';

const DEFAULT_TIMEOUT_MS = 8000;
const ERR_DETAIL_MAX = 200;

function timeoutMs(env) {
  const value = Number(env?.AI_REVIEW_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_TIMEOUT_MS;
}

function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 统一的 OpenAI 兼容调用。响应体读取也算在 deadline 内，避免上游给了响应头
 * 却一直不吐 body 把 Worker 挂住。
 */
async function chatCompletion({ url, key, body, timeout }) {
  return withDeadline(async signal => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`http_${response.status}:${raw.slice(0, ERR_DETAIL_MAX)}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('invalid_json_response');
    }
    return String(data?.choices?.[0]?.message?.content ?? '');
  }, timeout);
}

/**
 * Qwen3Guard-Gen 输出固定两行：
 *   Safety: Safe | Unsafe | Controversial
 *   Categories: Violent / None / ...
 * 取最后一次匹配，避免模型把输入原文回显时干扰判定。
 */
export function parseQwenGuard(content) {
  const matches = [...String(content || '').matchAll(/Safety:\s*(Safe|Unsafe|Controversial)/gi)];
  if (!matches.length) return { verdict: 'uncertain', reason: 'unparsed_output' };
  const label = matches[matches.length - 1][1].toLowerCase();
  const categories = (/Categories:\s*([^\n]*)/i.exec(String(content || ''))?.[1] || '').trim();
  if (label === 'safe') return { verdict: 'safe', reason: 'model_safe', detail: categories };
  if (label === 'unsafe') return { verdict: 'blocked', reason: 'model_unsafe', detail: categories };
  return { verdict: 'uncertain', reason: 'model_controversial', detail: categories };
}

/**
 * GLM 是通用模型，靠 prompt + JSON 输出约束。解析容错：允许模型在 JSON 前后
 * 夹带说明文字，取第一个 { 到最后一个 }。
 */
export function parseGlmVerdict(content) {
  const raw = String(content || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { verdict: 'uncertain', reason: 'unparsed_output' };
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { verdict: 'uncertain', reason: 'unparsed_output' };
  }
  const label = String(parsed?.verdict || '').trim().toLowerCase();
  const categories = Array.isArray(parsed?.categories) ? parsed.categories.join(',') : '';
  if (label === 'safe') return { verdict: 'safe', reason: 'model_safe', detail: categories };
  if (label === 'unsafe') return { verdict: 'blocked', reason: 'model_unsafe', detail: categories };
  if (label === 'controversial') return { verdict: 'uncertain', reason: 'model_controversial', detail: categories };
  return { verdict: 'uncertain', reason: 'unparsed_verdict' };
}

/**
 * NVIDIA nemotron 的自由文本判定。保留原有正则，兼容老部署。
 */
export function parseNemotronVerdict(content) {
  const matches = [...String(content || '').matchAll(/user safety:\s*(safe|unsafe)/gi)];
  if (!matches.length) return { verdict: 'uncertain', reason: 'unparsed_output' };
  const label = matches[matches.length - 1][1].toLowerCase();
  if (label === 'safe') return { verdict: 'safe', reason: 'model_safe' };
  return { verdict: 'blocked', reason: 'model_unsafe' };
}

const GLM_SYSTEM_PROMPT = `你是校园留言板的内容安全审核员。阅读用户给出的一段中文留言，判断它是否可以公开发布。

只输出一个 JSON 对象，不要输出任何解释、代码块标记或多余文字，格式固定为：
{"verdict":"safe","categories":[]}

verdict 只能是以下三个值之一：
- "safe"：正常交流、提问、吐槽、表达情绪，可以公开
- "controversial"：擦边、疑似人身攻击、疑似针对特定同学的暗讽、需要人工再看的
- "unsafe"：明确的辱骂、霸凌、色情、暴力、违法、煽动、泄露他人隐私、政治敏感

categories 填命中的风险类别（可多选），无风险填空数组。可选值：
Violent, Bullying, Sexual, Illegal, PII, SelfHarm, Hate, Political, Spam

判断从严：拿不准就填 controversial，不要填 safe。`;

export const PROVIDERS = {
  qwenguard: {
    id: 'qwenguard',
    label: 'Qwen3Guard',
    isConfigured: env => Boolean(env?.QWEN_GUARD_KEY),
    async review(text, env) {
      // 默认走阿里云百炼：大陆网络直连、支付宝注册、每个模型 100 万 token 免费额度。
      // OVHcloud 也能用，但它需要支付方式验证才能拿到 key，匿名模式只有 2 次/分钟，
      // 不适合做生产通道，换过去时用 QWEN_GUARD_BASE_URL 覆盖即可。
      const base = trimSlash(env?.QWEN_GUARD_BASE_URL) || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      const content = await chatCompletion({
        url: `${base}/chat/completions`,
        key: env.QWEN_GUARD_KEY,
        body: {
          model: String(env?.QWEN_GUARD_MODEL || 'qwen3guard-gen-8b').trim(),
          // Qwen3Guard 的 chat template 依据最后一条消息的角色决定审核模式，
          // 必须是 user；传 system 会导致模板渲染异常并返回 safe。
          messages: [{ role: 'user', content: text }],
          temperature: 0,
          max_tokens: 64
        },
        timeout: timeoutMs(env)
      });
      return parseQwenGuard(content);
    }
  },

  glm: {
    id: 'glm',
    label: 'GLM-4-Flash',
    isConfigured: env => Boolean(env?.GLM_KEY),
    async review(text, env) {
      const base = trimSlash(env?.GLM_BASE_URL) || 'https://open.bigmodel.cn/api/paas/v4';
      const content = await chatCompletion({
        url: `${base}/chat/completions`,
        key: env.GLM_KEY,
        body: {
          model: String(env?.GLM_MODEL || 'glm-4-flash').trim(),
          messages: [
            { role: 'system', content: GLM_SYSTEM_PROMPT },
            { role: 'user', content: text }
          ],
          temperature: 0.01,
          max_tokens: 120,
          response_format: { type: 'json_object' }
        },
        timeout: timeoutMs(env)
      });
      return parseGlmVerdict(content);
    }
  },

  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    isConfigured: env => Boolean(env?.NVAPI_KEY),
    async review(text, env) {
      const content = await chatCompletion({
        url: 'https://integrate.api.nvidia.com/v1/chat/completions',
        key: env.NVAPI_KEY,
        body: {
          model: 'nvidia/nemotron-3.5-content-safety',
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
          max_tokens: 100,
          temperature: 0.01,
          top_p: 0.95,
          chat_template_kwargs: { request_categories: '/no_categories', enable_thinking: false }
        },
        timeout: timeoutMs(env)
      });
      return parseNemotronVerdict(content);
    }
  }
};

/**
 * 按 AI_REVIEW_PROVIDERS 的顺序解析出实际要调用的供应商。
 * 未配置 key 的直接跳过，所以本地只填一家也能跑。
 */
export function resolveProviderChain(env) {
  const raw = String(env?.AI_REVIEW_PROVIDERS || 'qwenguard,glm,nvidia').trim();
  const chain = [];
  const seen = new Set();
  for (const id of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const provider = PROVIDERS[id];
    if (!provider) {
      console.warn(`[AI Check] 未知供应商 ${id}，已忽略`);
      continue;
    }
    if (!provider.isConfigured(env)) continue;
    chain.push(provider);
  }
  return chain;
}
