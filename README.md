# Awesome Lyrla

**English** | [简体中文](README.zh-CN.md)

A real-time Tesla lyrics interface for personal, self-hosted deployments. It reads playback state from Fleet Telemetry, prioritizes synchronized lyrics, and displays the destination, ETA, remaining distance, and estimated arrival battery when vehicle navigation is active.

## Features

- Real-time playback state from Tesla Fleet Telemetry
- Synchronized lyrics and candidate-version selection from LRCLIB
- Optional Supabase lyrics library, Apple TTML enrichment, and artwork palette cache
- Manual LRC input, timing offsets, and local persistence
- One-time activation for the Tesla browser
- Bounded memory/disk caches and lightweight production telemetry

## Runtime Architecture

- Web: Fastify API, React UI, SSE, and a private MQTT broker
- Tesla: Fleet Telemetry publishes to MQTT; the backend aggregates the current track and playback clock
- Lyrics: local selection → Supabase (optional) → LRCLIB; Apple enrichment runs in the background
- State: personal settings are stored in `DATA_DIR`; shared lyrics can be stored in Supabase

## Local Development

Node.js 22 is required.

```bash
npm ci
cp .env.example .env
npm run dev
```

Demo mode is enabled by default. Open <http://localhost:5173> to preview the application. Common checks:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Contributions must pass independent static-analysis, architecture-boundary, diff-coverage, database-rebuild, end-to-end, and security checks. See the [architecture documentation](docs/architecture.md), [system invariants](docs/invariants/README.md), and [CONTRIBUTING.md](CONTRIBUTING.md) for design principles and contribution requirements.

## Tesla Integration

1. Create an application in the Tesla Developer Portal and set its callback URL to `https://YOUR_DOMAIN/api/tesla/oauth/callback`.
2. Generate a Tesla virtual key:

   ```bash
   npm run tesla:keygen
   ```

3. Generate Fleet Telemetry certificates:

   ```bash
   npm run tesla:certgen -- YOUR_DOMAIN
   ```

4. Copy `deploy/telemetry-config.json.example`, then provide the VIN and the same password used by `MQTT_PASSWORD`.
5. Set `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TELEMETRY_HOST`, and the key-file paths, then start the application with `DEMO_MODE=false`.
6. Open `/setup`, enter the administrator PIN, complete Tesla OAuth, select a vehicle, pair the virtual key, and enable telemetry.
7. Open the same `/setup` page in the Tesla browser, enter the PIN, then select “Activate this vehicle browser and open lyrics.”

The service does not send driving-control commands. Tesla tokens, administrator sessions, and player activation cookies are handled only by the backend.

## Fly.io Deployment

The repository provides a single-application template. The web service, Fleet Telemetry, and vehicle-command proxy run on the same personal instance.

```bash
cp fly.toml.example fly.toml
# Update the app, APP_ORIGIN, TELEMETRY_HOST, region, and volume name
flyctl apps create YOUR_APP
flyctl volumes create awesome_lyrla_data --region ord
```

At minimum, configure these secrets:

```bash
flyctl secrets set \
  SESSION_SECRET='at-least-32-random-characters' \
  ADMIN_PIN='at-least-6-characters' \
  MQTT_PASSWORD='random-password' \
  TESLA_CLIENT_ID='...' \
  TESLA_CLIENT_SECRET='...'
```

The `[[files]]` entries in `fly.toml.example` also require matching secrets for the PEM files, telemetry JSON, and proxy certificate. All local key directories and `fly.toml` are ignored and must never be committed.

Production releases may run only from a clean `main` that exactly matches `origin/main`:

```bash
npm run release:check
npm run deploy:production
```

The scripts perform a locked dependency installation, type checking, unit tests, a production build, migration-file checks, and Fly configuration validation before embedding the current Git SHA in the image.

## Optional Supabase Lyrics Library

Without Supabase configuration, the application uses LRCLIB and its local cache directly. To enable your own lyrics library:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Then set:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=server-only-secret
SUPABASE_LIBRARY_ID=YOUR_LIBRARY_UUID
SUPABASE_LYRICS_MODE=primary
SUPABASE_PALETTE_MODE=primary
```

`SUPABASE_SECRET_KEY` must remain server-side. This project does not use Supabase Auth; its migrations contain only lyrics, Apple TTML, queue, and artwork-palette structures.

## Optional Apple Lyrics Enrichment

Apple enrichment requires Supabase, Apple Music developer credentials, and a media user token. Personal, low-traffic deployments can retain the template's embedded runner, which is disabled by default:

```dotenv
APPLE_LYRICS_BACKFILL_ENABLED=true
APPLE_MUSIC_MEDIA_USER_TOKEN=...
APPLE_MUSIC_TEAM_ID=...
APPLE_MUSIC_KEY_ID=...
APPLE_MUSIC_PRIVATE_KEY_PATH=./secrets/apple-music-private-key.p8
```

The background process stores raw TTML and projects it into the current line-level timeline. If Apple is unavailable, the player still falls back to the LRCLIB version stored in Supabase or queries LRCLIB directly.

## Personal Data and Backups

- `DATA_DIR` contains Tesla tokens, the selected vehicle, lyrics offsets, manual lyrics, and caches.
- Fly deployments should use a persistent volume and regular backups.
- The Supabase schema must change only through additive migrations.
- Never commit `.env`, `fly.toml`, PEM files, tokens, or telemetry configuration.
