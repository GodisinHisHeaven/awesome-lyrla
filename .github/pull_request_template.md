## Problem

<!-- Describe the user-visible or operational problem. Link an issue when one exists. -->

## Design and invariants

<!-- Name every invariant this change touches and explain why it remains true. -->

- Invariant(s):
- Rejected alternatives:

## Failure modes

<!-- Include stale data, retries, timeouts, concurrency, partial failure and rollback where relevant. -->

- New or changed failure modes:
- Observability signal:
- Rollback or roll-forward plan:

## Evidence

- [ ] A regression test fails without the fix, or this is a non-behavioral change.
- [ ] `npm run verify` passes.
- [ ] Changed executable lines meet the 90% diff-coverage gate.
- [ ] `npm run test:db` passes when migrations or database contracts are affected.
- [ ] `npm run test:e2e` passes when a user or API flow is affected.
- [ ] No secret, token, VIN, private URL or production data is included.
- [ ] Documentation and migration compatibility are updated where needed.

## Reviewer notes

<!-- Point reviewers to the riskiest lines and the evidence that should be challenged. -->
