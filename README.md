# RootedVox v4.1.0

RootedVox is a community forum for sharing updates, ideas and questions.

- Cloudflare: `https://rv.celestivast.com`
- Vercel: `https://rv-vc.celestivast.com`

Both deployments reuse the existing Keycloak realm and Supabase project. Use the existing issuer and user subjects to preserve account mappings. See [deployment notes](docs/FAILOVER_FIX_20261101.zh-CN.md) and [OIDC configuration](docs/OIDC_CLIENT.zh-CN.md).

Run `npm run check` and `npm test` for both repositories. Run `npm run build:vercel` in the Vercel repository.

RootedVox uses Apache-2.0. Inherited and third-party notices are in `NOTICE`.
