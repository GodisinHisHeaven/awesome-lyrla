# Quality gates

Every pull request must pass the following independent GitHub checks. They are deliberately split so
that a failure identifies the missing evidence instead of hiding inside one long command.

| Check              | Evidence                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `static`           | Changed-file formatting, ESLint with zero warnings and strict TypeScript                   |
| `architecture`     | No forbidden dependency direction, test import or cycle                                    |
| `unit`             | Full Vitest suite, LCOV output and at least 90% coverage of changed executable lines       |
| `critical-quality` | Property tests on every run; mutation tests when a mutation-ready policy changes           |
| `database`         | Fresh local Supabase stack, full migration replay and all SQL contract tests               |
| `e2e`              | Real Fastify + Vite demo stack, health revision, player/API/SSE and setup access contracts |
| `build`            | Production client and Node server bundles                                                  |
| `security`         | No high-severity vulnerability in the production dependency graph                          |

## Why diff coverage

A legacy global coverage percentage can remain green while a new branch is completely untested.
`scripts/check-diff-coverage.mjs` intersects Git changed lines with Vitest's LCOV executable lines and
requires 90% coverage for that diff. Type-only and non-executable lines do not distort the result.

## Why mutation tests are targeted

Mutation testing is expensive and most valuable for dense policy code. The required PR gate runs it
when one of the modules in `stryker.config.json` changes. A scheduled weekly CI run executes the full
critical mutation set to detect test-suite erosion even without a matching source diff.

## Branch rules

The `main` ruleset should require a pull request, all eight checks above, resolved conversations and
up-to-date branches or a merge queue. Force pushes and branch deletion are blocked. Code-owner review
should be required once at least two trusted maintainers can review one another; a sole owner cannot
approve their own pull request on GitHub.

Rules protect the upstream repository. A fork owner can change their own rules, so correctness comes
from evidence rather than from attempting to restrict forks.
