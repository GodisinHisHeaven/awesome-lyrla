import {
  appleLyricsRuntimeLive,
  appleLyricsRuntimeReleaseReady,
  appleLyricsWorkerHealthPayload,
} from './apple-lyrics-worker-health.js';

const healthy = {
  enabled: true as const,
  running: false,
  polls: 1,
  successfulPolls: 1,
  claimed: 0,
  succeeded: 0,
  retryScheduled: 0,
  permanentlyFailed: 0,
  pollFailures: 0,
  consecutivePollFailures: 0,
  lastState: 'idle' as const,
  lastSuccessfulPollAt: '2026-07-22T00:00:00.000Z',
  lastClaimedAt: null,
  lastSucceededAt: null,
  lastJobState: null,
  deadlinesExceeded: 0,
  lastDeadlineAt: null,
  wedged: false,
};

function stats(overrides: Partial<typeof healthy> = {}) {
  const worker = { ...healthy, ...overrides };
  return {
    appleLyricsBackfill: worker,
    appleLyricsReprojection: worker,
    appleLyricsTimelineRepair: worker,
  };
}

describe('standalone Apple lyrics worker readiness', () => {
  it('becomes ready only after every runner completes a healthy poll', () => {
    expect(appleLyricsRuntimeReleaseReady(stats())).toBe(true);
    expect(appleLyricsRuntimeReleaseReady({
      ...stats(),
      appleLyricsReprojection: { ...healthy, polls: 0, successfulPolls: 0 },
    })).toBe(false);
  });

  it('keeps dependency progress separate from process liveness', () => {
    expect(appleLyricsRuntimeLive(stats({ successfulPolls: 0 }))).toBe(true);
    expect(appleLyricsRuntimeLive(stats({ consecutivePollFailures: 1 }))).toBe(true);
    expect(appleLyricsRuntimeLive(stats({ deadlinesExceeded: 1 }))).toBe(true);
    expect(appleLyricsRuntimeLive(stats({ wedged: true }))).toBe(false);
  });

  it('rejects worker failures, deadlines and wedges from release readiness', () => {
    expect(appleLyricsRuntimeReleaseReady(stats({ consecutivePollFailures: 1 })))
      .toBe(false);
    expect(appleLyricsRuntimeReleaseReady(stats({ deadlinesExceeded: 1 })))
      .toBe(false);
    expect(appleLyricsRuntimeReleaseReady(stats({ wedged: true }))).toBe(false);
  });

  it('ignores disabled optional runners but rejects an empty worker process', () => {
    expect(appleLyricsRuntimeLive({
      ...stats(),
      appleLyricsBackfill: { enabled: false },
    })).toBe(true);
    expect(appleLyricsRuntimeReleaseReady({
      ...stats(),
      appleLyricsBackfill: { enabled: false },
    })).toBe(true);
    const disabled = {
      appleLyricsBackfill: { enabled: false as const },
      appleLyricsReprojection: { enabled: false as const },
      appleLyricsTimelineRepair: { enabled: false as const },
    };
    expect(appleLyricsRuntimeLive(disabled)).toBe(false);
    expect(appleLyricsRuntimeReleaseReady(disabled)).toBe(false);
  });

  it('keeps the Fly check body below its 4096-byte output limit', () => {
    const payload = appleLyricsWorkerHealthPayload(stats(), {
      started: true,
      revision: 'a'.repeat(40),
      processGroup: 'apple_worker',
    });
    expect(payload).toMatchObject({
      status: 'ok',
      live: true,
      releaseReady: true,
      processRole: 'apple-worker',
      processGroup: 'apple_worker',
    });
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThan(4_096);
  });
});
