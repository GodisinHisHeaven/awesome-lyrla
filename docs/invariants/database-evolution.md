# Database evolution

## Invariant

The complete database is reproducible from the ordered migration history, and a migration already
shared or deployed is immutable.

## Enforcement

- New schema changes use a unique 14-digit timestamped migration filename.
- `npm run test:db` starts or reuses only the local Supabase stack, resets it, replays every migration
  and executes every SQL contract test.
- Production releases check migration naming before deployment.
- Database tests run in a transaction and clean up their fixture state.

Changing database behavior requires a new migration plus a test that proves the intended contract on
a freshly reconstructed schema.
