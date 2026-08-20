# Awesome Lyrla

面向个人自用部署的 Tesla 实时歌词界面。它读取 Fleet Telemetry 的播放状态，优先展示同步歌词，并在车辆导航开启时显示目的地、ETA、剩余里程和预计到达电量。

## 功能

- Tesla Fleet Telemetry 实时播放状态
- LRCLIB 同步歌词与候选版本选择
- 可选 Supabase 歌词库、Apple TTML 补充和配色缓存
- 手动 LRC、时间偏移与本地持久化
- Tesla 浏览器的一次性激活
- 有上限的内存/磁盘缓存与轻量生产遥测

## 运行结构

- Web：Fastify API、React 页面、SSE 和私有 MQTT broker
- Tesla：Fleet Telemetry 写入 MQTT，后端聚合当前歌曲和播放时钟
- 歌词：本地选择 → Supabase（可选）→ LRCLIB；Apple 补充在后台执行
- 状态：个人设置保存在 `DATA_DIR`，共享歌词可保存在 Supabase

## 本地启动

需要 Node.js 22。

```bash
npm ci
cp .env.example .env
npm run dev
```

默认是演示模式，打开 <http://localhost:5173> 即可预览。常用检查：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

贡献必须通过独立的静态分析、架构边界、diff coverage、数据库重建、端到端和安全检查。
设计原则与提交标准见 [架构文档](docs/architecture.md)、
[系统不变量](docs/invariants/README.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Tesla 接入

1. 在 Tesla Developer Portal 创建应用，将回调地址设为
   `https://YOUR_DOMAIN/api/tesla/oauth/callback`。
2. 生成 Tesla virtual key：

   ```bash
   npm run tesla:keygen
   ```

3. 生成 Fleet Telemetry 证书：

   ```bash
   npm run tesla:certgen -- YOUR_DOMAIN
   ```

4. 复制 `deploy/telemetry-config.json.example`，填写 VIN 和与
   `MQTT_PASSWORD` 相同的密码。
5. 设置 `TESLA_CLIENT_ID`、`TESLA_CLIENT_SECRET`、`TELEMETRY_HOST`
   和密钥文件，然后以 `DEMO_MODE=false` 启动。
6. 打开 `/setup`，用管理员 PIN 完成 Tesla OAuth、选择车辆、配对虚拟钥匙并启用遥测。
7. 在 Tesla 浏览器打开同一个 `/setup`，输入 PIN 后点击“激活此车机并打开歌词”。

服务不会发送驾驶控制命令。Tesla token、管理员会话和播放器激活 cookie 只由后端处理。

## Fly.io 部署

仓库提供一个单应用模板；Web、Fleet Telemetry 和 vehicle-command proxy 运行在同一台个人实例中。

```bash
cp fly.toml.example fly.toml
# 修改 app、APP_ORIGIN、TELEMETRY_HOST、region 和 volume 名称
flyctl apps create YOUR_APP
flyctl volumes create awesome_lyrla_data --region ord
```

至少设置这些 secrets：

```bash
flyctl secrets set \
  SESSION_SECRET='至少32位随机值' \
  ADMIN_PIN='至少6位' \
  MQTT_PASSWORD='随机密码' \
  TESLA_CLIENT_ID='...' \
  TESLA_CLIENT_SECRET='...'
```

`fly.toml.example` 中的 `[[files]]` 还需要对应的 PEM、telemetry JSON 和代理证书 secrets。所有本地密钥目录与 `fly.toml` 都已忽略，不能提交。

生产发布只能从与 `origin/main` 完全一致的干净 `main` 执行：

```bash
npm run release:check
npm run deploy:production
```

脚本会执行锁定依赖安装、类型检查、单元测试、生产构建、migration 文件检查和 Fly 配置校验，再把当前 Git SHA 写入镜像。

## 可选 Supabase 歌词库

不配置 Supabase 时，应用直接使用 LRCLIB 和本地缓存。要启用自己的歌词库：

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

然后设置：

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=server-only-secret
SUPABASE_LIBRARY_ID=YOUR_LIBRARY_UUID
SUPABASE_LYRICS_MODE=primary
SUPABASE_PALETTE_MODE=primary
```

`SUPABASE_SECRET_KEY` 只能存在于服务端。这个项目不使用 Supabase Auth；migration 只包含歌词、Apple TTML、队列和配色结构。

## 可选 Apple 歌词补充

Apple 补充需要 Supabase、Apple Music developer credentials 和 media user token。个人低流量部署可以保留模板中的 embedded runner；默认关闭：

```dotenv
APPLE_LYRICS_BACKFILL_ENABLED=true
APPLE_MUSIC_MEDIA_USER_TOKEN=...
APPLE_MUSIC_TEAM_ID=...
APPLE_MUSIC_KEY_ID=...
APPLE_MUSIC_PRIVATE_KEY_PATH=./secrets/apple-music-private-key.p8
```

后台会保存原始 TTML，并投影成当前行级时间轴。播放器仍会在 Apple 不可用时回退到 Supabase 中的 LRCLIB 版本或直接查询 LRCLIB。

## 个人数据与备份

- `DATA_DIR` 包含 Tesla token、选中车辆、歌词偏移、手动歌词和缓存。
- Fly 部署应使用持久 volume，并定期备份。
- Supabase schema 只通过新增 migration 修改。
- 不要提交 `.env`、`fly.toml`、PEM、token 或 telemetry 配置。
