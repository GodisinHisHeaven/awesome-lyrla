import type { AppleLyricsRuntimeStats } from './apple-lyrics-runtime.js';

function enabledWorkers(stats: AppleLyricsRuntimeStats) {
  return [
    stats.appleLyricsBackfill,
    stats.appleLyricsReprojection,
    stats.appleLyricsTimelineRepair,
  ].filter((worker) => worker.enabled === true);
}

/**
 * Fly liveness deliberately ignores dependency failures and cold-start queue
 * progress. Restarting a healthy process cannot repair Apple or Supabase, and
 * a real job may legitimately occupy the shared coordinator for longer than
 * the Fly check grace period. The runner watchdog owns truly wedged work.
 */
export function appleLyricsRuntimeLive(stats: AppleLyricsRuntimeStats): boolean {
  const workers = enabledWorkers(stats);
  return workers.length > 0 && workers.every((worker) => (
    'wedged' in worker && worker.wedged === false
  ));
}

/** Deployment readiness is stricter than liveness and is consumed separately. */
export function appleLyricsRuntimeReleaseReady(
  stats: AppleLyricsRuntimeStats,
): boolean {
  const workers = enabledWorkers(stats);
  return workers.length > 0 && workers.every((worker) => (
    'successfulPolls' in worker
    && worker.successfulPolls > 0
    && worker.consecutivePollFailures === 0
    && worker.deadlinesExceeded === 0
    && worker.wedged === false
  ));
}

export function appleLyricsWorkerHealthPayload(
  stats: AppleLyricsRuntimeStats,
  options: {
    started: boolean;
    revision: string;
    processGroup: string;
  },
) {
  const live = options.started && appleLyricsRuntimeLive(stats);
  return {
    status: live ? 'ok' as const : 'critical' as const,
    revision: options.revision,
    processRole: 'apple-worker' as const,
    processGroup: options.processGroup || null,
    live,
    releaseReady: options.started && appleLyricsRuntimeReleaseReady(stats),
    ...stats,
  };
}
