# 论坛查询与审核部署

1. 在共享业务 Supabase 执行 `supabase/20261113_forum_optimization.sql`，排在 20261112 的分区与官方身份迁移之后。两端共用数据库，只需执行一次。迁移可重复执行。
2. 两端设置服务端的 `AUTH_STORE_SUPABASE_SECRET_KEY`、`NVAPI_KEY` 和同一个随机 `FORUM_WORKER_SECRET`。Cloudflare 沿用 `LEXICON_KV`；Vercel 的 `FORUM_LEXICON_WORDS` 填写同一版换行分隔词库。词库或模型不可用时帖子保持待审。
3. 配置一个定时器（例如 Supabase Cron），每分钟向其中一个部署的 `/api/moderation-worker` 发 POST，并从密钥存储设置 `Authorization: Bearer <FORUM_WORKER_SECRET>`。成功返回本轮处理的任务数。发帖请求也尝试在响应后领取本帖任务。定时器负责回收过期租约、重试及消化积压。每次最多领取四条，可按负载调整触发频率。
4. 用待审纯文本、带图帖及模型超时各验收一次。人工审核与自动审核同时处理同帖时，已提交的人工结果优先。词库命中、图片及无法判定的内容均保留人工审核。审核结果计数保存在 `forum_private.review_counts`。自动审核队列只接收迁移后的新文本帖。
5. 两端部署相同业务版本后，验证匿名浏览、跨域通知已读、预览域登录，以及连续翻页和回复深链接。更新 `notice.html` 后运行 `node scripts/sync-home-notices.mjs` 同步首页快照；CI 检查快照和两个部署的共享文件。

### 定时任务示例

若业务库已启用 Supabase Cron、Vault 和 pg_net，在 Vault 创建 `forum_worker_url`（完整 HTTPS 地址）和 `forum_worker_secret` 后，可在 SQL Editor 执行以下语句。定时器只需要在共享库配置一次。它也会回收超过七天仍未被帖子引用的新上传图片。

```sql
select cron.schedule('rootedvox-forum-worker', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='forum_worker_url'),
    headers := jsonb_build_object('Authorization','Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name='forum_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$job$);
```
