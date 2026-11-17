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
    const headers = { 'Content-Type': 'application/json' };
    // 匿名通道（OVHcloud 免费层）不带 Authorization。
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
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
    // 智谱在配额排队时可能返回 200 + {"error":{"code":"1305",...}}，
    // 不检查就会当成「空回复」，白白丢掉一次可重试的机会。
    if (data?.error) {
      const code = data.error.code ?? 'unknown';
      const message = String(data.error.message ?? '').slice(0, ERR_DETAIL_MAX);
      throw new Error(`api_${code}:${message}`);
    }
    return String(data?.choices?.[0]?.message?.content ?? '');
  }, timeout);
}

/** 免费配额排队/限流。这类错误换一个模型或换一家就能过，值得重试。 */
export function isBusyError(error) {
  return /(?:http_429|api_1305|api_1302|api_1303)/.test(String(error?.message ?? ''));
}

/**
 * 供应商返回的 verdict 有四种，必须严格区分：
 *   'safe'          模型明确说可以放行
 *   'blocked'       模型明确说不安全
 *   'controversial' 模型明确说擦边（要转人工，不是故障）
 *   'error'         没拿到结论：超时、报错、解析失败
 *
 * 合并时 controversial 会拦下整条留言，error 只会被跳过。把两者混成一个
 * 'uncertain' 会让一家超时就等于全站转人工，所以这里必须分开。
 */

/**
 * Qwen3Guard-Gen 输出固定两行：
 *   Safety: Safe | Unsafe | Controversial
 *   Categories: Violent / None / ...
 * 取最后一次匹配，避免模型把输入原文回显时干扰判定。
 */
export function parseQwenGuard(content) {
  const matches = [...String(content || '').matchAll(/Safety:\s*(Safe|Unsafe|Controversial)/gi)];
  if (!matches.length) return { verdict: 'error', reason: 'unparsed_output' };
  const label = matches[matches.length - 1][1].toLowerCase();
  const categories = (/Categories:\s*([^\n]*)/i.exec(String(content || ''))?.[1] || '').trim();
  if (label === 'safe') return { verdict: 'safe', reason: 'model_safe', detail: categories };
  if (label === 'unsafe') return { verdict: 'blocked', reason: 'model_unsafe', detail: categories };
  return { verdict: 'controversial', reason: 'model_controversial', detail: categories };
}

/**
 * GLM 是通用模型，靠 prompt + JSON 输出约束。解析容错：
 * - 推理模型（glm-z1-flash）会先输出 `…` 思考块，必须先剥掉；
 * - 允许模型在 JSON 前后夹带说明文字，取第一个 { 到最后一个 }。
 */
export function parseGlmVerdict(content) {
  const raw = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { verdict: 'error', reason: 'unparsed_output' };
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { verdict: 'error', reason: 'unparsed_output' };
  }
  const label = String(parsed?.verdict || '').trim().toLowerCase();
  const categories = Array.isArray(parsed?.categories) ? parsed.categories.join(',') : '';
  if (label === 'safe') return { verdict: 'safe', reason: 'model_safe', detail: categories };
  if (label === 'unsafe') return { verdict: 'blocked', reason: 'model_unsafe', detail: categories };
  if (label === 'controversial') return { verdict: 'controversial', reason: 'model_controversial', detail: categories };
  return { verdict: 'error', reason: 'unparsed_verdict' };
}

/**
 * NVIDIA nemotron 的自由文本判定。保留原有正则，兼容老部署。
 */
export function parseNemotronVerdict(content) {
  const matches = [...String(content || '').matchAll(/user safety:\s*(safe|unsafe)/gi)];
  if (!matches.length) return { verdict: 'error', reason: 'unparsed_output' };
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

/**
 * 主模型 + 排队时的备用模型。这几个都是智谱当前免费名单内的 id，各有独立的
 * 配额池，所以一个报 1305 时换另一个通常立刻能过。
 *
 * 别把 glm-4-flash（无日期后缀）加回来——它已不在免费名单；
 * 也别加 glm-5.3-flash / glm-4.7，那两个是付费的。
 */
export function glmModels(env) {
  const primary = String(env?.GLM_MODEL || 'glm-4.7-flash').trim() || 'glm-4.7-flash';
  const fallbacks = String(env?.GLM_FALLBACK_MODELS ?? 'glm-4-flash-250414,glm-z1-flash')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return [primary, ...fallbacks].filter((model, index, all) => all.indexOf(model) === index);
}

export const PROVIDERS = {
  qwenguard: {
    id: 'qwenguard',
    label: 'Qwen3Guard',
    // 两条启用方式：填了 key（百炼 / 已注册的 OVH 账号），或显式开启匿名通道
    // （QWEN_GUARD_ANONYMOUS=1，OVHcloud 免费层，限 2 次/分钟/IP，不用注册）。
    // 匿名不需要 key，所以这里不能用 "有 key" 做唯一判据。
    isConfigured: env => Boolean(env?.QWEN_GUARD_KEY) || String(env?.QWEN_GUARD_ANONYMOUS ?? '') === '1',
    async review(text, env) {
      // 默认 OVHcloud：匿名即可用，是唯一零注册、无有效期的通道。
      // 有 key 的其他渠道（百炼等）用 QWEN_GUARD_BASE_URL 覆盖。
      const base = trimSlash(env?.QWEN_GUARD_BASE_URL) || 'https://endpoints.ai.cloud.ovh.net/v1';
      const content = await chatCompletion({
        url: `${base}/chat/completions`,
        key: env.QWEN_GUARD_KEY || null,
        body: {
          model: String(env?.QWEN_GUARD_MODEL || 'Qwen3Guard-Gen-8B').trim(),
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
    label: 'GLM-4.7-Flash',
    isConfigured: env => Boolean(env?.GLM_KEY),
    async review(text, env) {
      const base = trimSlash(env?.GLM_BASE_URL) || 'https://open.bigmodel.cn/api/paas/v4';
      // 智谱的免费模型各自有独立配额池，一个排队时换另一个通常立刻能过。
      // 排队响应是秒回的（不是超时），所以串行试几个不会吃掉时间预算。
      const models = glmModels(env);
      let lastError;
      for (const model of models) {
        try {
          const content = await chatCompletion({
            url: `${base}/chat/completions`,
            key: env.GLM_KEY,
            body: {
              model,
              messages: [
                { role: 'system', content: GLM_SYSTEM_PROMPT },
                { role: 'user', content: text }
              ],
              temperature: 0.01,
              // 200 而不是 120：备用池里有推理模型（glm-z1-flash），思考块会先吃掉
              // 一部分 token，留够余量才轮得到 JSON。
              max_tokens: 200,
              response_format: { type: 'json_object' }
            },
            timeout: timeoutMs(env)
          });
          return parseGlmVerdict(content);
        } catch (error) {
          lastError = error;
          // 只有排队/限流才换模型；key 错了换几个模型也一样错。
          if (!isBusyError(error)) throw error;
          console.warn(`[AI Check] glm ${model} 排队，换下一个免费模型`);
        }
      }
      throw lastError;
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
