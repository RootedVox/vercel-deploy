# RootedVox v4.1.0

RootedVox 是分享日常、交流想法的社区广场。主要功能包括社区留言、公告、个人资料与内容审核。

Cloudflare 主站为 `rv.celestivast.com`，Vercel 站点为 `rv-vc.celestivast.com`。两个部署沿用原有 Keycloak 和 Supabase。部署时按[切换说明](docs/FAILOVER_FIX_20261101.zh-CN.md)填写环境变量，并验证两边的登录和社区数据。

运行 `npm run check` 和 `npm test`。Vercel 另运行 `npm run build:vercel`。

项目使用 Apache-2.0，继承代码和第三方组件的许可见 `LICENSE-MIT-LEGACY` 与 `NOTICE`。
