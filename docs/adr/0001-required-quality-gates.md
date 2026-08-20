# ADR 0001: Evidence-based merge gates

- Status: accepted
- Date: 2026-08-19

## Context

Plausible code and a green build do not prove correct behavior across telemetry ordering, provider
fallbacks, database evolution or secret boundaries. One monolithic CI job also makes failures hard
to diagnose and easy to treat as incidental.

## Decision

Protect `main` with pull requests and independent required checks for static analysis, architecture,
unit/diff coverage, critical policy quality, database reconstruction, end-to-end behavior, production
build and dependency security. Require explicit design, failure-mode and rollback evidence in every
pull request.

## Consequences

- Contributors get precise feedback about missing evidence.
- Critical policy changes cost more CI time because they trigger mutation testing.
- Database contributors need Docker and the pinned Supabase CLI locally.
- A second trusted maintainer is required before code-owner approval can be enforced without a sole
  owner bypass.
