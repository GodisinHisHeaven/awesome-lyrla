# Release provenance

## Invariant

A production image identifies exactly one reviewed commit. Local uncommitted work, an unreviewed
branch or a stale copy of `main` cannot become an official release.

## Enforcement

- Production deployment runs only from a clean `main` equal to `origin/main`.
- Locked dependencies, static checks, tests and production builds run before deployment.
- The Git SHA is embedded in the image and returned by `/healthz`.
- The release operator compares the running revision with the intended commit.

Any alternate release path must provide equivalent commit identity and verification evidence before
it can replace the guarded script.
