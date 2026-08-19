import path from 'node:path';

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, integer(value, fallback)));
}

function storefronts(value: string | undefined, fallback: string[]): string[] {
  const candidates = value === undefined ? fallback : value.split(',');
  return [...new Set(candidates
    .map((candidate) => candidate.trim().toUpperCase())
    .filter((candidate) => /^[A-Z]{2}$/.test(candidate)))]
    .slice(0, 5);
}

function languageTag(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,34}$/.test(normalized)
    ? normalized
    : fallback;
}

export type SupabaseLyricsMode = 'off' | 'shadow' | 'primary';
export type SupabasePaletteMode = 'off' | 'shadow' | 'primary';
export type AppleLyricsRunnerMode = 'embedded' | 'external';
export type ProductionProcessGroup = 'app' | 'apple_worker';

function supabaseLyricsMode(value: string | undefined): SupabaseLyricsMode {
  const normalized = (value ?? 'off').trim().toLowerCase();
  if (normalized === 'off' || normalized === 'shadow' || normalized === 'primary') {
    return normalized;
  }
  throw new Error('SUPABASE_LYRICS_MODE must be off, shadow, or primary');
}

function supabasePaletteMode(
  value: string | undefined,
): SupabasePaletteMode {
  const normalized = (value ?? 'off').trim().toLowerCase();
  if (
    normalized === 'off'
    || normalized === 'shadow'
    || normalized === 'primary'
  ) return normalized;
  throw new Error('SUPABASE_PALETTE_MODE must be off, shadow, or primary');
}

function appleLyricsRunnerMode(value: string | undefined): AppleLyricsRunnerMode {
  const normalized = (value ?? 'embedded').trim().toLowerCase();
  if (normalized === 'embedded' || normalized === 'external') return normalized;
  throw new Error('APPLE_LYRICS_RUNNER_MODE must be embedded or external');
}

const root = process.cwd();
const isProduction = process.env.NODE_ENV === 'production';
const lrclibRequestTimeoutMs = boundedInteger(
  process.env.LRCLIB_REQUEST_TIMEOUT_MS,
  12_000,
  1_000,
  30_000,
);
const lrclibLookupBudgetMs = Math.max(
  lrclibRequestTimeoutMs,
  boundedInteger(
    process.env.LRCLIB_LOOKUP_BUDGET_MS,
    18_000,
    1_000,
    45_000,
  ),
);
const appleLyricsRequestTimeoutMs = boundedInteger(
  process.env.APPLE_LYRICS_REQUEST_TIMEOUT_MS,
  10_000,
  1_000,
  30_000,
);
const appleLyricsLeaseSeconds = boundedInteger(
  process.env.APPLE_LYRICS_LEASE_SECONDS,
  300,
  30,
  900,
);
const appleMusicFallbackStorefronts = storefronts(
  process.env.APPLE_MUSIC_FALLBACK_STOREFRONTS,
  ['CN', 'TW', 'HK'],
);

export const config = {
  isProduction,
  processGroup: process.env.FLY_PROCESS_GROUP?.trim() ?? '',
  port: integer(process.env.PORT, 8791),
  appOrigin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  revision: process.env.APP_REVISION ?? 'development',
  dataDir: path.resolve(root, process.env.DATA_DIR ?? './data'),
  sessionSecret:
    process.env.SESSION_SECRET ??
    (isProduction ? '' : 'awesome-lyrla-development-secret'),
  adminPin: process.env.ADMIN_PIN ?? (isProduction ? '' : '2468'),
  demoMode: boolean(process.env.DEMO_MODE, !isProduction),
  lyrics: {
    lrclibRequestTimeoutMs,
    lrclibLookupBudgetMs,
    memoryCacheMaxEntries: boundedInteger(
      process.env.LYRICS_MEMORY_CACHE_MAX_ENTRIES,
      300,
      0,
      5_000,
    ),
    memoryCacheMaxBytes: boundedInteger(
      process.env.LYRICS_MEMORY_CACHE_MAX_BYTES,
      4 * 1_024 * 1_024,
      0,
      64 * 1_024 * 1_024,
    ),
    legacyCacheMaxEntries: boundedInteger(
      process.env.LYRICS_LEGACY_CACHE_MAX_ENTRIES,
      300,
      0,
      5_000,
    ),
    legacyCacheMaxBytes: boundedInteger(
      process.env.LYRICS_LEGACY_CACHE_MAX_BYTES,
      8 * 1_024 * 1_024,
      0,
      64 * 1_024 * 1_024,
    ),
  },
  supabase: {
    lyricsMode: supabaseLyricsMode(process.env.SUPABASE_LYRICS_MODE),
    paletteMode: supabasePaletteMode(
      process.env.SUPABASE_PALETTE_MODE,
    ),
    url: (process.env.SUPABASE_URL ?? '').replace(/\/$/, ''),
    secretKey: process.env.SUPABASE_SECRET_KEY ?? '',
    libraryId: process.env.SUPABASE_LIBRARY_ID ?? '',
    requestTimeoutMs: boundedInteger(
      process.env.SUPABASE_REQUEST_TIMEOUT_MS,
      400,
      100,
      5_000,
    ),
    shadowRequestTimeoutMs: boundedInteger(
      process.env.SUPABASE_SHADOW_REQUEST_TIMEOUT_MS,
      800,
      100,
      5_000,
    ),
    paletteReadTimeoutMs: boundedInteger(
      process.env.SUPABASE_PALETTE_READ_TIMEOUT_MS,
      500,
      100,
      2_000,
    ),
    writeTimeoutMs: boundedInteger(
      process.env.SUPABASE_WRITE_TIMEOUT_MS,
      3_000,
      250,
      15_000,
    ),
  },
  appleMusic: {
    developerToken: process.env.APPLE_MUSIC_DEVELOPER_TOKEN ?? '',
    teamId: process.env.APPLE_MUSIC_TEAM_ID ?? '',
    keyId: process.env.APPLE_MUSIC_KEY_ID ?? '',
    privateKeyPath: process.env.APPLE_MUSIC_PRIVATE_KEY_PATH
      ? path.resolve(root, process.env.APPLE_MUSIC_PRIVATE_KEY_PATH)
      : '',
    storefront: (process.env.APPLE_MUSIC_STOREFRONT ?? 'us').toLowerCase(),
    fallbackStorefronts: [...appleMusicFallbackStorefronts],
  },
  appleLyrics: {
    enabled: boolean(process.env.APPLE_LYRICS_BACKFILL_ENABLED, false),
    runnerMode: appleLyricsRunnerMode(process.env.APPLE_LYRICS_RUNNER_MODE),
    embeddedCompatibility: boolean(
      process.env.APPLE_LYRICS_EMBEDDED_COMPATIBILITY,
      false,
    ),
    mediaUserToken: process.env.APPLE_MUSIC_MEDIA_USER_TOKEN ?? '',
    webBearerToken: process.env.APPLE_MUSIC_WEB_BEARER_TOKEN ?? '',
    locale: languageTag(process.env.APPLE_LYRICS_LOCALE, 'und'),
    requestTimeoutMs: appleLyricsRequestTimeoutMs,
    pollIntervalMs: boundedInteger(
      process.env.APPLE_LYRICS_POLL_INTERVAL_MS,
      15_000,
      1_000,
      300_000,
    ),
    leaseSeconds: appleLyricsLeaseSeconds,
    jobDeadlineMs: boundedInteger(
      process.env.APPLE_LYRICS_JOB_DEADLINE_MS,
      210_000,
      1_000,
      895_000,
    ),
    cleanupGraceMs: boundedInteger(
      process.env.APPLE_LYRICS_CLEANUP_GRACE_MS,
      35_000,
      1_000,
      120_000,
    ),
    healthPort: boundedInteger(
      process.env.APPLE_LYRICS_WORKER_HEALTH_PORT,
      8_792,
      1_024,
      65_535,
    ),
    maxAttempts: boundedInteger(
      process.env.APPLE_LYRICS_MAX_ATTEMPTS,
      5,
      1,
      20,
    ),
    concurrency: boundedInteger(
      process.env.APPLE_LYRICS_CONCURRENCY,
      1,
      1,
      1,
    ),
  },
  artwork: {
    appleStorefront: (process.env.APPLE_MUSIC_STOREFRONT ?? 'us').toUpperCase(),
    appleFallbackStorefronts: [...appleMusicFallbackStorefronts],
  },
  tesla: {
    clientId: process.env.TESLA_CLIENT_ID ?? '',
    clientSecret: process.env.TESLA_CLIENT_SECRET ?? '',
    audience:
      process.env.TESLA_AUDIENCE ?? 'https://fleet-api.prd.na.vn.cloud.tesla.com',
    authBase: process.env.TESLA_AUTH_BASE ?? 'https://auth.tesla.com/oauth2/v3',
    tokenUrl:
      process.env.TESLA_TOKEN_URL ??
      'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
    publicKeyPath: path.resolve(
      root,
      process.env.TESLA_PUBLIC_KEY_PATH ?? './secrets/tesla-public-key.pem',
    ),
    privateKeyPath: path.resolve(
      root,
      process.env.TESLA_PRIVATE_KEY_PATH ?? './secrets/tesla-private-key.pem',
    ),
    allowedVin: process.env.TESLA_ALLOWED_VIN ?? '',
    commandProxyUrl: process.env.TESLA_COMMAND_PROXY_URL ?? '',
  },
  telemetry: {
    host: process.env.TELEMETRY_HOST ?? '',
    port: integer(process.env.TELEMETRY_PORT, 443),
    caPath: path.resolve(root, process.env.TELEMETRY_CA_PATH ?? './secrets/telemetry-ca.pem'),
    mqttPort: integer(process.env.MQTT_PORT, 1883),
    mqttUsername: process.env.MQTT_USERNAME ?? 'awesome-lyrla',
    mqttPassword: process.env.MQTT_PASSWORD ?? (isProduction ? '' : 'awesome-lyrla-local'),
    mqttTopicBase: process.env.MQTT_TOPIC_BASE ?? 'awesome-lyrla',
  },
};

export function validateProductionConfig(): string[] {
  if (!config.isProduction) return [];
  const missing: string[] = [];
  if (!/^[0-9a-f]{40}$/i.test(config.revision)) {
    missing.push('APP_REVISION (40-character Git SHA)');
  }
  if (config.sessionSecret.length < 32) missing.push('SESSION_SECRET (minimum 32 characters)');
  if (config.adminPin.length < 6) {
    missing.push('ADMIN_PIN (minimum 6 characters)');
  }
  if (!config.telemetry.mqttPassword) missing.push('MQTT_PASSWORD');
  if (
    config.supabase.lyricsMode !== 'off' ||
    config.supabase.paletteMode !== 'off'
  ) {
    if (!config.supabase.url.startsWith('https://')) missing.push('SUPABASE_URL (HTTPS)');
    if (!config.supabase.secretKey) missing.push('SUPABASE_SECRET_KEY');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      config.supabase.libraryId,
    )) missing.push('SUPABASE_LIBRARY_ID (UUID)');
  }
  if (config.supabase.lyricsMode !== 'off') {
    const leaseMs = config.appleLyrics.leaseSeconds * 1_000;
    const cleanupReserveMs = Math.max(
      config.appleLyrics.requestTimeoutMs,
      config.supabase.writeTimeoutMs,
    );
    if (
      config.appleLyrics.jobDeadlineMs
      + config.appleLyrics.cleanupGraceMs
      + cleanupReserveMs
      >= leaseMs
    ) {
      missing.push(
        'APPLE_LYRICS_JOB_DEADLINE_MS + cleanup grace '
        + '(must leave one dependency timeout before lease expiry)',
      );
    }
    if (config.appleLyrics.cleanupGraceMs <= 10_000) {
      missing.push(
        'APPLE_LYRICS_CLEANUP_GRACE_MS (must exceed the 10000ms lease finalization budget)',
      );
    }
  }
  if (config.appleLyrics.enabled) {
    if (config.supabase.lyricsMode === 'off') {
      missing.push('SUPABASE_LYRICS_MODE (shadow or primary for Apple backfill)');
    }
    if (!config.appleLyrics.mediaUserToken) {
      missing.push('APPLE_MUSIC_MEDIA_USER_TOKEN');
    }
    if (
      !config.appleMusic.developerToken
      && !(
        config.appleMusic.teamId
        && config.appleMusic.keyId
        && config.appleMusic.privateKeyPath
      )
    ) {
      missing.push('Apple Music developer credentials');
    }
  }
  if (
    config.appleLyrics.runnerMode === 'embedded'
    && !config.appleLyrics.embeddedCompatibility
  ) {
    missing.push('APPLE_LYRICS_EMBEDDED_COMPATIBILITY (required for embedded production)');
  }
  if (
    config.appleLyrics.runnerMode === 'external'
    && config.appleLyrics.embeddedCompatibility
  ) {
    missing.push('APPLE_LYRICS_EMBEDDED_COMPATIBILITY (must be false for external production)');
  }
  return missing;
}

export function validateProductionProcessGroup(
  expected: ProductionProcessGroup,
  options: { required?: boolean } = {},
): string[] {
  if (!config.isProduction) return [];
  if (!config.processGroup) {
    return options.required
      ? [`FLY_PROCESS_GROUP (${expected} required for this entrypoint)`]
      : [];
  }
  if (config.processGroup === expected) return [];
  return [`FLY_PROCESS_GROUP (${expected} required for this entrypoint)`];
}

export function teslaDeveloperAppConfigured(): boolean {
  return Boolean(config.tesla.clientId && config.tesla.clientSecret);
}
