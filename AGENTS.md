# 开发与部署标准

1. `main` 是唯一生产分支；开发只在功能分支进行，部署前必须合并最新 `origin/main`。
2. 生产只能从与 `origin/main` 一致的干净 `main` 执行 `npm run deploy:production`。
3. 不提交密钥，不覆盖他人改动；Supabase schema 只通过新增 migration 修改。
4. 部署门槛是锁定依赖、类型检查、测试、构建和 Fly 配置校验；发布后核对 `/healthz` 与 revision。
