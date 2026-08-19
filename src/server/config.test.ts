import { afterEach, describe, expect, it, vi } from 'vitest';

async function productionConfigErrors(revision: string): Promise<string[]> {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('APP_REVISION', revision);
  vi.stubEnv('SESSION_SECRET', 's'.repeat(32));
  vi.stubEnv('ADMIN_PIN', '123456');
  vi.stubEnv('MQTT_PASSWORD', 'mqtt-password');
  vi.stubEnv('SUPABASE_LYRICS_MODE', 'off');
  vi.stubEnv('SUPABASE_PALETTE_MODE', 'off');
  vi.stubEnv('APPLE_LYRICS_RUNNER_MODE', 'external');
  const { validateProductionConfig } = await import('./config.js');
  return validateProductionConfig();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('production revision validation', () => {
  it('accepts a full Git commit SHA', async () => {
    await expect(productionConfigErrors('a'.repeat(40))).resolves.toEqual([]);
  });

  it('rejects an untraceable production image', async () => {
    await expect(productionConfigErrors('unknown')).resolves.toContain(
      'APP_REVISION (40-character Git SHA)',
    );
  });
});

describe('LRCLIB timing configuration', () => {
  it('uses a 12 second request timeout and an 18 second shared lookup budget by default', async () => {
    vi.stubEnv('LRCLIB_REQUEST_TIMEOUT_MS', '');
    vi.stubEnv('LRCLIB_LOOKUP_BUDGET_MS', '');
    vi.resetModules();

    const { config } = await import('./config.js');

    expect(config.lyrics.lrclibRequestTimeoutMs).toBe(12_000);
    expect(config.lyrics.lrclibLookupBudgetMs).toBe(18_000);
  });

  it('never lets the shared lookup budget be shorter than one request', async () => {
    vi.stubEnv('LRCLIB_REQUEST_TIMEOUT_MS', '25000');
    vi.stubEnv('LRCLIB_LOOKUP_BUDGET_MS', '5000');
    vi.resetModules();

    const { config } = await import('./config.js');

    expect(config.lyrics.lrclibRequestTimeoutMs).toBe(25_000);
    expect(config.lyrics.lrclibLookupBudgetMs).toBe(25_000);
  });
});

describe('Supabase timing configuration', () => {
  it('keeps independent bounded budgets for lyrics, shadow, and palette reads', async () => {
    vi.stubEnv('SUPABASE_REQUEST_TIMEOUT_MS', '');
    vi.stubEnv('SUPABASE_SHADOW_REQUEST_TIMEOUT_MS', '');
    vi.stubEnv('SUPABASE_PALETTE_READ_TIMEOUT_MS', '');
    vi.resetModules();

    const { config } = await import('./config.js');

    expect(config.supabase.requestTimeoutMs).toBe(400);
    expect(config.supabase.shadowRequestTimeoutMs).toBe(800);
    expect(config.supabase.paletteReadTimeoutMs).toBe(500);
  });

  it('clamps each read timeout to its supported range', async () => {
    vi.stubEnv('SUPABASE_REQUEST_TIMEOUT_MS', '50');
    vi.stubEnv('SUPABASE_SHADOW_REQUEST_TIMEOUT_MS', '9000');
    vi.stubEnv('SUPABASE_PALETTE_READ_TIMEOUT_MS', '9000');
    vi.resetModules();

    const { config } = await import('./config.js');

    expect(config.supabase.requestTimeoutMs).toBe(100);
    expect(config.supabase.shadowRequestTimeoutMs).toBe(5_000);
    expect(config.supabase.paletteReadTimeoutMs).toBe(2_000);
  });
});

describe('Supabase palette mode configuration', () => {
  it('supports primary read-through mode', async () => {
    vi.stubEnv('SUPABASE_PALETTE_MODE', 'primary');
    vi.resetModules();

    const { config } = await import('./config.js');

    expect(config.supabase.paletteMode).toBe('primary');
  });

  it('rejects an unknown palette mode', async () => {
    vi.stubEnv('SUPABASE_PALETTE_MODE', 'read-sometimes');
    vi.resetModules();

    await expect(import('./config.js')).rejects.toThrow(
      /SUPABASE_PALETTE_MODE must be off, shadow, or primary/,
    );
  });
});

describe('Apple lyrics backfill configuration', () => {
  it('is disabled by default and keeps the worker at one concurrent job', async () => {
    vi.stubEnv('APPLE_LYRICS_BACKFILL_ENABLED', '');
    vi.stubEnv('APPLE_LYRICS_CONCURRENCY', '');
    vi.resetModules();

    const { config } = await import('./config.js');

    expect(config.appleLyrics.enabled).toBe(false);
    expect(config.appleLyrics.concurrency).toBe(1);
    expect(config.appleLyrics.maxAttempts).toBe(5);
    expect(config.appleLyrics.jobDeadlineMs).toBe(210_000);
    expect(config.appleLyrics.cleanupGraceMs).toBe(35_000);
    expect(config.appleLyrics.runnerMode).toBe('embedded');
    expect(config.appleLyrics.embeddedCompatibility).toBe(false);
    expect(config.appleLyrics.healthPort).toBe(8_792);
  });

  it('normalizes the explicitly allowed Apple fallback storefronts once', async () => {
    vi.stubEnv(
      'APPLE_MUSIC_FALLBACK_STOREFRONTS',
      ' us,cn,US,invalid,tw,hk,ca,jp ',
    );
    vi.resetModules();

    const { config } = await import('./config.js');

    expect(config.appleMusic.fallbackStorefronts).toEqual([
      'US',
      'CN',
      'TW',
      'HK',
      'CA',
    ]);
    expect(config.artwork.appleFallbackStorefronts)
      .toEqual(config.appleMusic.fallbackStorefronts);
  });

  it('does not allow configuration to raise the single-process worker concurrency', async () => {
    vi.stubEnv('APPLE_LYRICS_CONCURRENCY', '4');
    vi.resetModules();

    const { config } = await import('./config.js');

    expect(config.appleLyrics.concurrency).toBe(1);
  });

  it('rejects a production deadline budget that can outlive its lease', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_REVISION', 'a'.repeat(40));
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32));
    vi.stubEnv('ADMIN_PIN', '123456');
    vi.stubEnv('MQTT_PASSWORD', 'mqtt-password');
    vi.stubEnv('SUPABASE_LYRICS_MODE', 'primary');
    vi.stubEnv('SUPABASE_PALETTE_MODE', 'off');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test');
    vi.stubEnv('SUPABASE_LIBRARY_ID', '11111111-1111-4111-8111-111111111111');
    vi.stubEnv('APPLE_LYRICS_LEASE_SECONDS', '300');
    vi.stubEnv('APPLE_LYRICS_JOB_DEADLINE_MS', '270000');
    vi.stubEnv('APPLE_LYRICS_CLEANUP_GRACE_MS', '35000');
    vi.resetModules();

    const { validateProductionConfig } = await import('./config.js');

    expect(validateProductionConfig()).toContain(
      'APPLE_LYRICS_JOB_DEADLINE_MS + cleanup grace '
      + '(must leave one dependency timeout before lease expiry)',
    );
  });

  it('keeps cleanup grace longer than the lease finalization budget', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SUPABASE_LYRICS_MODE', 'primary');
    vi.stubEnv('APPLE_LYRICS_CLEANUP_GRACE_MS', '10000');
    vi.resetModules();

    const { validateProductionConfig } = await import('./config.js');

    expect(validateProductionConfig()).toContain(
      'APPLE_LYRICS_CLEANUP_GRACE_MS (must exceed the 10000ms lease finalization budget)',
    );
  });

  it('fails production validation when enabled without a media user token', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_REVISION', 'a'.repeat(40));
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32));
    vi.stubEnv('ADMIN_PIN', '123456');
    vi.stubEnv('MQTT_PASSWORD', 'mqtt-password');
    vi.stubEnv('SUPABASE_LYRICS_MODE', 'primary');
    vi.stubEnv('SUPABASE_PALETTE_MODE', 'off');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test');
    vi.stubEnv('SUPABASE_LIBRARY_ID', '11111111-1111-4111-8111-111111111111');
    vi.stubEnv('APPLE_LYRICS_BACKFILL_ENABLED', 'true');
    vi.stubEnv('APPLE_MUSIC_MEDIA_USER_TOKEN', '');
    vi.stubEnv('APPLE_MUSIC_DEVELOPER_TOKEN', 'developer-token');
    vi.resetModules();

    const { validateProductionConfig } = await import('./config.js');

    expect(validateProductionConfig()).toContain('APPLE_MUSIC_MEDIA_USER_TOKEN');
  });
});

describe('production process-group validation', () => {
  it('requires an explicit flag for the temporary embedded production topology', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APPLE_LYRICS_RUNNER_MODE', 'embedded');
    vi.stubEnv('APPLE_LYRICS_EMBEDDED_COMPATIBILITY', 'false');
    vi.resetModules();

    let configModule = await import('./config.js');
    expect(configModule.validateProductionConfig()).toContain(
      'APPLE_LYRICS_EMBEDDED_COMPATIBILITY (required for embedded production)',
    );

    vi.stubEnv('APPLE_LYRICS_EMBEDDED_COMPATIBILITY', 'true');
    vi.resetModules();
    configModule = await import('./config.js');
    expect(configModule.validateProductionConfig()).not.toContain(
      'APPLE_LYRICS_EMBEDDED_COMPATIBILITY (required for embedded production)',
    );
  });

  it('rejects an entrypoint launched in the other Fly process group', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FLY_PROCESS_GROUP', 'apple_worker');
    vi.resetModules();

    const { validateProductionProcessGroup } = await import('./config.js');

    expect(validateProductionProcessGroup('app')).toContain(
      'FLY_PROCESS_GROUP (app required for this entrypoint)',
    );
    expect(validateProductionProcessGroup('apple_worker')).toEqual([]);
  });

  it('allows local production-image smoke tests without Fly metadata', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FLY_PROCESS_GROUP', '');
    vi.resetModules();

    const { validateProductionProcessGroup } = await import('./config.js');

    expect(validateProductionProcessGroup('app')).toEqual([]);
    expect(validateProductionProcessGroup('app', { required: true })).toContain(
      'FLY_PROCESS_GROUP (app required for this entrypoint)',
    );
  });
});
