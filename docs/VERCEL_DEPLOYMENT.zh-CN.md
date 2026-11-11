# Vercel 部署

当前仓库可同时部署到 Cloudflare Pages 和 Vercel。Vercel 通过 `api/` 中的薄适配层复用 `functions/` 内的同一套认证和业务逻辑；业务数据继续使用用户级 Supabase JWT 与 RLS，只有共享 OAuth transaction / business session 的私有 RPC 使用后端 secret key。

## 项目设置

- Framework Preset：Other
- Build Command：`npm run build:vercel`（`vercel.json` 已声明）
- Output Directory：`vercel-public`（`vercel.json` 已声明）
- Production Domain：`api.celestivast.com`
- Node.js：使用 Vercel 当前支持的 Node.js 运行时

Vercel 环境变量至少需要：

```text
AUTH_ISSUER
AUTH_CLIENT_ID
AUTH_CLIENT_SECRET
AUTH_REDIRECT_URI=https://api.celestivast.com/auth/callback
AUTH_SCOPES=openid profile email
OIDC_ALLOWED_ALGORITHMS=RS256
AUTH_STORE=supabase
AUTH_STORE_SUPABASE_SECRET_KEY
BUSINESS_SUPABASE_URL
BUSINESS_SUPABASE_PUBLISHABLE_KEY
BUSINESS_SUPABASE_SIGNING_JWK
BUSINESS_SESSION_COOKIE_DOMAIN=.celestivast.com
BUSINESS_FRONTEND_URL=https://isaspectrum.celestivast.com
CORS_ALLOWED_ORIGINS=https://isaspectrum.celestivast.com
```

按需设置 `OIDC_ACCEPT_AZP_AS_AUDIENCE`、会话时长和 `NVAPI_KEY`。Keycloak 必须精确登记 `https://api.celestivast.com/auth/callback`。数据库需已执行 `supabase/20261101_shared_auth_store.sql`；它只存 OAuth transaction 和业务 session，不替代业务表 RLS。

Cloudflare KV 的敏感词库不会自动出现在 Vercel。未配置兼容词库时，Vercel 遵循 fail-safe：新留言进入人工审核而不是绕过审核。AI 计数器缺失不会阻断业务请求。

## 验证

```bash
npm run check
npm test
npm run build:vercel
```

部署后检查：`/auth/session` 未登录时返回 401，`/auth/login` 返回 Keycloak 302，`/api/messages` 可读取公开安全视图，来自主站的 OPTIONS 预检返回 204，其他来源返回 403。
