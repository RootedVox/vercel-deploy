# AI 审核供应商接入指南

留言审核分两级，L1 是本地词库（零成本、毫秒级），L2 是模型审核。本文只讲 L2。

## L2 是怎么跑的

- 所有**已启用**的供应商会被**并发**调用，互不等待。某家挂了不影响其余判定。
- 判定合并（`mergeVerdicts`）按固定顺序，谁先命中听谁的：
  - 任一家 `unsafe` → **拦截**（转人工）
  - 任一家 `controversial`（擦边）→ **转人工**
  - 任一家 `safe` → **放行**（一票放行，配几家都不会更容易进人工）
  - 全部失败/超时 → **转人工**
- 关键区分：`controversial` 是**模型给的结论**，要转人工；`error`（超时、报错、解析失败）是**没拿到结论**，只跳过、不参与判定。两者混在一起会让「一家超时」等同于「全站转人工」，那配第二家反而是负收益。
- 只有「放行」会写出 `flag=1`；其余一律 `flag=0` 待审，用户端照常提交成功。
- **审核不可用不等于站点不可用**：单家供应商超时或限流不会导致发帖失败，只会让这条留言进人工队列。

## 环境变量

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `AI_REVIEW_PROVIDERS` | 启用哪些供应商，逗号分隔 | `qwenguard,glm,nvidia` |
| `AI_REVIEW_TIMEOUT_MS` | 单家超时，最小 1000 | `8000` |
| `QWEN_GUARD_ANONYMOUS` | 设为 `1` 走 OVHcloud 匿名通道（免注册、免 key） | 空（=禁用匿名） |
| `QWEN_GUARD_KEY` | Qwen3Guard 的 key（有 key 就不需要匿名开关） | 空 |
| `QWEN_GUARD_BASE_URL` | OpenAI 兼容 base | `https://endpoints.ai.cloud.ovh.net/v1` |
| `QWEN_GUARD_MODEL` | 模型名 | `Qwen3Guard-Gen-8B` |
| `GLM_KEY` | 智谱 key | 空（=禁用） |
| `GLM_BASE_URL` | 智谱 base | `https://open.bigmodel.cn/api/paas/v4` |
| `GLM_MODEL` | 模型名 | `glm-4-flash` |
| `NVAPI_KEY` | NVIDIA NIM key | 空（=禁用） |

留空即禁用该家，不需要改代码。

## 先说结论：哪条腿能长期跑

| 通道 | 成本 | 有效期 | 能不能长期跑 |
| --- | --- | --- | --- |
| **GLM-4-Flash** | 免费，**不限 Token** | 永久 | ✅ 主力 |
| **OVHcloud 匿名 Qwen3Guard** | 免费，免注册 | 无期限，限 2 次/分钟/IP | ✅ 交叉验证 |
| 百炼 Qwen3Guard | 每模型 100 万 token | **90 天一次性，不补发不重置** | ❌ 只能算试用 |
| 开源权重自部署 | 要 GPU | — | 有机器才行 |

**百炼的额度是一次性的**：官方原文「额度到期自动失效，不支持补发、延期或重置」，90 天内用不完的部分直接作废，不会按月刷新。所以它不值得当主通道。而且百炼主要托管通义商业模型，Qwen3Guard 是开源权重模型，能不能在模型广场搜到要看当期政策，不建议把方案压在这上面。

## 一、GLM-4-Flash（主力，永久免费）

规格：9B 参数（开源对应 GLM-4-9B），128K 上下文，单次输出上限 4K，**永久免费不限 Token**，并发 30。新号另送 2000 万 Token。

质量上它是通用对话模型，审核靠 prompt，判定边界会随措辞漂移，不如专训模型确定。所以策略是「GLM 保底 + Qwen3Guard 在能连上时交叉验证 + 词库第一道 + 人工最后一道」。

### 注册步骤（手机号，不用绑卡）

1. 打开 `https://open.bigmodel.cn`，点右上角「登录/注册」。
2. 输入手机号 → 获取验证码 → 勾选用户协议 → 注册完成。不需要信用卡，也不需要实名认证。
3. 登录后进入控制台，左侧菜单找「API Keys」（有的版本叫「密钥管理」或「API 密钥」）。
4. 点「新建 API Key」，给个名字（比如 `rootedvox`），确认后页面上会出现一串以 `sk-` 开头的 key。
5. **立刻复制**——这串 key 通常只完整显示一次，关掉就看不到了。存到密码管理器或本地文本里。
6. 额度确认：控制台的「费用中心」或「资源包」页面里能看到 `glm-4-flash` 标注为免费模型。不需要领券。

### 配置

```
GLM_KEY=sk-你复制到的那串
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4-flash
```

代码里已经用 `response_format: {"type":"json_object"}` 锁死输出格式，不用你自己调 prompt。

## 二、OVHcloud 匿名 Qwen3Guard（交叉验证，免注册）

这是唯一「不注册、不填 key、不过期」的 Qwen3Guard 通道：OVHcloud 的 AI Endpoints 对匿名请求开放，按客户端 IP 限 **2 次/分钟**。

**2 次/分钟够不够？** 换算成一天是 2880 次。校园墙一天几十到几百条留言，完全在额度内。真正的限制是「瞬时」——如果一分钟内有 5 个人同时发帖，第 3 条起会收到 429；这时那几条自动退回 GLM 单家判定，帖子照常发，不会失败。

### 启用

```
QWEN_GUARD_ANONYMOUS=1
QWEN_GUARD_BASE_URL=https://endpoints.ai.cloud.ovh.net/v1
QWEN_GUARD_MODEL=Qwen3Guard-Gen-8B
```

只要这三行，不用注册。想换成 `Qwen3Guard-Gen-0.6B` 就改 `QWEN_GUARD_MODEL`，判中文留言够用。

### 如果以后想提到 400 次/分钟

OVHcloud 注册页的「Country of tax residence」里 **China 是第一项**（港澳台被单独列成三行，不影响选 China）。但注册后要拿到正式 key 通常需要过支付方式验证，大陆卡可能过不了。过得了就填 `QWEN_GUARD_KEY`，去掉 `QWEN_GUARD_ANONYMOUS` 即可。

### 关于百炼

如果你已经有阿里云账号且想试，注意三点：额度 **90 天一次性不重置**、需要实名、模型广场不一定有 Qwen3Guard。真想接就填：

```
QWEN_GUARD_KEY=<百炼 key>
QWEN_GUARD_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_GUARD_MODEL=qwen3guard-gen-8b
```

注意百炼的模型 id 是小写连字符，和 HuggingFace 的 `Qwen/Qwen3Guard-Gen-8B` 不一样，报 404 优先怀疑这个。

## 三、NVIDIA NIM（第三备）

原来的 `nvidia/nemotron-3.5-content-safety`，代码原样保留。`NVAPI_KEY` 还能用就继续留着当第三层，用不了也不影响前两家。

## 四、上线前先用 curl 自测

**先验证通道通，再接进站点。** 不要跳过这步，否则线上只会看到 `unparsed_output`，分不清是 key 错还是模型名错。

### 测 OVHcloud 匿名（无需 key）

```bash
curl -sS https://endpoints.ai.cloud.ovh.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3Guard-Gen-8B","messages":[{"role":"user","content":"今天食堂的饭真难吃"}],"max_tokens":64,"temperature":0}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["choices"][0]["message"]["content"])'
```

期望输出包含 `Safety: Safe`。再换一条明显违规的文本，应该返回 `Safety: Unsafe`。返回 429 说明这一分钟已经用掉 2 次了，等一分钟再试。

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

## 七、额度与限速

单条留言约 200–300 token 输入 + 30 token 输出。

| 日留言量 | GLM-4-Flash | OVHcloud 匿名 |
| --- | --- | --- |
| 50 条 | 不限量 | 约占 1.7% 的日配额 |
| 100 条 | 不限量 | 约占 3.5% |
| 500 条 | 不限量 | 约占 17% |

瓶颈只有「瞬时 2 次/分钟」。只要不是几十人同一分钟集中发帖就够用；撞到了也只是退回 GLM 单家。

## 八、排错

| 日志 | 原因 | 处理 |
| --- | --- | --- |
| `missing_key`（日志写「没有任何可用的审核供应商」） | 全空，或 `AI_REVIEW_PROVIDERS` 名字拼错，或匿名没开 `QWEN_GUARD_ANONYMOUS=1` | 检查 key / 开关是否加在**正确环境**（Production/Preview） |
| `http_401` | key 错或已失效 | 重新生成 |
| `http_404` | 模型 id 不对 | 各平台 id 不同，按渠道换 `*_MODEL` |
| `http_429`（OVHcloud） | 匿名 2 次/分钟用满 | 正常，等一分钟；这条会退回 GLM 单家判定 |
| `http_429`（百炼） | 免费额度耗尽 | 一次性额度不会恢复，需换渠道或付费 |
| `unparsed_output` | 模型返回了别的东西 | 用 curl 打一次看原始输出，再调 `*_MODEL` |
| `model_controversial` | 模型判为擦边 | 正常行为，进人工队列 |
| `provider_error` + 另一家 `safe` | 一家挂了 | 不影响放行；关注是不是 key 到期或限流 |

**定期体检**：某家长期 429 不会有任何用户可见的症状，只是判定悄悄从双家退回单家。每周扫一眼 Functions 日志里有没有 `调用失败`，有就说明那条腿已经断了。

判定相关代码在 `functions/_lib/ai-providers.js`（每家一个 `review()`），合并逻辑在 `functions/_lib/moderate-content.js` 的 `mergeVerdicts()`。新增一家只需在 `PROVIDERS` 里加一个对象。
