# Production alignment — 2026-11-02

Observed 2026-11-02 16:56:10 UTC. Production health is ok at source main
`54b3c654b1fbcf0f15030b3cba47434e604ee939`.
Target baseline: `1c49f5eec52792602e2d673948c5c83f8c705aff` (merged PR #20).

## Reviewed inventory

Selected: Apple catalog subscriber-aware request pooling from deployed source
`79146e02d1e78f018b171e05edc2a50bd9984bcd`, including its standalone pool and tests.
Limit each catalog service to two active searches. Coalesce by search mode,
storefront, metadata and duration. Preserve each subscriber's media source.
Target review adaptation: give every subscriber a five-second budget including queue wait,
so expired queued work is removed. This preserves the previous caller time bound.
Cancel underlying work only after the last subscriber leaves; retain the slot
until the operation settles. Foreground and exhaustive worker queries remain distinct.

Deferred: artwork and lyrics service pooling; Apple v3/catalog priority/cache
schema group; revision streaming and mixed lifecycle changes; display diagnostics.
Already merged: artwork recovery/LUT, player scaling, navigation and media clock.

Excluded: registration/login/logout, invitations, verification/password reset,
profiles/accounts, Beta admission, tenants, and their dedicated implementation,
schema, tests, configuration and documentation. No source history, production data,
identifiers, credentials, environment files or original untracked files are copied.

Invariants: preserve self-hosted Tesla/Apple authorization and admin protection,
lyrics availability and priority, autoscroll, HTTP/SSE and independent Apple worker.
No database, deployment, dependency or CI policy changes.

Rollback: revert this catalog/pool group through a protected PR; no schema or
persistent state changes. Forward fixes must retain cancellation isolation and
bounded concurrency.
