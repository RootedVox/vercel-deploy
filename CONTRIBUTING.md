# 贡献指南 / Contributing

欢迎为 RootedVox 提交修复、功能建议和文档改进。

1. Fork 对应部署仓库，并从 `main` 创建分支。
2. 修改公共页面或业务逻辑时，同步检查 Cloudflare 和 Vercel 版本。
3. 运行 `npm run check` 和 `npm test`。Vercel 另运行 `npm run build:vercel`。
4. 提交 Pull Request，说明改动和验证结果。后台密钥只填部署平台的环境变量。

Open a pull request with a description of the change and the checks you ran.
