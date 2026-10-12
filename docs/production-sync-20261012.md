# Production sync — 2026-10-12

## Verified baseline and reviewed inventory

Collected at 2026-10-12 15:58:25 UTC (10:58:25 America/Chicago). Read-only health check was healthy at deployed source revision `54b3c654b1fbcf0f15030b3cba47434e604ee939`, equal to fetched source main; ancestry passed. Target baseline: `61d6b5d65dd3bf21fe8e5cd02f2eed6928de6945`. Previous sync PR #17 is merged; no unfinished sync PR exists.

| Difference                                                                      | Decision and boundary                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Player chrome / Tesla DPR, source `934cb8c` and `7644356`                       | Selected: client-only scaling function, toolbar/navigation wrappers, CSS, and regression tests. |
| Arrival navigation from PR #17                                                  | Already merged; retain target responsive geometry, map freshness and fallback.                  |
| Display diagnostics, source `a461b48`                                           | Excluded from this batch: no display metrics in URLs or server logs.                            |
| Apple v3/catalog/priority/cache and generic SQL                                 | Deferred as a separate database-backed dependency group.                                        |
| Provider pooling, lookup budgets, artwork recovery/palette                      | Deferred pending lifecycle and cancellation dependency review.                                  |
| Streaming revision frames and lifecycle/shutdown                                | Deferred where mixed with Beta/tenant state.                                                    |
| Registration, login/logout, invites, email/password, accounts, Beta and tenants | Explicitly excluded, including dedicated schema, services, tests, configuration and docs.       |

## Behavior and invariants

The deployed client recognizes the current 1920×1200 center-display geometry within 24 physical pixels plus the Linux x86_64 user-agent marker, and counter-scales controls by DPR. This is a heuristic, not proof of a Tesla device: a matching Linux desktop can also qualify. Ordinary high-DPR desktops outside that profile stay unchanged. Browser visual-viewport scaling applies only to the toolbar/navigation layer; lyrics keep their own font size, timeline and scrolling.

Target adaptation keeps the chrome layer's anchors at the player edges when viewport scaling is active. The existing target map/lyrics separation is retained. Map controls keep the existing compensated hit area. No HTTP/SSE contract, telemetry fields, worker lifecycle, authorization, dependency, migration, deployment configuration or CI threshold changes.

Only independently usable generic code is selected from the deployed tree. No private source history, production data, logs, credentials, environment files or original-workspace untracked files are included.

## Verification and recovery

Node 22 locked `npm ci` and `npm run verify` passed: 981 tests across 56 files, format/lint/typecheck, architecture, web build and standalone worker build. Coverage, five property tests and the unchanged critical mutation gate passed. Ten E2E tests passed, including synthetic DPR 1.53, viewport scale 1.25, mobile and landscape navigation expansion/expiry, clickability and lyrics/map separation. DPR, zoom and mobile screenshots were visually inspected. Runtime dependency audit reports zero vulnerabilities; the full install reports eight development-only findings (one low, three moderate, two high, two critical), not repaired or hidden by this client-only batch. No database changes; the isolated database required check runs in CI. Physical vehicle acceptance is not performed. The exact source upper bound remains unchanged from the previous week.

Rollback: revert the target sync commit; no database rollback or migration is needed. For a display-profile regression, forward-fix the isolated client helper and retain the lyric/map interaction tests.

## 中文说明

本轮只同步已部署的播放器控件缩放：Tesla DPR 与浏览器视觉视口缩放仅影响工具栏和导航层，歌词字号、时间轴及自动滚动保留原有行为。保留目标仓库的地图布局，并补偿缩放层尺寸以维持边缘定位。设备识别是屏幕尺寸加 Linux UA 的启发式规则，不能视为可靠的设备身份识别。显示诊断上报、注册/账号/Beta/租户系统不移植；Apple v3 数据库链路和混合运行时差异继续暂缓。不部署生产，不操作生产数据库。
