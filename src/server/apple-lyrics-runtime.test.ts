import { config } from './config.js';
import { createAppleLyricsRuntime } from './apple-lyrics-runtime.js';

const polls = vi.hoisted(() => ({
  backfill: vi.fn(async () => [] as unknown[]),
  reprojection: vi.fn(async () => [] as unknown[]),
  repair: vi.fn(async () => [] as unknown[]),
  observe: vi.fn(async () => ({})),
}));

vi.mock('./config.js', () => ({
  config: {
    revision: 'test-revision',
    supabase: { lyricsMode: 'primary', writeTimeoutMs: 3_000 },
    appleMusic: { storefront: 'us', fallbackStorefronts: [] },
    appleLyrics: {
      enabled: true,
      pollIntervalMs: 15_000,
      leaseSeconds: 300,
      concurrency: 1,
      maxAttempts: 3,
      requestTimeoutMs: 10_000,
      jobDeadlineMs: 210_000,
      cleanupGraceMs: 35_000,
    },
  },
}));
vi.mock('./supabase-lyrics-client.js', () => ({
  SupabaseLyricsClient: class {
    observeAppleLyricsQueue = polls.observe;
  },
}));
vi.mock('./supabase-apple-lyrics-backfill.js', () => ({
  SupabaseAppleLyricsBackfillStore: class {},
  AppleTtmlProjectionParserV3: class {},
}));
vi.mock('./apple-music-lyrics-source.js', () => ({
  AppleMusicLyricsSource: class {},
  AppleMusicLyricsExactIdentityVerifier: class {},
}));
vi.mock('./apple-lyrics-backfill.js', () => ({
  AppleLyricsBackfillWorker: class {
    runOnce = polls.backfill;
  },
}));
vi.mock('./apple-lyrics-reprojection.js', () => ({
  AppleLyricsReprojectionWorker: class {
    runOnce = polls.reprojection;
  },
}));
vi.mock('./apple-lyrics-timeline-repair.js', () => ({
  AppleLyricsTimelineRepairWorker: class {
    runOnce = polls.repair;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('uses 120s idle maintenance and observation without slowing backfill or active draining', async () => {
  vi.useFakeTimers();
  const runtime = createAppleLyricsRuntime();
  try {
    runtime.start();
    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const poll of Object.values(polls)) expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(polls.backfill).toHaveBeenCalledTimes(8);
    expect(polls.reprojection).toHaveBeenCalledTimes(1);
    expect(polls.repair).toHaveBeenCalledTimes(1);
    expect(polls.observe).toHaveBeenCalledTimes(1);
    const work = [{ state: 'succeeded', jobId: 'test-job', artifactSha256: 'a'.repeat(64) }];
    polls.reprojection.mockResolvedValueOnce(work);
    polls.repair.mockResolvedValueOnce(work);
    await vi.advanceTimersByTimeAsync(1);
    for (const poll of [polls.reprojection, polls.repair, polls.observe]) {
      expect(poll).toHaveBeenCalledTimes(2);
    }
    expect(polls.backfill).toHaveBeenCalledTimes(9);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls.reprojection).toHaveBeenCalledTimes(3);
    expect(polls.repair).toHaveBeenCalledTimes(3);
    expect(polls.backfill).toHaveBeenCalledTimes(9);
    expect(runtime.stats().appleLyricsQueues).toMatchObject({ enabled: true, polls: 2 });
  } finally {
    await runtime.close();
  }
  const counts = Object.values(polls).map((poll) => poll.mock.calls.length);
  runtime.start();
  await vi.advanceTimersByTimeAsync(240_000);
  expect(Object.values(polls).map((poll) => poll.mock.calls.length)).toEqual(counts);
});

it('keeps an unconfigured self-hosted runtime free of background polls', async () => {
  vi.useFakeTimers();
  const mode = config.supabase.lyricsMode;
  config.supabase.lyricsMode = 'off';
  config.appleLyrics.enabled = false;
  const runtime = createAppleLyricsRuntime();
  try {
    runtime.start();
    await vi.advanceTimersByTimeAsync(240_000);
    for (const poll of Object.values(polls)) expect(poll).not.toHaveBeenCalled();
    expect(runtime.stats()).toMatchObject({
      appleLyricsBackfill: { enabled: false },
      appleLyricsReprojection: { enabled: false },
      appleLyricsTimelineRepair: { enabled: false },
      appleLyricsQueues: { enabled: false },
    });
  } finally {
    await runtime.close();
    config.supabase.lyricsMode = mode;
    config.appleLyrics.enabled = true;
  }
});
