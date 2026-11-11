# RootedVox 双部署切换

两站沿用当前的 Keycloak realm、Supabase 项目、业务数据、会话 RPC 和审核服务。账号映射由 issuer 与 subject 决定，保留原来的 issuer、realm 和用户 ID。沿用原客户端时，添加两个新域名的精确回调和退出地址，并保留旧地址直到完成切换。

| 环境 | AUTH_REDIRECT_URI | AUTH_POST_LOGOUT_REDIRECT |
| --- | --- | --- |
| Cloudflare | https://rv.celestivast.com/auth/callback | https://rv.celestivast.com/auth/post-logout |
| Vercel | https://rv-vc.celestivast.com/auth/callback | https://rv-vc.celestivast.com/auth/post-logout |

- 从对应的旧部署复制原有 `AUTH_ISSUER`、`AUTH_CLIENT_ID`、适用的客户端密钥、签名算法及其他 OIDC 配置。
- 两边复制相同的 `BUSINESS_SUPABASE_URL`、`BUSINESS_SUPABASE_PUBLISHABLE_KEY`、`BUSINESS_SUPABASE_SIGNING_JWK`。共享会话使用 `AUTH_STORE=supabase` 和原有 `AUTH_STORE_SUPABASE_SECRET_KEY`。沿用原有存储桶及数据库策略。
- 复制原有审核配置。Cloudflare 绑定原 `LEXICON_KV` 和已有的 `AI_COUNTER_KV`（部署使用时），沿用 NVIDIA 审核密钥。Vercel 保持原审核能力，需实际验证备用站投稿及人工审核队列。
- Vercel 配置 `BUSINESS_FRONTEND_URL=https://rv.celestivast.com` 和 `CORS_ALLOWED_ORIGINS=https://rv.celestivast.com,https://rv-vc.celestivast.com`。
- 新站使用 RootedVox Cookie 名称，用户首次进入时重新登录。两站之间共享新会话。
- 先验证旧账号登录、历史留言、发帖、审核、图片、退出和双向降级，再切换旧站入口。共享数据库和认证中心的可用性仍由现有服务拓扑决定。

后台凭据只填各平台的加密变量。现有 schema 和 RPC 已可用时，域名切换无需重跑旧 SQL。若环境缺少项目后期新增的 schema，先核对现状再安排变更。
