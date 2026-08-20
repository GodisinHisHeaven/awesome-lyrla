# System invariants

An invariant is a statement that must remain true across success, retries, partial failures and
process restarts. Pull requests name the invariants they touch and point to executable evidence.

- [Secrets and trust boundaries](secrets-and-trust-boundaries.md)
- [Playback ordering](playback-ordering.md)
- [Lyrics identity and fallback](lyrics-identity.md)
- [Database evolution](database-evolution.md)
- [Release provenance](release-provenance.md)

If a change cannot be explained using an existing invariant, update the relevant document or add an
ADR before merging the new behavior.
