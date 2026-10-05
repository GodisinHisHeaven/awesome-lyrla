# Production sync — 2026-10-05

## Verified baseline and reviewed inventory

Collected 2026-10-05 16:02–16:03 UTC (11:02–11:03 America/Chicago). Read-only production health reported `ok`, revision `54b3c654b1fbcf0f15030b3cba47434e604ee939`, web process, external Apple worker mode. This revision equals fetched source `origin/main`; ancestry verified. Target baseline: `494e4c6cf4e99174174eeaee77cdd2e353deba5f`. PR #15 merged normally on October 1; its clock, signal cadence and idle maintenance changes are already present. No unfinished sync PR exists.

| Difference                                                                                | Decision and boundary                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Arrival map: 83493e3, bb08e9d, 16677be, d7dfc53, bca9ed8, 54b3c65                         | Port the complete runtime dependency group: optional contracts, telemetry fields, in-memory state, bounded decoder, geometry, motion, card and player integration, regression tests. |
| Source map design gallery and App routes                                                  | Omit the design alternatives; verify through the existing player and target tests.                                                                                                   |
| Source player control/DPR scaling                                                         | Defer; use existing target layout with scale defaults.                                                                                                                               |
| Apple v3 catalog/priority/cache and SQL                                                   | Defer as a separate database-backed batch. Existing Simplified conversion and lyric serving remain intact.                                                                           |
| Shared provider pooling, request budgets, artwork recovery                                | Defer pending cancellation/cache/lifecycle dependency review.                                                                                                                        |
| Revision streaming and runtime lifecycle                                                  | Defer mixed Beta/tenant modules; target stream protocol remains intact.                                                                                                              |
| Registration, accounts, invitations, password/email, Beta admission and tenant management | Exclude all dedicated implementation, tests, dependencies, schema, configuration and documentation.                                                                                  |
| Source feature branch / undeployed changes                                                | Exclude; deployed source-main revision is the upper bound.                                                                                                                           |

## Invariants and failure modes

- Map data is optional and ephemeral. Invalid or stale maps must preserve text navigation, lyrics, clock and automatic scrolling. No new persistence or schema.
- Decode only bounded routes; clear on cancellation, destination or vehicle change. Keep a route only while matching fresh trip/location evidence confirms it.
- Display only supplied route geometry; interpolate observed positions without forecasting. Reduced motion, hidden tabs, stale data and jumps stop transitions.
- Keep Tesla/Apple self-hosted authorization, pairing, administrator protection and generic access control. No account system or private source history is imported.
- Apple worker lifecycle, package dependencies, production configuration and CI thresholds remain unchanged.
- No production deployment, database operation, user data, raw health output or telemetry logs are published. New test fixtures are synthetic.

## Validation

Local validation (Node 22.23.3, locked `npm ci`):

- `npm run verify` passed: formatting, lint, TypeScript, architecture boundaries, 971 tests in 55 files, frontend and standalone worker builds.
- `npm run test:coverage` passed; changed-line coverage **512/534 = 95.88%**, above the unchanged 90% gate.
- `npm run test:property`: 5 passed. Critical mutation gate correctly skipped unchanged mutation-ready policies.
- `npm run security:check`: zero runtime dependency vulnerabilities. The full install audit reported five development-only findings; no runtime dependency or audit exemption was changed.
- `npm run test:e2e`: 8 passed with local demo servers, remote lyrics/palette providers disabled and synthetic map tiles. Desktop 1440×900, portrait 390×844 and short landscape 960×480 screenshots were inspected; lyrics and map remain separate. Physical vehicle acceptance is not claimed.
- No database/schema changes; the required database rebuild will run in isolated GitHub CI. No production database was accessed.
- Pending PR checks: static, architecture, unit, critical-quality, database, e2e, build and security. Merge also requires current main and no unresolved conversations.

Target adaptations: preserve its full-snapshot HTTP/SSE protocol, declare Vite browser environment types, satisfy existing hook-dependency lint, and reserve actual unscaled card space in the expanded layout. The source design gallery, DPR controls and account routes were not copied. Existing files were formatted where the target formatting gate requires it; normalized comparisons verified the player and service changes remain navigation-only.

Publication review covers all changed files and the target-only commit chain: no source history, registration/account implementation, credentials, production configuration, raw health output, logs or user records. Tests use synthetic route fixtures and placeholder vehicle identifiers.

## Rollback / forward fix

Revert the target sync commit through the normal protected PR process. No migration rollback is needed. Existing vehicle telemetry configurations can continue sending the additional fields; old code ignores them. Tile-provider changes require rebuilding the public frontend. Fix decoding or freshness defects with focused regression tests without weakening lyric or navigation fallback.

## 中文摘要

本轮仅同步已部署的临近到达地图：遥测、路线解码与保留、位置平滑和播放器展开卡片。保留开源自托管授权及后台 worker，不引入注册、Beta 或租户系统。地图失效时保留歌词和有效文字导航。Apple v3/数据库、共享资源池及混合租户模块留待独立批次。
