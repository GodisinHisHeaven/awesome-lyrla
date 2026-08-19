import type { FastifyInstance } from 'fastify';
import type { AppleLyricsRuntime } from './apple-lyrics-runtime.js';

export interface HealthRouteDependencies {
  revision: string;
  mode: string;
  processGroup: string | null;
  appleLyricsRunnerMode: string;
  lyricsCache: () => unknown;
  playbackClock: () => unknown;
  observability: () => unknown;
  runtimePerformance: () => unknown;
  paletteSync: () => unknown;
  artworkLookup: () => unknown;
  embeddedAppleLyrics?: AppleLyricsRuntime;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: HealthRouteDependencies,
): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    revision: dependencies.revision,
    mode: dependencies.mode,
    processRole: 'web',
    processGroup: dependencies.processGroup,
    appleLyricsRunnerMode: dependencies.appleLyricsRunnerMode,
    lyricsCache: dependencies.lyricsCache(),
    playbackClock: dependencies.playbackClock(),
    observability: dependencies.observability(),
    runtimePerformance: dependencies.runtimePerformance(),
    paletteSync: dependencies.paletteSync(),
    artworkLookup: dependencies.artworkLookup(),
    ...(dependencies.embeddedAppleLyrics?.stats() ?? {
      appleLyricsBackfill: { enabled: false },
      appleLyricsReprojection: { enabled: false },
      appleLyricsTimelineRepair: { enabled: false },
      appleLyricsQueues: { enabled: false },
    }),
  }));
}
