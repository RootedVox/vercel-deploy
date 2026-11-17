# AI 审核供应商接入指南

留言审核分两级，L1 是本地词库（零成本、毫秒级），L2 是模型审核。本文只讲 L2。

## L2 是怎么跑的

- 所有**已启用**的供应商会被**并发**调用，互不等待。某家挂了不影响其余判定。
- 判定合并（`mergeVerdicts`）按固定顺序，谁先命中听谁的：
  - **全部** `unsafe` → **拒绝**（`flag=2`，作者收到「留言未通过审核」）
  - 任一家 `unsafe`、但不是全部 → **转人工**（有分歧，不机器单方面毙掉）
  - 任一家 `controversial`（擦边）→ **转人工**
  - 任一家 `safe` → **放行**（一票放行，配几家都不会更容易进人工）
  - 全部失败/超时 → **转人工**
- 为什么拒绝要求「全部」而不是「任一」：`flag=2` 是不可逆的终态，作者会看到「未通过审核」。只要还有一家给了别的结论（`safe`、擦边，或者干脆没拿到结论），就说明存在争议或没问全，交给人判更合适。
- 关键区分：`controversial` 是**模型给的结论**，要转人工；`error`（超时、报错、解析失败）是**没拿到结论**，只跳过、不参与判定。两者混在一起会让「一家超时」等同于「全站转人工」，那配第二家反而是负收益。
- 只有「放行」写出 `flag=1`、只有「全部 `unsafe`」写出 `flag=2`；其余一律 `flag=0` 待审，用户端照常提交成功。L1 词库命中虽然也走 `blocked`，但 `reason` 是 `lexicon`，`finish_forum_review` 只认 `reason='model_unsafe'`，所以词库命中仍然是 `flag=0` 转人工，不会被自动拒绝。
- **AI 放行后作者会收到站内通知**「留言审核通过」，与人工通过同一条文案（`processNextModeration` 写入 `business_notifications`）。
- **AI 一致拒绝时作者会收到红色通知**「留言未通过审核」，带 `拒绝原因` 并提示可联系管理员复核——这条没有人读过就定了终态，必须给出申诉路径。审核端可以用 `restore` 把它改回 `flag=1`。
- **AI 没拿到拒绝结论时作者会收到琥珀色通知**「留言转为人工审核」。文案刻意不含「未通过/拒绝」，因为它仍然在队列里等人看。留言已被人工处理（`flag=1`）或数据库安排重试时都不发，避免告知过时状态。
- 给 GLM 的留言原文放在【待审核留言开始】【待审核留言结束】之间（原文里伪造的边界标记会被去掉），系统提示要求把其中的指令当数据、出现指挥审核结果的内容判 `controversial`。
- **联系方式一律转人工**：手机号、微信号、QQ 号/群号、邮箱、身份证号、学号、住址、二维码，以及「加我/私聊拿号」这类引流说法，都判 `controversial` + `PII`。没有号码的随口约人（"想一起打球的找我"）照常放行，避免过度拦截。
- **审核不可用不等于站点不可用**：单家供应商超时或限流不会导致发帖失败，只会让这条留言进人工队列。
- **`flag=2` 需要先执行 `supabase/20261117_forum_ai_reject.sql`**。没执行时 `finish_forum_review` 不认识这个分支，留言会留在 `flag=0`，代码检测到 `flag=0` 会自动退回发「转为人工审核」通知，不会谎报未通过——功能降级但不会出错。

## 哪些留言根本不走 AI 审核

`forum_private.enqueue_review` 触发器只把同时满足下面三条的留言放进审核队列：

```sql
new.flag = 0                              -- 新产生的待审内容
and not new.is_featured                   -- 不是精华投稿
and new.business_user_id is not null      -- 有作者（匿名投稿不入队）
and coalesce(to_jsonb(new.pic_url),'[]'::jsonb) = '[]'::jsonb   -- 不带图
```

也就是说：

| 类型 | 是否走 AI | 结果 |
| --- | --- | --- |
| 普通纯文本留言 / 回复 | ✅ 走 | AI 放行则公开，否则转人工 |
| 带图片的留言 | ❌ 不走 | 直接 `flag=0` 等人工 |
| 精华投稿 | ❌ 不走 | 直接进精华专审 |
| 匿名投稿（无账号） | ❌ 不走 | 直接等人工 |

这条判断在**触发器层面**，不在应用代码里，所以 `processNextModeration` 调用 `runAiCheck(job.content, [], env)` 传空图片数组是安全的——带图的内容压根不会出现在队列里。精华投稿另有专审流程，AI 不会碰。

## 环境变量

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `AI_REVIEW_PROVIDERS` | 启用哪些供应商，逗号分隔 | `qwenguard,glm,nvidia` |
| `AI_REVIEW_TIMEOUT_MS` | 单家超时，最小 1000 | `8000` |
| `QWEN_GUARD_ANONYMOUS` | 设为 `1` 走 OVHcloud 匿名通道（免注册、免 key） | 空（=禁用匿名） |
| `QWEN_GUARD_KEY` | Qwen3Guard 的 key（有 key 就不需要匿名开关） | 空 |
| `QWEN_GUARD_BASE_URL` | OpenAI 兼容 base | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`（OVHcloud；用百炼时**必须**改成百炼地址，见下） |
| `QWEN_GUARD_MODEL` | 模型名 | `Qwen3Guard-Gen-8B` |
| `GLM_KEY` | 智谱 key | 空（=禁用） |
| `GLM_BASE_URL` | 智谱 base | `https://open.bigmodel.cn/api/paas/v4` |
| `GLM_MODEL` | 模型名，**必须是 `glm-4.7-flash`** | `glm-4.7-flash` |
| `GLM_FALLBACK_MODELS` | 排队（1305）时依次尝试的备用免费模型 | `glm-4-flash-250414,glm-z1-flash` |
| `NVAPI_KEY` | NVIDIA NIM key | 空（=禁用） |

留空即禁用该家，不需要改代码。

## 先说结论：哪条腿能长期跑

| 通道 | 成本 | 有效期 | 能不能长期跑 |
| --- | --- | --- | --- |
| **GLM-4.7-Flash** | 免费（输入输出） | 当前免费名单内 | ✅ 主力 |
| **OVHcloud 匿名 Qwen3Guard** | 免费，免注册 | 无期限，限 2 次/分钟/IP | ✅ 交叉验证 |
| 百炼 Qwen3Guard | 每模型 100 万 token | **90 天一次性，不补发不重置** | ❌ 只能算试用 |
| 开源权重自部署 | 要 GPU | — | 有机器才行 |

**百炼的额度是一次性的**：官方原文「额度到期自动失效，不支持补发、延期或重置」，90 天内用不完的部分直接作废，不会按月刷新。所以它不值得当主通道。而且百炼主要托管通义商业模型，Qwen3Guard 是开源权重模型，能不能在模型广场搜到要看当期政策，不建议把方案压在这上面。

## 一、GLM-4.7-Flash（主力，输入输出免费）

规格：**30B 参数，200K 上下文**，输入/输出/缓存全部免费（智谱 2026 年官方定价页口径），并发 30。

### 先认清哪些免费、哪些别碰

智谱的模型名很容易踩坑，`Flash` 不等于免费：

| 模型 id | 状态 | 备注 |
| --- | --- | --- |
| **`glm-4.7-flash`** | ✅ **免费** | 200K，30B，就选这个 |
| `glm-4-flash-250414` | ✅ 免费 | 128K，旧版免费 id |
| `glm-z1-flash` | ✅ 免费 | 128K，**推理模型**，输出前置 `<think>` 思考块，代码会剥掉 |
| `glm-4-flash` | ❌ **已不在免费名单** | 老教程里的这个别用 |
| `glm-5.3-flash` | ❌ 付费 | 0.8 元/M 输入，2.8 元/M 输出，名字最像但不免费 |
| `glm-4.7` | ❌ 付费 | 355B 旗舰 |

控制台「体验中心」默认选中的 **GLM-4.7-Flash** 就是对的；首页推的 **GLM-5.3-Flash 是要钱的**，别被位置误导。

质量上它是通用对话模型，审核靠 prompt，判定边界会随措辞漂移，不如专训模型确定。所以策略是「GLM 保底 + Qwen3Guard 在能连上时交叉验证 + 词库第一道 + 人工最后一道」。

### 注册步骤（手机号，不用绑卡）

1. 打开 `https://open.bigmodel.cn`，点右上角「登录/注册」。
2. 输入手机号 → 获取验证码 → 勾选用户协议 → 注册完成。不需要信用卡，也不需要实名认证。
3. 登录后进入控制台，左侧菜单点「API Key」→「标准 API key」。
4. 点右上角「+ 新建 API Key」，填个项目名（比如 `rootedvox`），确认。
5. 列表里 `API key` 那一列是**打码显示**的（形如 `f6ce...FV5J`），点右侧的复制按钮才拿得到完整值。
6. 完整 key 是 `{id}.{secret}` 两段用点号连接的形式，**不是 `sk-` 开头**——网上很多教程写错了。
7. 免费额度不用领：定价页标「免费」就是按 0 计价，没有需要激活的券。

### 配置

```
GLM_KEY=复制到的完整 key
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
GLM_MODEL=glm-4.7-flash
```

`GLM_MODEL` 不填时代码默认就是 `glm-4.7-flash`，所以其实只填 `GLM_KEY` 就能跑。

**模型不是在任何界面里选的。** 站点前端完全不知道有模型这回事，审核跑在服务端后台（Pages Functions / Vercel Functions），模型名只由环境变量 `GLM_MODEL` 决定。控制台里点模型、勾「深度思考」、改体验中心的选项，都不会影响线上审核。

代码里已经用 `response_format: {"type":"json_object"}` 锁死输出格式，不用你自己调 prompt。

## 二、Qwen3Guard（交叉验证，OVHcloud 匿名）

OVHcloud 的 AI Endpoints 提供一个**不用注册、不用 key、不过期**的匿名入口，托管了 30 个开源模型，其中包含 `Qwen3Guard-Gen-0.6B` 和 `Qwen3Guard-Gen-8B`。

### 两个必须记住的坑

**域名是 `oai.endpoints.kepler.ai.cloud.ovh.net`**，不是 `endpoints.ai.cloud.ovh.net`。后者是营销域名，任何路径都 301 到产品介绍页，返回 HTML，`JSON.parse` 必然失败（线上表现为 `qwenguard 调用失败：invalid_json_response`）。

**匿名模式必须完全不发 `Authorization` 头。** 网上很多教程（包括部分 AI 的回答）说「随便填一串字符即可」，这是错的——带了反而返回：

```json
{"message":"Forbidden: authentication failed. ..."}
```

不带才是最放松的匿名通道。这也是为什么代码在没配 key 时不发这个头。

### 匿名够不够用

按客户端 IP 限速，不适合高并发，但校园墙一天几十到几百条完全在范围内。撞到限速会返回 429，那一条自动退回 GLM 单家判定，帖子照常发，不会失败。

### 启用

三行，全部是默认值，实际只需要第一条：

```
QWEN_GUARD_ANONYMOUS=1
QWEN_GUARD_BASE_URL=https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
QWEN_GUARD_MODEL=Qwen3Guard-Gen-8B
```

想更轻量可以换 `Qwen3Guard-Gen-0.6B`，判中文留言够用。

### 自测

```bash
curl -sS https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3Guard-Gen-8B","messages":[{"role":"user","content":"今天食堂的饭真难吃"}],"max_tokens":32,"temperature":0}'
```

期望：

```
Safety: Safe
Categories: None
```

换一条明显违规的，应该返回 `Safety: Unsafe` + 具体类别。

### 如果要更高配额

注册 OVHcloud 账号、创建 Public Cloud 项目、在 AI Endpoints 里建 key，就能拿到认证配额。注册页的「Country of tax residence」里 **China 是第一项**（港澳台单独列成三行，不影响选 China），但拿正式 key 通常要过支付方式验证。拿到后填 `QWEN_GUARD_KEY` 并去掉 `QWEN_GUARD_ANONYMOUS`。

### 百炼也可以，但只是试用

阿里云百炼每模型 100 万 token，**90 天一次性、不补发不重置**，日 100 条约 33 天见底。当备用可以，别当长期方案。

**`QWEN_GUARD_BASE_URL` 一定要一起改。** 不填时默认地址是 OVHcloud，百炼的 key 会被原样发到 OVHcloud——不仅审核失败，还等于把百炼密钥交给了另一家公司。

```
QWEN_GUARD_KEY=<百炼 key>
QWEN_GUARD_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_GUARD_MODEL=qwen3guard-gen-8b
```

## 三、NVIDIA NIM（已下线，建议删除 key）

2026-11-17 线上日志：

```
http_404 {"status":404,"title":"Not Found",
"detail":"Function id '3e84ff75-...' version 'null': Specified function ... is not found"}
```

**这不是 key 过期，也不是临时故障**，是 NVIDIA 侧承载该模型的函数实例已经被下线。第三方实测的时间线：

- **2026-11-03**：该模型 endpoint 已 0% 可用，每次调用返回 503/404，但目录页仍挂着，看起来还在。
- **2026-11-10**：`nvidia/nemotron-3.5-content-safety` 的 `:free` 端点正式结束，API 里已找不到 provider。
- 现在它作为付费模型存在（约 $0.2/百万 token）。

**结论：重试永远不会成功。** 留着 `NVAPI_KEY` 只会让每次审核白打一次 404 请求、多几百毫秒，还会把日志刷满。**直接删掉这个环境变量**，代码会自动跳过。

另外这个模型本身是 4B（Gemma-3-4B 微调）、以英文训练为主，中文审核本来就不如 Qwen3Guard。它退场对中文内容审核质量没有损失。

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

先把 key 存进变量，命令里只用 `$GLM_KEY`。直接在命令里粘 key 很容易带进多余空格，
或者手滑把打码后的显示值复制进去。

```bash
export GLM_KEY='完整key粘在这里'
echo ${#GLM_KEY}     # 应该是 60 出头；低于 40 说明复制到的是打码值
```

```bash
curl -sS https://open.bigmodel.cn/api/paas/v4/chat/completions \
  -H "Authorization: Bearer $GLM_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-4.7-flash","messages":[{"role":"system","content":"判断输入是否适合校园留言板公开发布，只输出 JSON：{\"verdict\":\"safe|controversial|unsafe\",\"categories\":[]}"},{"role":"user","content":"今天食堂的饭真难吃"}],"response_format":{"type":"json_object"},"max_tokens":120}'
```

期望 `content` 是 `{"verdict":"safe","categories":[]}` 这样的 JSON。

**两个高频错误：**

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `{"error":{"code":"1000","message":"身份验证失败。"}}` | key 无效：复制到了打码值（带 `...`）、粘进了多余文字、或 key 已删 | `echo ${#GLM_KEY}` 看长度，回控制台**点复制按钮**重拿 |
| `{"error":{"code":"1305","message":"该模型当前访问量过大"}}` | **免费配额池排队**，不是你配错了 | 正常现象，尤其晚高峰。代码会自动换备用模型重试；全都在排队时才转人工 |
| `"code":"1211"` / `UNKNOWN_MODEL` | 模型 id 错 | 必须是 `glm-4.7-flash`，注意不是 `glm-5.3-flash`（付费）也不是 `glm-4-flash`（已不在免费名单） |

`Authorization` 头只允许 `Bearer` + 一个空格 + 完整 key，中间不能再有任何东西。

#### 关于 1305

免费模型共用配额池，晚上八点这类高峰会排队。这个错误**恰恰说明你的 key 和模型名都是对的**——key 错报 `1000`，模型名错报 `1211`。

代码里的处理：`glm-4.7-flash` 报 1305 时，自动依次改用 `glm-4-flash-250414`、`glm-z1-flash` 再试。这三个 id 的配额池互相独立，通常换一个立刻就过。三个都在排队才会把这条留言交给下一家供应商（或转人工）。

队列响应是秒回的，不是超时，所以串行试三个不会拖慢多少。

## 五、填进部署环境

**前端不用改任何东西。** 审核跑在服务端后台，需要填的只有环境变量。

### Cloudflare Pages

项目 → **Settings** → **Environment variables** → 点 **Add variable**。有两栏要分别填：**Production** 和 **Preview**，只填一栏的话另一半环境不会生效。

最少只需要一条：

| 变量名 | 值 |
| --- | --- |
| `GLM_KEY` | 你复制的完整 key |

其余变量都有默认值，不填就是默认。可选加的：

| 变量名 | 值 | 作用 |
| --- | --- | --- |
| `QWEN_GUARD_ANONYMOUS` | `1` | 启用免注册的 Qwen3Guard 交叉验证 |
| `GLM_MODEL` | `glm-4.7-flash` | 换模型（默认已经是它） |

填完点 **Save**，然后到 **Deployments** 页面对最新一次部署点 **Retry deployment**——环境变量不会自动热加载，必须重新部署才生效。

`LEXICON_KV` 是 **KV binding**，在 Settings → Functions → KV namespace bindings 里绑，不是普通变量。它已经存在的话不用动。

### Vercel

Project → **Settings** → **Environment Variables**，同样分 Production / Preview 两组。Vercel 会问你要不要把新变量应用到哪几个环境，两个都勾上。改完到 Deployments 里 **Redeploy** 一次。

### 顺序建议

先只填 `GLM_KEY`，部署，发一条测试留言，日志里确认 `glm -> safe/model_safe`，再考虑加 Qwen3Guard 那条腿。一次只改一个变量，出问题好定位。

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

| 日留言量 | GLM-4.7-Flash | OVHcloud 匿名 |
| --- | --- | --- |
| 50 条 | 按 0 计价 | 约占 1.7% 的日配额 |
| 100 条 | 按 0 计价 | 约占 3.5% |
| 500 条 | 按 0 计价 | 约占 17% |

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
