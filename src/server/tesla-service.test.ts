import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson } from './crypto.js';
import {
  createInitialState,
  type PersistedState,
  type StateStore,
} from './store.js';
import {
  normalizeTelemetryConfigureResponse,
  PLAYER_TELEMETRY_FIELDS,
  sanitizeTelemetryConfigStatus,
  TESLA_AUTHORIZATION_VERSION,
  TESLA_OAUTH_SCOPES,
  TeslaService,
} from './tesla-service.js';

const VIN = '5YJ00000000000000';
const TOKEN_KEY = 'test-token-encryption-key-at-least-32-characters';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('player telemetry configuration', () => {
  it('periodically resends static player fields but keeps elapsed event-driven', () => {
    expect(PLAYER_TELEMETRY_FIELDS.MediaNowPlayingArtist.resend_interval_seconds).toBe(30);
    expect(PLAYER_TELEMETRY_FIELDS.MediaPlaybackSource.resend_interval_seconds).toBe(30);
    expect(PLAYER_TELEMETRY_FIELDS.MediaNowPlayingElapsed).toEqual({ interval_seconds: 1 });
    expect(PLAYER_TELEMETRY_FIELDS.DestinationName).toEqual({
      interval_seconds: 1,
      resend_interval_seconds: 60,
    });
    expect(PLAYER_TELEMETRY_FIELDS.MinutesToArrival).toEqual({
      interval_seconds: 5,
      resend_interval_seconds: 30,
    });
    expect(PLAYER_TELEMETRY_FIELDS.MilesToArrival).toEqual({
      interval_seconds: 5,
      resend_interval_seconds: 30,
    });
    expect(PLAYER_TELEMETRY_FIELDS.ExpectedEnergyPercentAtTripArrival).toEqual({
      interval_seconds: 5,
      resend_interval_seconds: 30,
    });
  });

  it('requests the location scope required by Tesla navigation fields', () => {
    expect(TESLA_OAUTH_SCOPES).toEqual([
      'openid',
      'offline_access',
      'vehicle_device_data',
      'vehicle_location',
    ]);
  });
});

describe('normalizeTelemetryConfigureResponse', () => {
  it('recognizes reason-bucket skipped vehicles without returning VINs', () => {
    const result = normalizeTelemetryConfigureResponse({
      response: {
        updated_vehicles: 0,
        skipped_vehicles: {
          missing_key: [VIN],
          unsupported_hardware: [],
          unsupported_firmware: [],
          max_configs: [],
        },
      },
    });

    expect(result).toEqual({
      accepted: false,
      updatedVehicles: 0,
      skippedReasons: ['missing_key'],
    });
    expect(JSON.stringify(result)).not.toContain(VIN);
  });

  it('recognizes VIN-to-reason skipped vehicles without returning VINs', () => {
    const result = normalizeTelemetryConfigureResponse({
      response: {
        updated_vehicles: {},
        skipped_vehicles: { [VIN]: 'missing_key' },
      },
    });

    expect(result).toEqual({
      accepted: false,
      updatedVehicles: 0,
      skippedReasons: ['missing_key'],
    });
    expect(JSON.stringify(result)).not.toContain(VIN);
  });

  it('accepts a response whose skipped reason buckets are empty', () => {
    expect(
      normalizeTelemetryConfigureResponse({
        response: {
          updated_vehicles: 1,
          skipped_vehicles: {
            missing_key: [],
            unsupported_hardware: [],
            unsupported_firmware: [],
            max_configs: [],
          },
        },
      }),
    ).toEqual({ accepted: true, updatedVehicles: 1, skippedReasons: [] });
  });
});

describe('sanitizeTelemetryConfigStatus', () => {
  it('returns only strict booleans from a full Tesla response', () => {
    const result = sanitizeTelemetryConfigStatus({
      response: {
        vin: VIN,
        hostname: 'private.example.test',
        ca: '-----BEGIN CERTIFICATE----- secret',
        fields: { MediaNowPlayingTitle: { interval_seconds: 1 } },
        synced: true,
        key_paired: false,
        limit_reached: false,
      },
    });

    expect(result).toEqual({
      configured: true,
      synced: true,
      keyPaired: false,
      limitReached: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/5YJ|CERTIFICATE|private\.example|MediaNowPlaying/);
  });

  it('fails closed for missing and non-boolean status values', () => {
    expect(sanitizeTelemetryConfigStatus({ response: {} })).toEqual({
      configured: false,
      synced: false,
      keyPaired: false,
      limitReached: false,
    });
    expect(
      sanitizeTelemetryConfigStatus({
        response: { synced: 'true', key_paired: 1, limit_reached: true },
      }),
    ).toEqual({
      configured: true,
      synced: false,
      keyPaired: false,
      limitReached: true,
    });
  });
});

describe('Tesla token mutation ordering', () => {
  it('surfaces a corrupted stored token instead of treating it as disconnected', () => {
    const store = {
      readTeslaTokens: () => ({
        ciphertext: 'not-a-token',
        iv: 'not-an-iv',
        authTag: 'not-an-auth-tag',
      }),
    } as unknown as StateStore;
    const service = new TeslaService(store, TOKEN_KEY);

    expect(() => service.authorizationIsCurrent()).toThrow();
    expect(() => service.tokenExpiresAt()).toThrow();
  });

  it('does not let an older refresh overwrite a newer OAuth authorization', async () => {
    let state: PersistedState = {
      ...createInitialState(),
      teslaTokens: encryptJson({
        accessToken: 'expired-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1_000,
      }, TOKEN_KEY),
    };
    const store = {
      readTeslaTokens: () => state.teslaTokens,
      readSelectedVin: () => state.selectedVin,
      update: async (mutator: (draft: PersistedState) => void) => {
        const draft = structuredClone(state);
        mutator(draft);
        state = draft;
      },
    } as unknown as StateStore;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/token')) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get('grant_type') === 'refresh_token') {
          await refreshGate;
          return new Response(JSON.stringify({
            access_token: 'refreshed-old-access',
            refresh_token: 'refreshed-old-refresh',
            expires_in: 3_600,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: 'new-oauth-access',
          refresh_token: 'new-oauth-refresh',
          expires_in: 7_200,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ response: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    const service = new TeslaService(store, TOKEN_KEY);
    expect(service.authorizationIsCurrent()).toBe(false);

    const refreshRequest = service.listVehicles();
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    const authorization = service.exchangeAuthorizationCode('new-code');
    expect(fetcher).toHaveBeenCalledTimes(1);
    releaseRefresh();
    await Promise.all([refreshRequest, authorization]);

    expect(decryptJson<{
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      authorizationVersion?: number;
    }>(state.teslaTokens!, TOKEN_KEY)).toEqual(expect.objectContaining({
      accessToken: 'new-oauth-access',
      refreshToken: 'new-oauth-refresh',
      authorizationVersion: TESLA_AUTHORIZATION_VERSION,
    }));
    expect(service.authorizationIsCurrent()).toBe(true);
  });
});

describe('Fleet Telemetry reconciliation', () => {
  function reconciliationStore(
    telemetryAccepted: boolean,
    telemetryConfiguredAt: number | null,
  ): StateStore {
    return {
      readTelemetryStatus: () => ({
        telemetryAccepted,
        telemetryConfiguredAt,
        telemetrySynced: false,
      }),
      readSelectedVin: () => VIN,
      readTeslaTokens: () => encryptJson({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
        authorizationVersion: TESLA_AUTHORIZATION_VERSION,
      }, TOKEN_KEY),
    } as unknown as StateStore;
  }

  it('does not configure a vehicle that has not completed setup', async () => {
    const service = new TeslaService(reconciliationStore(false, null), TOKEN_KEY);
    const configure = vi.spyOn(service, 'configureTelemetry');

    await expect(service.reconcileTelemetryConfiguration()).resolves.toBe(false);
    expect(configure).not.toHaveBeenCalled();
  });

  it('re-sends the current fields for an existing accepted configuration', async () => {
    const service = new TeslaService(reconciliationStore(true, Date.now() - 60_000), TOKEN_KEY);
    const configure = vi
      .spyOn(service, 'configureTelemetry')
      .mockResolvedValue({ accepted: true });

    await expect(service.reconcileTelemetryConfiguration()).resolves.toBe(true);
    expect(configure).toHaveBeenCalledOnce();
  });

  it('keeps startup non-blocking when Tesla rejects reconciliation', async () => {
    const service = new TeslaService(reconciliationStore(true, Date.now() - 60_000), TOKEN_KEY);
    vi.spyOn(service, 'configureTelemetry').mockRejectedValue(new Error('upstream unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(service.reconcileTelemetryConfiguration()).resolves.toBe(false);
    expect(warning).toHaveBeenCalledWith(
      'Tesla telemetry reconciliation deferred:',
      'Error',
    );
  });
});
