# AI 审核供应商接入指南

留言审核分两级，L1 是本地词库（零成本、毫秒级），L2 是模型审核。本文只讲 L2。

## L2 是怎么跑的

- 所有**已配置 key** 的供应商会被**并发**调用，互不等待。某家挂了不影响其余判定。
- 判定合并规则（`mergeVerdicts`）：
  - 任一家返回 `unsafe` → **拦截**（转人工）
  - 任一一家返回 `controversial` 或解析失败 → **转人工**
  - 成功响应的供应商**全部** `safe` → **放行**
  - 全部不可用 → **转人工**
- 只有「放行」会写出 `flag=1`；其余一律 `flag=0` 待审，用户端照常提交成功。
- **审核不可用不等于站点不可用**：单家供应商超时不会导致发帖失败，只会让这条留言进人工队列。

顺序只影响日志可读性，不影响调用（都是并发）。

## 环境变量

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `AI_REVIEW_PROVIDERS` | 启用哪些供应商，逗号分隔 | `qwenguard,glm,nvidia` |
| `AI_REVIEW_TIMEOUT_MS` | 单家超时，最小 1000 | `8000` |
| `QWEN_GUARD_KEY` | Qwen3Guard 的 key | 空（=禁用） |
| `QWEN_GUARD_BASE_URL` | OpenAI 兼容 base | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `QWEN_GUARD_MODEL` | 模型名 | `qwen3guard-gen-8b` |
| `GLM_KEY` | 智谱 key | 空（=禁用） |
| `GLM_BASE_URL` | 智谱 base | `https://open.bigmodel.cn/api/paas/v4` |
| `GLM_MODEL` | 模型名 | `glm-4-flash` |
| `NVAPI_KEY` | NVIDIA NIM key | 空（=禁用） |

留空即禁用该家，不需要改代码。只填一家也能正常跑。

## 一、Qwen3Guard（主力，专训安全模型）

为什么质量上它是主力：它是**专门训练的内容安全分类模型**，输出固定就两行，不需要 prompt 工程，也不允许自由发挥。三档 `Safe / Unsafe / Controversial` 正好对应「放行 / 拦截 / 转人工」。开源 Apache 2.0，119 种语言，中文基准 SOTA。但它的免费额度有时限，所以成本上的长期主力是 GLM（见下）。

输出长这样：

```
Safety: Safe
Categories: None
```

### 渠道 A：阿里云百炼（大陆首选）

1. `https://bailian.console.aliyun.com` 用支付宝/淘宝账号登录，不用境外卡。
2. 开通「模型服务」，在**模型广场**搜 `Qwen3Guard`，确认服务地域（北京或新加坡）。
3. 到「免费额度」中心领额度：每个模型 100 万 token，90 天有效。
4. 「API-KEY 管理」→ 创建 API Key。
5. 配置（默认值就是这套，填 key 即可）：
   ```
   QWEN_GUARD_KEY=<百炼 key>
   QWEN_GUARD_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
   QWEN_GUARD_MODEL=qwen3guard-gen-8b
   ```
   百炼的模型 id 是小写连字符，和 HuggingFace 的 `Qwen/Qwen3Guard-Gen-8B` 不一样，报 404 时优先怀疑这个。

### 渠道 B：OVHcloud AI Endpoints（大陆可注册，但别当生产通道）

网页注册页的「Country of tax residence」里 **China 是有的**，就在下拉第一项，港澳台只是被单独列成三行，选 China 就能继续。

但它有两个实际问题：

1. **要拿到正式 key 需要过支付方式验证。** 免费额度靠限速（400 次/分钟）而不是靠 token，但不绑支付方式通常拿不到那个配额。
2. **匿名调用只有 2 次/分钟**，而且当前实现要求填了 `QWEN_GUARD_KEY` 才会启用这家，匿名模式等于用不上。

所以它适合「已经注册成功的人顺手用」，不适合作为唯一方案。真要用就覆盖这两个变量：

```
QWEN_GUARD_BASE_URL=https://endpoints.ai.cloud.ovh.net/v1
QWEN_GUARD_MODEL=Qwen3Guard-Gen-8B
```

### 渠道 C：模力方舟 / ModelScope

0.6B 版本在该平台完全免费，适合只想零成本试水的场景。地址和模型 id 以平台文档为准，填进 `QWEN_GUARD_BASE_URL` / `QWEN_GUARD_MODEL` 即可。

### 成本现实：谁才是长期主力

一条留言审核大约 200–300 token 输入 + 30 token 输出。按 300 token/条算：

| 日留言量 | 90 天总消耗 | 百炼 100 万 token 能撑多久 |
| --- | --- | --- |
| 50 条 | 135 万 | 约 66 天 |
| 100 条 | 270 万 | 约 33 天 |
| 300 条 | 810 万 | 约 11 天 |

**结论：百炼的免费额度是「验证 + 头一个月」，不是长期答案。GLM-4-Flash 不限 Token、永久免费，才是长期主力。**

好消息是不用为额度耗尽改任何代码：Qwen3Guard 额度用完会返回 429，被当作 `provider_error` 跳过，GLM 继续判定，站点完全不受影响——只是判定从「两家交叉验证」退回「单家」。

代价是你看不见它悄悄退化了，所以要定期看一次 Functions 日志里有没有 `[AI Check] qwenguard 调用失败：http_429`。有就说明该续费或换渠道了，而不是以为还在双家。

## 二、GLM-4-Flash（长期主力，永久免费）

为什么成本上它是主力：**永久免费、不限 Token、30 并发**，是目前唯一不需要算额度就能长期跑的中文审核通道。

质量上它是通用对话模型，审核靠 prompt，判定边界会随措辞漂移，不如专训模型确定。所以策略是：**有 Qwen3Guard 额度时两家一起判（谁更严听谁的），额度用完后由 GLM 单独兜底**，词库做第一道，人工做最后一道。

规格：9B 参数（开源对应 GLM-4-9B），128K 上下文，单次输出上限 4K。新号另送 2000 万 Token。

### 注册

1. 打开 `https://open.bigmodel.cn`，手机号注册（不用绑卡）。
2. 控制台 → 「API Keys」→ 新建，复制 key（只显示一次）。
3. 配置：
   ```
   GLM_KEY=<拿到的 key>
   GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
   GLM_MODEL=glm-4-flash
   ```
4. 代码里已经用 `response_format: {"type":"json_object"}` 锁死输出格式，不用你自己调 prompt。

## 三、NVIDIA NIM（第三备）

原来的 `nvidia/nemotron-3.5-content-safety`，代码原样保留。`NVAPI_KEY` 还能用就继续留着当第三层，用不了也不影响前两家。

## 四、上线前先用 curl 自测

**先验证模型通，再接进站点。** 不要跳过这步，否则线上只会看到 `unparsed_output` 却不知道是 key 错还是模型名错。

### 测 Qwen3Guard（百炼）

```bash
curl -sS https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions \
  -H "Authorization: Bearer $QWEN_GUARD_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3guard-gen-8b","messages":[{"role":"user","content":"今天食堂的饭真难吃"}],"max_tokens":64,"temperature":0}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["choices"][0]["message"]["content"])'
```

期望输出包含 `Safety: Safe`。再换一条明显违规的文本，应该返回 `Safety: Unsafe`。返回 404 就先核对 `QWEN_GUARD_MODEL`，各平台的模型 id 并不统一。

### 测 GLM

```bash
curl -sS https://open.bigmodel.cn/api/paas/v4/chat/completions \
  -H "Authorization: Bearer $GLM_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-4-flash","messages":[{"role":"system","content":"判断输入是否适合校园留言板公开发布，只输出 JSON：{\"verdict\":\"safe|controversial|unsafe\",\"categories\":[]}"},{"role":"user","content":"今天食堂的饭真难吃"}],"response_format":{"type":"json_object"},"max_tokens":120}'
```

期望 `content` 是 `{"verdict":"safe","categories":[]}` 这样的 JSON。

## 五、填进部署环境

**Cloudflare Pages**：项目 → Settings → Environment variables → 分别给 Production 和 Preview 加。`LEXICON_KV` 是 **KV binding**，在 Settings → Functions → KV namespace bindings 里绑，不是普通变量。

**Vercel**：Project → Settings → Environment Variables，同样两组（Production / Preview）。改完需要重新部署才生效。

## 六、验证线上生效

发一条正常留言，看 Functions 日志：

```
[AI Check] 并发调用 qwenguard+glm，文本长度 12
[AI Check] qwenguard -> safe/model_safe
[AI Check] glm -> safe/model_safe
[AI Check] 合并判定 safe/model_safe
```

再发一条含词库敏感词的，应该看到 `词库命中 N 条，转人工`，且**没有**发起 API 请求。

## 七、额度够不够

单条留言约 300 token 输入 + 30 token 输出。

| 日留言量 | 日均 token | Qwen3Guard（百炼 100 万） | GLM-4-Flash |
| --- | --- | --- | --- |
| 100 条 | 3 万 | 约 33 天用完 | 不限量 |
| 500 条 | 15 万 | 约 7 天用完 | 不限量 |
| 2000 条 | 60 万 | 约 2 天用完 | 不限量 |

并发才是真正的瓶颈：GLM 30 并发，百炼按账号默认 QPS 限流。开学那几天几十人同时发帖，30 并发够，但如果撞到 429，那一条会退回单家判定，不会发帖失败。

## 八、排错

| 日志 | 原因 | 处理 |
| --- | --- | --- |
| `missing_key`（日志写「没有任何可用的审核供应商」） | key 全空，或 `AI_REVIEW_PROVIDERS` 名字拼错 | 检查 key 是否加在**正确环境**（Production/Preview） |
| `http_401` | key 错或已失效 | 重新生成 |
| `http_404` | 模型 id 不对 | 各平台 id 不同，按渠道换 `*_MODEL` |
| `http_429` | 限流或额度耗尽 | 百炼免费额度用完就是 429；此时已自动退回单家判定，续费或换渠道 |
| `unparsed_output` | 模型返回了别的东西 | 用 curl 打一次看原始输出，再调 `*_MODEL` |
| `model_controversial` | 模型判为擦边 | 正常行为，进人工队列 |
| `provider_error` + 另一家 `safe` | 一家挂了 | 不影响放行；需要关注是不是 key 到期或额度用尽 |

**定期体检**：额度耗尽不会有任何用户可见的症状，只是判定悄悄从双家退回单家。每周看一次 Functions 日志里有没有 `[AI Check] qwenguard 调用失败：http_429`，有就说明该续了。

判定相关代码在 `functions/_lib/ai-providers.js`（每家一个 `review()`），合并逻辑在 `functions/_lib/moderate-content.js` 的 `mergeVerdicts()`。新增一家只需在 `PROVIDERS` 里加一个对象。
