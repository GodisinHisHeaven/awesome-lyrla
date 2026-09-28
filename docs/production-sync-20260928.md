# Production alignment — 2026-09-28

## Verified baseline

- Collected: 2026-09-28 16:01 UTC (11:01 America/Chicago).
- Read-only production `/healthz`: healthy; deployed source revision `a8743fba0e34ac2f9c3ccbf01cfd0fc2a5b74c37`, verified as an ancestor of source `origin/main` (also its current tip).
- Target baseline: `ffaa245450f2f93d88cd6c06817ad7d1834458cd`.
- Target PR #6 is merged. No unfinished weekly sync PR exists.
- Port selected file hunks only; do not merge private source history or copy working-tree files.

## Reviewed difference inventory and selected scope

| Area                                                                                                   | Decision | Dependency boundary / source mapping                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lyric clock and automatic scrolling                                                                    | Sync     | `8c12072`: smooth backward reports up to 1 second, preserve seek/pause and lyric-boundary scheduling.                                                                                             |
| Tesla telemetry fields                                                                                 | Sync     | `923130b`: 60-second unchanged media resends; 15-second numeric navigation intervals with native-unit deltas; keep elapsed event-driven at 1 second.                                              |
| Apple maintenance polling                                                                              | Sync     | `a8743fb`: 120-second idle maintenance and queue observation, preserve 1-second active draining and configured backfill cadence.                                                                  |
| Apple v3 serving, catalog route refresh, source priority and cache                                     | Deferred | Coordinated lyrics-service/repository/client/contracts changes plus four SQL migrations and database contracts need a separate bounded sync. Existing Simplified Chinese conversion is preserved. |
| Provider pooling, lookup budgets, artwork recovery and palette work                                    | Deferred | Cross-service cancellation, caching and lifecycle dependencies need independent verification.                                                                                                     |
| Streaming revisions, state patches, lifecycle and shutdown                                             | Deferred | Mixed personal/Beta integration in server entry point; only independently usable self-hosted portions may be ported.                                                                              |
| Display scaling, display diagnostics and generic interface                                             | Deferred | Separate UI/environment behavior review.                                                                                                                                                          |
| Registration, login/logout, invites, email/password workflows, profiles, admission and tenant accounts | Excluded | Dedicated auth/Beta/tenant routes, pages, stores, migrations, RLS, tests, dependencies and docs must stay out.                                                                                    |
| Production deployment/configuration, metrics and private runtime data                                  | Excluded | No production environment files, credentials, logs, user/vehicle/tenant identities or deployment changes.                                                                                         |
| Self-hosted Tesla/Apple authorization, pairing and admin protection                                    | Preserve | Existing target behavior remains; source pairing tied to Beta admission is not copied.                                                                                                            |

The remaining difference categories are not claimed as production-aligned by this batch. Dependency manifests, database schema, CI gates, access control, README language choices, lyrics source priority and worker process topology remain unchanged.

## Invariants, failure modes and rollback

Small backward playback reports must not move the visual clock backward; real seeks, pause/resume, offsets and new tracks must remain responsive. Navigation resends must arrive before the 90-second expiry and cancellation must clear immediately. Empty maintenance queues may wait up to 120 seconds; active queues must resume 1-second draining. The web process and external Apple worker retain their existing independent lifecycle. A self-hosted custom lease shorter than the idle interval can delay expired-job pickup until the next poll.

Rollback is a target-only revert of this sync commit/PR, followed by the same quality gates. No schema or data migration is included and no production deployment is authorized.

## Validation

Local checks on Node 22.23.3 with locked dependencies:

- `npm ci`: passed; manifests and lockfile unchanged.
- `npm run verify`: passed (format, lint, typecheck, architecture, 907 tests across 50 files, web and standalone worker build).
- `npm run test:coverage` and `npm run coverage:diff -- --base ffaa245450f2f93d88cd6c06817ad7d1834458cd --minimum 90`: passed; changed executable lines 77/83 (92.77%).
- `npm run test:property`: 5 passed. `npm run test:mutation:critical`: correctly skipped, no mutation-ready policy changed.
- `npm run test:e2e`: 5 passed against isolated local demo servers, with remote lyrics/palette disabled.
- `npm run test:db`: blocked before database startup because the local Docker daemon is unavailable. No database or migration changes are included; CI must still pass the database gate.
- `npm run security:check`: failed on the unchanged target lockfile: high-severity fast-uri and sharp advisories plus moderate fastify advisories (3 production dependency findings). Dependency repair is separate from the selected source behavior ports; this required check blocks merging.
- Public review: all 11 outgoing files reviewed, including a comparison with a formatted target baseline to separate semantic changes from required Prettier changes. No private history, excluded account modules, credentials, real VIN literals or runtime data added. No tests removed or quality rules relaxed.

Required CI contexts remain static, architecture, unit, critical-quality, database, e2e, build, security. Their final results and merge status are recorded on the PR; do not merge while any required check fails. The repository currently has neither `codex` nor `codex-automation` labels.

## 中文摘要

采集时间为 2026-09-28 16:01 UTC；生产已部署 `a8743fb`，目标基线为 `ffaa245`。本轮仅同步歌词时钟平滑、Tesla 信号重发节奏和 Apple 维护队列空闲轮询。歌词源优先级及缓存迁移、共享服务与流协议、其他通用界面差异留待后续有边界的同步。注册、登录、用户账号、Beta 准入及其专用实现严格排除；自托管授权、设备配对、管理员保护、双语文档和 CI 门槛保留。出现问题可回退目标同步提交，无数据库迁移，也不部署生产。
