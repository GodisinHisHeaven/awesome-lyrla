# Lyrics identity and fallback

## Invariant

Lyrics are attached only to a sufficiently identified recording or an explicitly selected fallback.
Provider failure, ambiguity and a genuine miss remain distinct outcomes. The system does not lower
matching confidence merely to display some lyrics.

## Enforcement

- Exact and work fingerprints preserve recording-version evidence.
- Live, acoustic, remix, instrumental and other version tags cannot silently collapse together.
- Retryable provider failures are not persisted as durable negative matches.
- Apple timing anomalies are quarantined or downgraded instead of trusted.
- Property and mutation tests challenge normalization, lookup and timeline boundaries.

Every change to matching weights, version parsing or provider fallback requires positive, negative
and ambiguous examples.
