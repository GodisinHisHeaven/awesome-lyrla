import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerSnapshot } from '../../shared/contracts.js';
import { ApiError, api } from '../api.js';

interface PlayerView {
  snapshot: PlayerSnapshot | null;
  elapsedMs: number;
  streamConnected: boolean;
  unauthorized: boolean;
  error: string | null;
  setOffset: (offsetMs: number) => Promise<void>;
  demoAction: (action: 'toggle' | 'restart' | 'forward') => Promise<void>;
}

interface SnapshotCursor {
  capturedAtMs: number;
  revision: number | null;
}

const PLAYER_REFRESH_TIMEOUT_MS = 8_000;
const PLAYER_REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const LOADING_WATCHDOG_MS = 30_000;

function finiteRevision(value: number | undefined): number | null {
  return Number.isFinite(value) ? value! : null;
}

function snapshotFollows(next: PlayerSnapshot, current: SnapshotCursor | null): boolean {
  if (!Number.isFinite(next.capturedAtMs)) return false;
  if (!current) return true;

  const nextRevision = finiteRevision(next.snapshotRevision);
  if (nextRevision === null || current.revision === null) {
    return next.capturedAtMs > current.capturedAtMs;
  }

  if (nextRevision === current.revision) {
    return next.capturedAtMs > current.capturedAtMs;
  }
  if (nextRevision > current.revision) {
    return next.capturedAtMs >= current.capturedAtMs;
  }
  // A lower revision with a newer wall-clock capture can only be accepted as
  // a server restart. This also rejects a delayed response from the old boot.
  return next.capturedAtMs > current.capturedAtMs;
}

function loadingSnapshotKey(snapshot: PlayerSnapshot | null): string | null {
  if (snapshot?.lyrics?.kind !== 'loading') return null;
  return JSON.stringify([
    snapshot.trackGeneration ?? null,
    snapshot.lyricsGeneration ?? null,
    snapshot.track?.title ?? '',
    snapshot.track?.artist ?? '',
    snapshot.track?.album ?? '',
    snapshot.track?.durationMs ?? 0,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlayerSnapshot(value: unknown): value is PlayerSnapshot {
  if (!isRecord(value)) return false;
  if (value.mode !== 'demo' && value.mode !== 'live') return false;
  if (!['connected', 'waiting', 'offline', 'demo'].includes(String(value.connection))) {
    return false;
  }
  if (!['playing', 'paused', 'stopped', 'unknown'].includes(String(value.playbackStatus))) {
    return false;
  }
  if (
    !Number.isFinite(value.elapsedMs)
    || !Number.isFinite(value.capturedAtMs)
    || !Number.isFinite(value.manualOffsetMs)
  ) return false;
  if (value.track !== null) {
    if (!isRecord(value.track)) return false;
    if (
      typeof value.track.title !== 'string'
      || typeof value.track.artist !== 'string'
      || typeof value.track.album !== 'string'
      || typeof value.track.source !== 'string'
      || !Number.isFinite(value.track.durationMs)
    ) return false;
  }
  if (!isRecord(value.lyrics)) return false;
  if (!['synced', 'plain', 'missing', 'loading'].includes(String(value.lyrics.kind))) {
    return false;
  }
  if (!Array.isArray(value.lyrics.lines) || !value.lyrics.lines.every((line) => (
    isRecord(line)
    && typeof line.id === 'string'
    && typeof line.text === 'string'
    && Number.isFinite(line.startMs)
  ))) return false;
  if (!['lrclib', 'apple', 'manual', 'demo', null].includes(
    value.lyrics.provider as string | null,
  )) return false;
  if (value.artworkPalette !== null) {
    if (!isRecord(value.artworkPalette)) return false;
    if (
      typeof value.artworkPalette.primary !== 'string'
      || typeof value.artworkPalette.secondary !== 'string'
      || !['apple', 'fallback'].includes(String(value.artworkPalette.source))
    ) return false;
  }
  if (value.navigation !== undefined && value.navigation !== null) {
    if (!isRecord(value.navigation)) return false;
    if (
      typeof value.navigation.destinationName !== 'string'
      || !value.navigation.destinationName.trim()
      || !Number.isFinite(value.navigation.minutesToArrival)
      || Number(value.navigation.minutesToArrival) < 0
      || !Number.isFinite(value.navigation.updatedAtMs)
      || (
        value.navigation.distanceToArrivalMiles !== undefined
        && (
          !Number.isFinite(value.navigation.distanceToArrivalMiles)
          || Number(value.navigation.distanceToArrivalMiles) < 0
        )
      )
      || (
        value.navigation.arrivalBatteryPercent !== undefined
        && (
          !Number.isFinite(value.navigation.arrivalBatteryPercent)
          || Number(value.navigation.arrivalBatteryPercent) < 0
          || Number(value.navigation.arrivalBatteryPercent) > 100
        )
      )
    ) return false;
  }
  return true;
}

export function usePlayer(): PlayerView {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [streamConnected, setStreamConnected] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latestSnapshotRef = useRef<SnapshotCursor | null>(null);
  const loadingRefreshRef = useRef<(() => void) | null>(null);
  const authorizationBlockedRef = useRef(false);
  const acceptSnapshot = useCallback((next: PlayerSnapshot) => {
    if (
      authorizationBlockedRef.current
      || !snapshotFollows(next, latestSnapshotRef.current)
    ) return false;
    latestSnapshotRef.current = {
      capturedAtMs: next.capturedAtMs,
      revision: finiteRevision(next.snapshotRevision),
    };
    setSnapshot(next);
    setElapsedMs(next.elapsedMs);
    setUnauthorized(false);
    setError(null);
    return true;
  }, []);

  useEffect(() => {
    authorizationBlockedRef.current = false;
    let cancelled = false;
    let authBlocked = false;
    let requestInFlight = false;
    let requestController: AbortController | null = null;
    let retryTimer: number | undefined;
    let streamRecoveryNeeded = false;
    let streamRecoveryAttempt = 0;
    let events: EventSource | null = null;

    const clearRetryTimer = () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
    };

    const stopForUnauthorized = () => {
      authBlocked = true;
      authorizationBlockedRef.current = true;
      streamRecoveryNeeded = false;
      clearRetryTimer();
      loadingRefreshRef.current = null;
      events?.close();
      setStreamConnected(false);
      setError(null);
      setUnauthorized(true);
    };

    const scheduleStreamRecovery = () => {
      if (
        cancelled
        || authBlocked
        || !streamRecoveryNeeded
        || retryTimer !== undefined
      ) return;
      const delay = PLAYER_REFRESH_RETRY_DELAYS_MS[
        Math.min(streamRecoveryAttempt, PLAYER_REFRESH_RETRY_DELAYS_MS.length - 1)
      ];
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        if (cancelled || authBlocked || !streamRecoveryNeeded) return;
        if (requestInFlight) {
          scheduleStreamRecovery();
          return;
        }
        streamRecoveryAttempt += 1;
        void requestSnapshot('stream-recovery');
      }, delay);
    };

    const requestSnapshot = async (
      source: 'initial' | 'stream-recovery' | 'loading-watchdog',
    ) => {
      if (cancelled || authBlocked || requestInFlight) return;
      requestInFlight = true;
      const controller = new AbortController();
      requestController = controller;
      const timeout = window.setTimeout(() => controller.abort(), PLAYER_REFRESH_TIMEOUT_MS);
      try {
        const next = await api<unknown>('/api/player', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (cancelled || authBlocked) return;
        if (!isPlayerSnapshot(next)) throw new Error('播放器返回了无效数据');
        acceptSnapshot(next);
      } catch (reason) {
        if (cancelled || authBlocked) return;
        if (reason instanceof ApiError && reason.status === 401) {
          stopForUnauthorized();
          return;
        }
        if (latestSnapshotRef.current === null) {
          setError(
            controller.signal.aborted
              ? '播放器响应超时'
              : reason instanceof Error ? reason.message : '播放器加载失败',
          );
        }
        if (source === 'initial') streamRecoveryNeeded = true;
      } finally {
        window.clearTimeout(timeout);
        if (requestController === controller) requestController = null;
        requestInFlight = false;
        if (streamRecoveryNeeded) scheduleStreamRecovery();
      }
    };

    loadingRefreshRef.current = () => {
      if (cancelled || authBlocked || requestInFlight || streamRecoveryNeeded) return;
      void requestSnapshot('loading-watchdog');
    };

    void requestSnapshot('initial');

    events = new EventSource('/api/events');
    events.addEventListener('open', () => {
      if (!cancelled && !authBlocked) setStreamConnected(true);
    });
    events.addEventListener('error', () => {
      if (cancelled || authBlocked) return;
      streamRecoveryNeeded = true;
      setStreamConnected(false);
      scheduleStreamRecovery();
    });
    events.addEventListener('snapshot', (event) => {
      if (cancelled || authBlocked) return;
      try {
        const next: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (!isPlayerSnapshot(next)) {
          throw new Error('Invalid player snapshot');
        }
        if (acceptSnapshot(next)) {
          streamRecoveryNeeded = false;
          streamRecoveryAttempt = 0;
          clearRetryTimer();
          setStreamConnected(true);
        }
      } catch {
        streamRecoveryNeeded = true;
        setStreamConnected(false);
        scheduleStreamRecovery();
      }
    });
    return () => {
      cancelled = true;
      streamRecoveryNeeded = false;
      clearRetryTimer();
      if (loadingRefreshRef.current) loadingRefreshRef.current = null;
      requestController?.abort();
      events?.close();
    };
  }, [acceptSnapshot]);

  const loadingKey = loadingSnapshotKey(snapshot);
  useEffect(() => {
    if (!loadingKey || unauthorized) return;
    const watchdog = window.setInterval(() => {
      loadingRefreshRef.current?.();
    }, LOADING_WATCHDOG_MS);
    return () => window.clearInterval(watchdog);
  }, [loadingKey, unauthorized]);

  const setOffset = useCallback(async (offset: number) => {
    acceptSnapshot(
      await api<PlayerSnapshot>('/api/lyrics/offset', {
        method: 'PUT',
        body: JSON.stringify({ offsetMs: offset }),
      }),
    );
  }, [acceptSnapshot]);

  const demoAction = useCallback(async (action: 'toggle' | 'restart' | 'forward') => {
    acceptSnapshot(
      await api<PlayerSnapshot>('/api/demo/action', {
        method: 'POST',
        body: JSON.stringify({ action }),
      }),
    );
  }, [acceptSnapshot]);

  return {
    snapshot,
    elapsedMs,
    streamConnected,
    unauthorized,
    error,
    setOffset,
    demoAction,
  };
}
