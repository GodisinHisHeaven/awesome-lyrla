# Contributing to Awesome Lyrla

Awesome Lyrla accepts changes that are understandable, testable and safe to operate. The same
evidence is required whether code was written manually, generated with an assistant or adapted
from another project.

## Development setup

Use Node.js 22 and install the exact locked dependency graph:

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

Create a feature branch from the latest `main`. Direct pushes to `main`, force pushes and merging
around failed checks are not part of the contribution workflow.

## Required local evidence

Run this before opening a pull request:

```bash
npm run verify
npm run test:e2e
npm run security:check
```

When database contracts or migrations are affected, also run:

```bash
npm run test:db
```

`test:db` resets the **local** Supabase database, replays every migration and executes every SQL
file in `supabase/tests`. It never targets a linked project, but it will replace local development
data.

The CI jobs and their intent are documented in [docs/quality-gates.md](docs/quality-gates.md).

## Definition of done

A change is eligible to merge only when all of the following are true:

1. The problem and the rejected alternatives are explained in the pull request.
2. Every affected [system invariant](docs/invariants/README.md) is named.
3. A regression test demonstrates behavioral fixes. New executable lines meet the diff-coverage
   threshold.
4. Timeout, retry, stale-data, ordering and partial-failure behavior are considered where relevant.
5. Database changes are append-only migrations and pass a clean replay plus SQL contract tests.
6. User-facing or API-flow changes have integration or end-to-end evidence.
7. The change has an observable success/failure signal and a rollback or roll-forward plan.
8. Required checks pass, review conversations are resolved and, once an independent maintainer is
   available, the responsible code owner approves.

Passing tests is necessary, not sufficient. Reviewers should reject changes that duplicate policy,
hide important failure modes, weaken trust boundaries or make the system harder to explain.

## Critical paths

Changes in these areas receive additional scrutiny:

- `.github/workflows`, release scripts, Docker and deployment configuration
- Tesla OAuth, token storage, command proxy and telemetry ingestion
- playback ordering, snapshot revisions and stale-lyrics prevention
- lyrics version matching and provider fallbacks
- Supabase migrations, privileged functions and server-only credentials
- shared client/server contracts

Pure policy modules listed in `stryker.config.json` use mutation testing. A pull request touching one
of them automatically triggers the critical mutation gate.

## Database changes

- Create schema changes only as a new timestamped migration.
- Never edit a migration already deployed to a shared environment.
- Keep privileged helpers out of exposed schemas unless they are intentionally public APIs.
- Do not expose a Supabase secret key, Tesla token, VIN or production fixture in tests or logs.
- Update or add a SQL test that fails against the previous schema and succeeds after the migration.

## Pull requests

Keep pull requests focused. If a reviewer cannot describe the change and its failure modes after one
pass, split it. Large generated rewrites, unrelated formatting and dependency churn should not be
mixed with behavioral changes.

Review approval means the reviewer has challenged the design and verified the evidence; it is not a
signal that the diff merely looks plausible.
