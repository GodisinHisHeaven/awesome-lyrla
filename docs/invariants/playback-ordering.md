# Playback ordering

## Invariant

A snapshot is accepted only when it follows the current playback epoch. Lyrics from metadata that
contradicts the current track are removed while replacement lyrics are loading. Delayed telemetry or
HTTP responses cannot move the UI back to an older track generation.

## Enforcement

- Track and lyrics generations identify the producing metadata epoch.
- Snapshot revisions are monotonic within a server process.
- The browser rejects older revisions and ambiguous responses from an earlier process.
- Unit tests exercise telemetry bursts, server restarts, stale lyrics and playback-clock evidence.

Changes to ordering or debounce behavior must include out-of-order and restart cases, not only a
happy-path timestamp example.
