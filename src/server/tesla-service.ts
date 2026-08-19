import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type {
  TelemetryConfigurationResult,
  TelemetryConfigurationStatus,
  TeslaVehicleSummary,
} from '../shared/contracts.js';
import { config, teslaDeveloperAppConfigured } from './config.js';
import { decryptJson, encryptJson } from './crypto.js';
import type { StateStore } from './store.js';

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  token_type: z.string().optional(),
});

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  authorizationVersion?: number;
}

const vehicleListSchema = z.object({
  response: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      vin: z.string(),
      display_name: z.string().optional().default('Tesla'),
      state: z.string().optional().default('unknown'),
    }),
  ),
});

const TELEMETRY_SKIP_REASONS = [
  'missing_key',
  'unsupported_hardware',
  'unsupported_firmware',
  'max_configs',
] as const;

type TelemetrySkipReason = (typeof TELEMETRY_SKIP_REASONS)[number] | 'unknown';

export const TESLA_OAUTH_SCOPES = [
  'openid',
  'offline_access',
  'vehicle_device_data',
  'vehicle_location',
] as const;
export const TESLA_AUTHORIZATION_VERSION = 1;

export const PLAYER_TELEMETRY_FIELDS = {
  MediaNowPlayingTitle: { interval_seconds: 1, resend_interval_seconds: 30 },
  MediaNowPlayingArtist: { interval_seconds: 1, resend_interval_seconds: 30 },
  MediaNowPlayingAlbum: { interval_seconds: 1, resend_interval_seconds: 30 },
  MediaNowPlayingDuration: { interval_seconds: 1, resend_interval_seconds: 30 },
  MediaNowPlayingElapsed: { interval_seconds: 1 },
  MediaPlaybackSource: { interval_seconds: 1, resend_interval_seconds: 30 },
  MediaPlaybackStatus: { interval_seconds: 1, resend_interval_seconds: 30 },
  DestinationName: { interval_seconds: 1, resend_interval_seconds: 60 },
  MinutesToArrival: { interval_seconds: 5, resend_interval_seconds: 30 },
  MilesToArrival: { interval_seconds: 5, resend_interval_seconds: 30 },
  ExpectedEnergyPercentAtTripArrival: { interval_seconds: 5, resend_interval_seconds: 30 },
} as const;

export interface NormalizedTelemetryConfigureResponse {
  accepted: boolean;
  updatedVehicles: number;
  skippedReasons: TelemetrySkipReason[];
}

function normalizedKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function knownSkipReason(value: string): Exclude<TelemetrySkipReason, 'unknown'> | null {
  const normalized = normalizedKey(value);
  return TELEMETRY_SKIP_REASONS.find((reason) => reason === normalized) ?? null;
}

function hasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasContent);
  if (value && typeof value === 'object') return Object.values(value).some(hasContent);
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined && value !== false && value !== 0;
}

function countCollection(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return hasContent(value) ? 1 : 0;
}

function findProperty(value: unknown, target: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findProperty(item, target);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (normalizedKey(key) === target) return nested;
  }
  for (const nested of Object.values(value)) {
    const match = findProperty(nested, target);
    if (match !== undefined) return match;
  }
  return undefined;
}

function collectSkipReasons(value: unknown, reasons: Set<TelemetrySkipReason>): void {
  if (typeof value === 'string') {
    const reason = knownSkipReason(value);
    if (reason) reasons.add(reason);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSkipReasons(item, reasons);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const reason = knownSkipReason(key);
    if (reason && hasContent(nested)) reasons.add(reason);
    collectSkipReasons(nested, reasons);
  }
}

export function normalizeTelemetryConfigureResponse(
  payload: unknown,
): NormalizedTelemetryConfigureResponse {
  const updated = findProperty(payload, 'updated_vehicles');
  const skipped = findProperty(payload, 'skipped_vehicles');
  const reasons = new Set<TelemetrySkipReason>();
  if (skipped !== undefined) collectSkipReasons(skipped, reasons);
  if (hasContent(skipped) && reasons.size === 0) reasons.add('unknown');
  return {
    accepted: reasons.size === 0,
    updatedVehicles: countCollection(updated),
    skippedReasons: [...reasons],
  };
}

function strictBooleanProperty(value: unknown, target: string): boolean | undefined {
  const match = findProperty(value, target);
  return typeof match === 'boolean' ? match : undefined;
}

export function sanitizeTelemetryConfigStatus(payload: unknown): TelemetryConfigurationStatus {
  const synced = strictBooleanProperty(payload, 'synced');
  const keyPaired = strictBooleanProperty(payload, 'key_paired');
  const limitReached = strictBooleanProperty(payload, 'limit_reached');
  return {
    configured: synced !== undefined || keyPaired !== undefined || limitReached !== undefined,
    synced: synced === true,
    keyPaired: keyPaired === true,
    limitReached: limitReached === true,
  };
}

class TeslaSetupError extends Error {
  readonly statusCode = 409;
}

function telemetrySkipError(reasons: TelemetrySkipReason[]): TeslaSetupError {
  if (reasons.includes('missing_key')) {
    return new TeslaSetupError('车辆尚未配对虚拟钥匙。请先点击“配对虚拟钥匙”并在 Tesla App 中完成添加。');
  }
  if (reasons.includes('unsupported_firmware')) {
    return new TeslaSetupError('车辆固件暂不支持 Fleet Telemetry；请先更新车辆软件。');
  }
  if (reasons.includes('unsupported_hardware')) {
    return new TeslaSetupError('这辆车的硬件不支持 Fleet Telemetry。');
  }
  if (reasons.includes('max_configs')) {
    return new TeslaSetupError('车辆的第三方遥测配置数量已达上限；请先移除一个旧配置。');
  }
  return new TeslaSetupError('Tesla 未接受这辆车的遥测配置，请稍后重试。');
}

export class TeslaService {
  private refreshPromise?: Promise<string>;
  private tokenMutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: StateStore,
    private readonly tokenEncryptionKey = config.sessionSecret,
  ) {}

  get callbackUrl(): string {
    return `${config.appOrigin}/api/tesla/oauth/callback`;
  }

  get applicationDomain(): string {
    return new URL(config.appOrigin).hostname;
  }

  isConnected(): boolean {
    return Boolean(this.store.readTeslaTokens());
  }

  tokenExpiresAt(): number | undefined {
    return this.readTokens()?.expiresAt;
  }

  authorizationIsCurrent(): boolean {
    return this.readTokens()?.authorizationVersion === TESLA_AUTHORIZATION_VERSION;
  }

  authorizationUrl(state: string): string {
    if (!teslaDeveloperAppConfigured()) throw new Error('Tesla Developer 应用尚未配置');
    const url = new URL(`${config.tesla.authBase}/authorize`);
    url.searchParams.set('client_id', config.tesla.clientId);
    url.searchParams.set('locale', 'zh-CN');
    url.searchParams.set('prompt', 'login');
    url.searchParams.set('redirect_uri', this.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', TESLA_OAUTH_SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('require_requested_scopes', 'true');
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<void> {
    await this.serializeTokenMutation(async () => {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.tesla.clientId,
        client_secret: config.tesla.clientSecret,
        code,
        audience: config.tesla.audience,
        redirect_uri: this.callbackUrl,
      });
      const response = await fetch(config.tesla.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Tesla token exchange failed (${response.status})`);
      const token = tokenResponseSchema.parse(await response.json());
      if (!token.refresh_token) {
        throw new Error('Tesla 未返回 refresh token，请确认已授权 offline_access');
      }
      await this.saveTokens({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1_000,
        authorizationVersion: TESLA_AUTHORIZATION_VERSION,
      });
    });
  }

  async listVehicles(): Promise<TeslaVehicleSummary[]> {
    const data = vehicleListSchema.parse(await this.fleetRequest('/api/1/vehicles'));
    return data.response.map((vehicle) => ({
      id: Number(vehicle.id),
      vin: vehicle.vin,
      displayName: vehicle.display_name,
      state: vehicle.state,
    }));
  }

  async selectVehicle(vin: string, displayName: string): Promise<void> {
    if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) throw new Error('VIN 格式不正确');
    const vehicles = await this.listVehicles();
    const selected = vehicles.find((vehicle) => vehicle.vin === vin);
    if (!selected) {
      throw new Error('所选车辆不属于当前授权的 Tesla 账户');
    }
    await this.store.update((draft) => {
      if (draft.selectedVin !== vin) {
        draft.telemetryAccepted = false;
        draft.telemetryConfiguredAt = null;
        draft.telemetrySynced = false;
      }
      draft.selectedVin = vin;
      draft.selectedVehicleName = selected.displayName || displayName;
    });
  }

  virtualKeyUrl(): string {
    const vin = this.store.readSelectedVin();
    const url = new URL(`https://tesla.com/_ak/${this.applicationDomain}`);
    if (vin) url.searchParams.set('vin', vin);
    return url.toString();
  }

  async fleetStatus(): Promise<unknown> {
    const vin = this.requireSelectedVin();
    return this.fleetRequest('/api/1/vehicles/fleet_status', {
      method: 'POST',
      body: JSON.stringify({ vins: [vin] }),
    });
  }

  async configureTelemetry(): Promise<TelemetryConfigurationResult> {
    if (!config.tesla.commandProxyUrl) {
      throw new Error('TESLA_COMMAND_PROXY_URL 尚未配置');
    }
    if (!config.telemetry.host) throw new Error('TELEMETRY_HOST 尚未配置');
    if (!this.authorizationIsCurrent()) {
      throw new TeslaSetupError(
        'Tesla 授权尚未完成。请重新打开设置页完成 Tesla 官方授权。',
      );
    }
    const vin = this.requireSelectedVin();
    const ca = await readFile(config.telemetry.caPath, 'utf8');
    const accessToken = await this.validAccessToken();
    const endpoint = new URL(
      '/api/1/vehicles/fleet_telemetry_config',
      config.tesla.commandProxyUrl,
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        vins: [vin],
        config: {
          hostname: config.telemetry.host,
          port: config.telemetry.port,
          ca,
          fields: PLAYER_TELEMETRY_FIELDS,
          alert_types: [],
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new TeslaSetupError(
          'Tesla 授权尚未完成。请重新打开设置页完成 Tesla 官方授权。',
        );
      }
      throw new Error(`Tesla telemetry configuration failed (${response.status}): ${JSON.stringify(payload)}`);
    }
    const normalized = normalizeTelemetryConfigureResponse(payload);
    if (!normalized.accepted) {
      await this.store.update((draft) => {
        draft.telemetryAccepted = false;
        draft.telemetryConfiguredAt = null;
        draft.telemetrySynced = false;
      });
      throw telemetrySkipError(normalized.skippedReasons);
    }
    await this.store.update((draft) => {
      draft.telemetryAccepted = true;
      draft.telemetryConfiguredAt = Date.now();
      draft.telemetrySynced = false;
    });
    return { accepted: true };
  }

  /**
   * Re-send the current field set for an already configured vehicle.
   *
   * Fleet Telemetry configuration lives in Tesla, not in this process. A
   * deploy therefore cannot update an existing vehicle unless we explicitly
   * reconcile the remote configuration. Only states that were previously
   * accepted are eligible; first-time setup remains an explicit user action.
   */
  async reconcileTelemetryConfiguration(): Promise<boolean> {
    const telemetry = this.store.readTelemetryStatus();
    if (!telemetry.telemetryAccepted || !telemetry.telemetryConfiguredAt) return false;
    if (!this.store.readSelectedVin() || !this.isConnected() || !this.authorizationIsCurrent()) {
      return false;
    }

    try {
      await this.configureTelemetry();
      return true;
    } catch (error) {
      // Reconciliation is best effort and must never delay startup. Keep the
      // diagnostic bounded and do not include Tesla payloads or VINs.
      console.warn(
        'Tesla telemetry reconciliation deferred:',
        error instanceof Error ? error.constructor.name : 'UnknownError',
      );
      return false;
    }
  }

  async telemetryStatus(): Promise<TelemetryConfigurationStatus> {
    const vin = this.requireSelectedVin();
    const payload = await this.fleetRequest(
      `/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`,
    );
    const status = sanitizeTelemetryConfigStatus(payload);
    await this.store.update((draft) => {
      draft.telemetrySynced = draft.telemetryAccepted && status.synced;
    });
    return status;
  }

  async deleteTelemetryConfiguration(): Promise<void> {
    const vin = this.requireSelectedVin();
    await this.fleetRequest(
      `/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`,
      { method: 'DELETE' },
    );
    await this.store.update((draft) => {
      draft.telemetryAccepted = false;
      draft.telemetryConfiguredAt = null;
      draft.telemetrySynced = false;
    });
  }

  async publicKey(): Promise<string | null> {
    try {
      return await readFile(config.tesla.publicKeyPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private requireSelectedVin(): string {
    const vin = this.store.readSelectedVin();
    if (!vin) throw new Error('请先选择车辆');
    return vin;
  }

  private readTokens(): StoredTokens | null {
    const envelope = this.store.readTeslaTokens();
    if (!envelope) return null;
    return decryptJson<StoredTokens>(envelope, this.tokenEncryptionKey);
  }

  private async saveTokens(tokens: StoredTokens): Promise<void> {
    await this.store.update((draft) => {
      draft.teslaTokens = encryptJson(tokens, this.tokenEncryptionKey);
    });
  }

  private async validAccessToken(): Promise<string> {
    const tokens = this.readTokens();
    if (!tokens) throw new Error('Tesla 账户尚未连接');
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;

    if (!this.refreshPromise) {
      this.refreshPromise = this.serializeTokenMutation(() => this.refreshAccessToken())
        .finally(() => {
          this.refreshPromise = undefined;
        });
    }
    return this.refreshPromise;
  }

  private async refreshAccessToken(): Promise<string> {
    const tokens = this.readTokens();
    if (!tokens) throw new Error('Tesla 账户尚未连接');
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    const response = await fetch(config.tesla.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.tesla.clientId,
        refresh_token: tokens.refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Tesla token refresh failed (${response.status})`);
    const refreshed = tokenResponseSchema.parse(await response.json());
    await this.saveTokens({
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + refreshed.expires_in * 1_000,
      authorizationVersion: tokens.authorizationVersion,
    });
    return refreshed.access_token;
  }

  private serializeTokenMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tokenMutationTail.then(operation);
    this.tokenMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async fleetRequest(pathname: string, init?: RequestInit): Promise<unknown> {
    const accessToken = await this.validAccessToken();
    const response = await fetch(new URL(pathname, config.tesla.audience), {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Tesla Fleet API request failed (${response.status}): ${JSON.stringify(payload)}`);
    }
    return payload;
  }
}
