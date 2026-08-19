import 'dotenv/config';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SetupStatus } from '../shared/contracts.js';
import { createAppleLyricsRuntime } from './apple-lyrics-runtime.js';
import { ArtworkPaletteService } from './artwork-palette-service.js';
import {
  config,
  teslaDeveloperAppConfigured,
  validateProductionConfig,
  validateProductionProcessGroup,
} from './config.js';
import { registerHealthRoutes } from './http-health-routes.js';
import { LyricsService } from './lyrics-service.js';
import { playbackClockObservability } from './playback-clock-observability.js';
import { PlayerCoordinator } from './player.js';
import { productionObservability } from './production-observability.js';
import { RuntimePerformanceMonitor } from './runtime-performance.js';
import { LatestSseStream } from './sse-stream.js';
import { JsonStore } from './store.js';
import { TelemetryBroker } from './telemetry.js';
import { TESLA_OAUTH_SCOPES, TeslaService } from './tesla-service.js';

const missingConfig = [
  ...validateProductionConfig(),
  ...validateProductionProcessGroup('app', {
    required: config.appleLyrics.runnerMode === 'external',
  }),
];
if (missingConfig.length > 0) {
  throw new Error(`Missing production configuration: ${missingConfig.join(', ')}`);
}

const app = Fastify({
  logger: config.isProduction ? { level: 'warn' } : true,
  trustProxy: true,
});
const runtimePerformance = new RuntimePerformanceMonitor([] as const);
runtimePerformance.start();
playbackClockObservability.setEnabled(config.isProduction);
productionObservability.setEnabled(config.isProduction);

const store = new JsonStore();
await store.load();
const lyrics = new LyricsService(store);
const artworkPalettes = new ArtworkPaletteService(store);
const player = new PlayerCoordinator(lyrics, artworkPalettes, store);
const tesla = new TeslaService(store);
const telemetry = new TelemetryBroker(player);
const embeddedAppleLyrics = config.appleLyrics.runnerMode === 'embedded'
  ? createAppleLyricsRuntime()
  : undefined;
const loginAttempts = new Map<string, { failures: number; blockedUntil: number }>();

app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_request, body, done) => done(null, body),
);

await app.register(cookie, { secret: config.sessionSecret, hook: 'onRequest' });

function signedCookieIs(request: FastifyRequest, name: string, expected: string): boolean {
  const value = request.cookies[name];
  if (!value) return false;
  const unsigned = request.unsignCookie(value);
  return unsigned.valid && unsigned.value === expected;
}

function adminAuthorized(request: FastifyRequest): boolean {
  return signedCookieIs(request, 'awesome_lyrla_admin', 'authorized');
}

function playerAuthorized(request: FastifyRequest): boolean {
  return config.demoMode || signedCookieIs(request, 'awesome_lyrla_player', 'authorized');
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!adminAuthorized(request)) {
    return reply.code(401).send({ error: '需要管理员 PIN' });
  }
}

async function requirePlayer(request: FastifyRequest, reply: FastifyReply) {
  if (!playerAuthorized(request)) {
    return reply.code(401).send({ error: '这台屏幕尚未激活' });
  }
}

function secretEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorizePlayer(reply: FastifyReply): void {
  reply.setCookie('awesome_lyrla_player', 'authorized', {
    signed: true,
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  });
}

registerHealthRoutes(app, {
  revision: config.revision,
  mode: config.demoMode ? 'demo' : 'live',
  processGroup: config.processGroup || null,
  appleLyricsRunnerMode: config.appleLyrics.runnerMode,
  lyricsCache: () => lyrics.cacheStats(),
  playbackClock: () => playbackClockObservability.snapshot(),
  observability: () => productionObservability.snapshot(),
  runtimePerformance: () => runtimePerformance.snapshot(),
  paletteSync: () => artworkPalettes.syncStats(),
  artworkLookup: () => artworkPalettes.lookupStats(),
  ...(embeddedAppleLyrics ? { embeddedAppleLyrics } : {}),
});

app.post('/activate', { preHandler: requireAdmin }, async (_request, reply) => {
  authorizePlayer(reply);
  return reply.code(303).redirect('/');
});

app.get('/.well-known/appspecific/com.tesla.3p.public-key.pem', async (_request, reply) => {
  const publicKey = await tesla.publicKey();
  if (!publicKey) {
    return reply.code(404).send({ error: 'Public key has not been generated' });
  }
  return reply.type('application/x-pem-file').send(publicKey);
});

app.get('/api/player/session', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { authenticated: playerAuthorized(request) };
});

app.post('/api/admin/login', async (request, reply) => {
  const attempt = loginAttempts.get(request.ip);
  if (attempt && attempt.blockedUntil > Date.now()) {
    return reply.code(429).send({ error: '尝试次数过多，请 15 分钟后再试' });
  }
  const body = z.object({ pin: z.string().min(4).max(64) }).parse(request.body);
  if (!secretEquals(body.pin, config.adminPin)) {
    const failures = (attempt?.failures ?? 0) + 1;
    loginAttempts.set(request.ip, {
      failures,
      blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1_000 : 0,
    });
    return reply.code(401).send({ error: 'PIN 不正确' });
  }
  loginAttempts.delete(request.ip);
  reply.setCookie('awesome_lyrla_admin', 'authorized', {
    signed: true,
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
  return { ok: true };
});

app.get('/api/admin/session', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { authenticated: adminAuthorized(request) };
});

app.post('/api/admin/logout', { preHandler: requireAdmin }, async (_request, reply) => {
  reply.clearCookie('awesome_lyrla_admin', { path: '/' });
  return { ok: true };
});

app.get(
  '/api/setup/status',
  { preHandler: requireAdmin },
  async (): Promise<SetupStatus> => {
    const selectedVin = store.readSelectedVin();
    const telemetryStatus = store.readTelemetryStatus();
    return {
      demoMode: config.demoMode,
      appOrigin: config.appOrigin,
      developerApp: {
        configured: teslaDeveloperAppConfigured(),
        callbackUrl: tesla.callbackUrl,
        publicKeyUrl: `${config.appOrigin}/.well-known/appspecific/com.tesla.3p.public-key.pem`,
        requiredScopes: [...TESLA_OAUTH_SCOPES],
      },
      teslaAccount: {
        connected: tesla.isConnected(),
        authorizationCurrent: tesla.authorizationIsCurrent(),
        tokenExpiresAt: tesla.tokenExpiresAt(),
      },
      vehicle: {
        selected: Boolean(selectedVin),
        maskedVin: selectedVin
          ? `${selectedVin.slice(0, 3)}••••••••••${selectedVin.slice(-4)}`
          : null,
      },
      telemetry: {
        configured: telemetryStatus.telemetryAccepted
          && Boolean(telemetryStatus.telemetryConfiguredAt),
        synced: telemetryStatus.telemetryAccepted && telemetryStatus.telemetrySynced,
        hostname: config.telemetry.host || null,
        mqttReady: telemetry.isReady(),
      },
    };
  },
);

app.get('/api/setup/private', { preHandler: requireAdmin }, async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { virtualKeyUrl: tesla.virtualKeyUrl() };
});

app.get('/api/player', { preHandler: requirePlayer }, async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return player.snapshot();
});

app.get('/api/events', { preHandler: requirePlayer }, async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let cleaned = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: () => void = () => undefined;
  let writer: LatestSseStream | undefined;
  const streamStartedAt = Date.now();
  productionObservability.openSse();

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    writer?.dispose();
    productionObservability.closeSse(Math.max(0, Date.now() - streamStartedAt));
  };
  const closeStream = () => {
    cleanup();
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  };
  const sseWriter = new LatestSseStream(reply.raw, {
    snapshotWritten: () => productionObservability.observeSseSnapshot(),
    heartbeatWritten: () => productionObservability.observeSseHeartbeat(),
    backpressure: (bufferedBytes) => {
      productionObservability.observeSseBackpressure(bufferedBytes);
    },
    snapshotCoalesced: () => productionObservability.observeSseSnapshotCoalesced(),
    heartbeatSkipped: () => productionObservability.observeSseHeartbeatSkipped(),
    writeFailed: () => {
      productionObservability.observeSseWriteError();
      closeStream();
    },
  });
  writer = sseWriter;
  unsubscribe = player.subscribeSerialized((snapshot) => {
    sseWriter.writeSnapshot(snapshot);
  });
  if (cleaned) {
    unsubscribe();
    return;
  }
  heartbeat = setInterval(() => sseWriter.writeHeartbeat(), 15_000);
  heartbeat.unref();
  request.raw.once('close', cleanup);
  reply.raw.once('close', cleanup);
  reply.raw.once('error', closeStream);
});

app.post('/api/demo/action', { preHandler: requirePlayer }, async (request) => {
  const body = z.object({ action: z.enum(['toggle', 'restart', 'forward']) }).parse(request.body);
  player.demoAction(body.action);
  return player.snapshot();
});

app.put('/api/lyrics/offset', { preHandler: requirePlayer }, async (request) => {
  const body = z.object({ offsetMs: z.number().min(-5_000).max(5_000) }).parse(request.body);
  await player.setOffset(body.offsetMs);
  return player.snapshot();
});

app.put('/api/lyrics/manual', { preHandler: requireAdmin }, async (request) => {
  const body = z.object({ lrc: z.string().min(1).max(512_000) }).parse(request.body);
  await player.setManualLrc(body.lrc);
  return player.snapshot();
});

app.get('/api/lyrics/candidates', { preHandler: requireAdmin }, async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return player.listLyricsCandidates();
});

app.put('/api/lyrics/candidate', { preHandler: requireAdmin }, async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  const body = z.object({
    token: z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/),
    mode: z.enum(['synced', 'plain']),
  }).parse(request.body);
  await player.selectLyricsCandidate(body.token, body.mode);
  return player.snapshot();
});

app.get('/api/tesla/oauth/start', { preHandler: requireAdmin }, async (_request, reply) => {
  const state = randomBytes(24).toString('base64url');
  reply.setCookie('tesla_oauth_state', state, {
    signed: true,
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60,
  });
  return reply.redirect(tesla.authorizationUrl(state));
});

app.get('/api/tesla/oauth/callback', async (request, reply) => {
  const query = z.object({ code: z.string(), state: z.string() }).parse(request.query);
  const cookieState = request.cookies.tesla_oauth_state;
  const unsigned = cookieState ? request.unsignCookie(cookieState) : null;
  if (!unsigned?.valid || unsigned.value !== query.state) {
    return reply.code(400).send({ error: 'OAuth state validation failed' });
  }
  await tesla.exchangeAuthorizationCode(query.code);
  reply.clearCookie('tesla_oauth_state', { path: '/' });
  return reply.redirect('/setup?tesla=connected');
});

app.get('/api/tesla/vehicles', { preHandler: requireAdmin }, async () =>
  tesla.listVehicles(),
);

app.post('/api/tesla/vehicle', { preHandler: requireAdmin }, async (request) => {
  const body = z.object({ vin: z.string(), displayName: z.string().min(1) }).parse(request.body);
  await tesla.selectVehicle(body.vin, body.displayName);
  return { ok: true, virtualKeyUrl: tesla.virtualKeyUrl() };
});

app.get('/api/tesla/fleet-status', { preHandler: requireAdmin }, async () =>
  tesla.fleetStatus(),
);

app.post('/api/tesla/telemetry/configure', { preHandler: requireAdmin }, async () =>
  tesla.configureTelemetry(),
);

app.get('/api/tesla/telemetry/status', { preHandler: requireAdmin }, async () =>
  tesla.telemetryStatus(),
);

app.delete('/api/tesla/telemetry', { preHandler: requireAdmin }, async () => {
  await tesla.deleteTelemetryConfiguration();
  return { ok: true };
});

const distPath = path.join(process.cwd(), 'dist');
if (config.isProduction) {
  await access(distPath);
  await app.register(fastifyStatic, {
    root: distPath,
    prefix: '/',
    wildcard: false,
    setHeaders(response, filePath) {
      if (path.basename(filePath) === 'index.html') {
        response.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
    },
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
      return reply
        .header('Cache-Control', 'no-store, no-cache, must-revalidate')
        .type('text/html')
        .send(await readFile(path.join(distPath, 'index.html'), 'utf8'));
    }
    return reply.code(404).send({ error: 'Not found' });
  });
}

app.setErrorHandler((error, request, reply) => {
  if (config.isProduction) productionObservability.observeHttpError(error);
  else request.log.error(error);
  const normalized = error instanceof Error ? error : new Error(String(error));
  const statusCode = typeof error === 'object'
    && error
    && 'statusCode' in error
    ? Number(error.statusCode)
    : 500;
  const status = error instanceof z.ZodError
    ? 400
    : Number.isFinite(statusCode)
      ? statusCode
      : 500;
  void reply.code(status).send({
    error: status >= 500 && config.isProduction
      ? '服务器暂时无法完成这个操作'
      : normalized.message,
  });
});

await telemetry.start();
await app.listen({ host: '0.0.0.0', port: config.port });
embeddedAppleLyrics?.start();
void tesla.reconcileTelemetryConfiguration();

async function shutdown(): Promise<void> {
  runtimePerformance.stop();
  await embeddedAppleLyrics?.close();
  await telemetry.close();
  await app.close();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
