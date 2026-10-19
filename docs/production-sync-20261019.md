# Production sync inventory — 2026-10-19

## Verified baselines

- Observation: 2026-10-19 15:56:55 UTC; production health status `ok`.
- Deployed source upper bound: `54b3c654b1fbcf0f15030b3cba47434e604ee939`, equal to freshly fetched source `origin/main`; ancestry verified.
- Target baseline: `e2ead07c5adbec81eb8d552da6d62299351c4ceb`.
- PR #18 is merged at that target baseline; no unfinished weekly sync PR exists.

## Selected behavior and dependency boundary

| Source                                                            | Generic behavior                                                                                                                          | Target scope                                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `d0e8c40bf4d3219a28156a483e5acb4afe5239eb`                        | Resume artwork searches after local quota recovery; reuse validated provider responses, re-evaluate each track; bounded retry diagnostics | Artwork service, player retry scheduling, shared fallback contract, regression tests |
| `7c728ddd3ebbab0670bdeacac7f53cfb7532927d` (artwork portion only) | Reuse exact sRGB byte conversions across spatial palette cells                                                                            | Artwork service and palette equivalence fixture                                      |

The search response cache has a 120-second TTL, 64-entry limit and 1 MiB accounted serialized-byte limit. Failed or invalid provider responses are not cached. Track duration, album, recording version and ambiguity are rechecked for each lookup. Local quota remains 18 searches per 60 seconds. Quota retries wait at least the reported recovery time, bounded to 60 seconds, and retain the existing maximum of three retries. Track changes and disposal cancel scheduled retries.

Only independently usable generic hunks are ported. Source health aggregation tests for Beta instances are excluded; target service-level tests cover the retry counters directly. Shared provider pooling from `79146e0` remains a separate lifecycle change.

## Invariants, exclusions and remaining differences

- Preserve lyric lookup priority, availability, automatic scrolling, target HTTP/SSE behavior and independent Apple worker execution.
- Preserve self-hosted Tesla/Apple authorization, pairing, administrator protection and existing generic access control.
- Exclude registration/login/logout, invitations, email verification/password reset, profile/account management, Beta admission and tenant systems, including dedicated implementation, tests, migrations, configuration and documentation.
- No source history, production data, credentials, environment files, logs or deployment configuration are copied. Original source/target untracked files remain untouched.
- No database, dependency, CI threshold or production deployment changes.
- Deferred: Apple v3/catalog refresh/priority/cache and its database contracts; provider pooling/request budgets; revision stream frames and mixed Beta/tenant lifecycle changes; display diagnostics. Undeployed source branch work remains out of scope.

## Validation

- Node 22.23.3, locked `npm ci`: PASS; no dependency changes.
- `npm run verify`: PASS, including formatting/lint/typecheck, architecture, 993 tests across 56 files, client build and standalone worker build.
- `npm run test:coverage`: PASS; changed executable lines 97/102 = 95.10%, above the unchanged 90% gate.
- `npm run test:property`: 5 PASS. Critical mutation gate skips unchanged mutation-ready policies by design.
- `npm run test:e2e`: 10 PASS using local demo mode with remote database/Apple backfill disabled.
- `npm run security:check`: PASS, zero runtime vulnerabilities. Full install audit still reports eight development-only findings (1 low, 3 moderate, 2 high, 2 critical); this sync does not claim to repair them.
- No schema/storage or SQL change; local database suite is not required for this scope. The required isolated database CI check still gates merge.
- Public-content review: eight files, target-only history, no account system, production data, secrets, logs or configuration. The two artwork files include formatter-required changes; normalized baseline comparison confirms only the selected behavior changed.
- Required native PR checks remain pending publication: static, architecture, unit, critical-quality, database, e2e, build and security. Merge only with the exact tested head, current main, satisfied review rules and no unresolved conversations.
- Physical vehicle acceptance was not performed. No production deployment.

## Rollback

Revert this target sync commit through the normal protected PR workflow. There are no schema changes or persisted search-cache changes to reverse. A forward fix should preserve quota bounds, cancellation and track-specific candidate validation.

## 中文摘要

本轮仅同步已部署的封面限流恢复、短期搜索响应缓存和配色字节转换复用。保留歌词获取、自动滚动、自托管授权及独立 worker；排除注册、账号、Beta、租户系统与生产数据。搜索缓存不保存匹配结论，元数据变化后仍重新验证候选。数据库链路与共享 provider 生命周期留待独立同步。
