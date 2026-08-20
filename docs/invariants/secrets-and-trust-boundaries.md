# Secrets and trust boundaries

## Invariant

Tesla tokens, private keys, administrator authorization, VINs, MQTT passwords and Supabase secret
keys are server-only. Browser responses and bundles contain only the minimum display state needed by
the current screen.

## Enforcement

- Dependency rules prevent client imports from `src/server`.
- Sensitive configuration has no `VITE_` prefix and is read only by the server.
- Administrator and player activation cookies are signed, HTTP-only and production-secure.
- Pull requests and tests may not contain real credentials or production fixtures.

Any new browser-visible field requires an explicit privacy review in the pull request.
