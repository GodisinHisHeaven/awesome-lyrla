import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHealthRoutes } from './http-health-routes.js';

describe('health routes', () => {
  it('exposes the bounded process snapshot and disabled worker state', async () => {
    const app = Fastify();
    registerHealthRoutes(app, {
      revision: 'test-revision',
      mode: 'live',
      processGroup: null,
      appleLyricsRunnerMode: 'external',
      lyricsCache: () => ({ entries: 2 }),
      playbackClock: () => ({ enabled: true }),
      observability: () => ({ enabled: true }),
      runtimePerformance: () => ({ monitoring: true }),
      paletteSync: () => ({ pending: 0 }),
      artworkLookup: () => ({ active: 0 }),
    });

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      revision: 'test-revision',
      processRole: 'web',
      appleLyricsBackfill: { enabled: false },
      appleLyricsReprojection: { enabled: false },
      appleLyricsTimelineRepair: { enabled: false },
      appleLyricsQueues: { enabled: false },
    });

    await app.close();
  });
});
