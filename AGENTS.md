# 开发与部署标准

1. `main` 是唯一生产分支；开发只在功能分支进行，部署前必须合并最新 `origin/main`。
2. 生产只能从与 `origin/main` 一致的干净 `main` 执行 `npm run deploy:production`。
3. 不提交密钥，不覆盖他人改动；Supabase schema 只通过新增 migration 修改。
4. 部署门槛是锁定依赖、类型检查、测试、构建和 Fly 配置校验；发布后核对 `/healthz` 与 revision。
5. 每个改动必须在功能分支通过 `npm run verify`；涉及数据库时额外运行 `npm run test:db`，涉及用户/API 流程时运行 `npm run test:e2e`。
6. PR 必须说明受影响的不变量、失败模式、验证证据和回滚或 roll-forward 方案；不得绕过 required checks 或未解决的 review conversation。
7. `src/client`、`src/server` 和 `src/shared` 的依赖方向由 `dependency-cruiser.config.cjs` 强制；不要通过禁用规则解决边界错误。
