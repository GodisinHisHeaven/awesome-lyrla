// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type { PlayerSnapshot } from '../../shared/contracts.js';
import { usePlayer } from './usePlayer.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function snapshot(
  capturedAtMs: number,
  title: string,
  elapsedMs = 0,
  snapshotRevision = capturedAtMs,
): PlayerSnapshot {
  return {
    mode: 'live',
    connection: 'connected',
    track: {
      title,
      artist: 'Test Artist',
      album: 'Test Album',
      durationMs: 180_000,
      source: 'Apple Music',
    },
    playbackStatus: 'playing',
    elapsedMs,
    capturedAtMs,
    snapshotRevision,
    manualOffsetMs: 0,
    lyrics: {
      kind: 'synced',
      lines: [{ id: '0', startMs: 0, text: `${title} lyrics` }],
      provider: 'apple',
    },
    artworkPalette: null,
  };
}

function response(payload: PlayerSnapshot): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function errorResponse(status: number, message: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: message }),
    text: async () => JSON.stringify({ error: message }),
  } as Response;
}

function loadingSnapshot(
  capturedAtMs: number,
  title: string,
  generation: number,
  snapshotRevision = capturedAtMs,
): PlayerSnapshot {
  return {
    ...snapshot(capturedAtMs, title, 0, snapshotRevision),
    trackGeneration: generation,
    lyricsGeneration: generation,
    lyrics: { kind: 'loading', lines: [], provider: null },
  };
}

async function settlePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class MockEventSource {
  static latest: MockEventSource | null = null;

  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {
    MockEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emitSnapshot(payload: PlayerSnapshot): void {
    this.emitRawSnapshot(JSON.stringify(payload));
  }

  emitRawSnapshot(data: string): void {
    const event = new MessageEvent('snapshot', { data });
    for (const listener of this.listeners.get('snapshot') ?? []) listener(event);
  }

  emitOpen(): void {
    const event = new Event('open');
    for (const listener of this.listeners.get('open') ?? []) listener(event);
  }

  emitError(): void {
    const event = new Event('error');
    for (const listener of this.listeners.get('error') ?? []) listener(event);
  }

  close = vi.fn();
}

describe('usePlayer snapshot ordering', () => {
  beforeEach(() => {
    MockEventSource.latest = null;
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not let a delayed initial HTTP snapshot or older SSE event replace a newer SSE snapshot', async () => {
    const initialHttp = deferred<Response>();
    const fetchMock = vi.fn(() => initialHttp.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    const events = MockEventSource.latest;
    expect(events?.url).toBe('/api/events');
    expect(fetchMock).toHaveBeenCalledWith('/api/player', expect.objectContaining({
      cache: 'no-store',
    }));

    act(() => {
      events?.emitSnapshot(snapshot(200, 'New Track', 500, 2));
    });
    expect(result.current.snapshot?.track?.title).toBe('New Track');

    await act(async () => {
      initialHttp.resolve(response(snapshot(200, 'Old HTTP Track', 80_000, 1)));
      await initialHttp.promise;
      await Promise.resolve();
    });
    expect(result.current.snapshot?.track?.title).toBe('New Track');
    expect(result.current.elapsedMs).toBe(500);

    act(() => {
      events?.emitSnapshot(snapshot(200, 'Old SSE Track', 90_000, 1));
    });
    expect(result.current.snapshot?.track?.title).toBe('New Track');
    expect(result.current.elapsedMs).toBe(500);
  });

  it('does not let an older mutation response replace a newer SSE snapshot', async () => {
    const mutation = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot(100, 'Initial Track', 1_000, 1)))
      .mockImplementationOnce(() => mutation.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.snapshot?.track?.title).toBe('Initial Track');

    let offsetRequest!: Promise<void>;
    act(() => {
      offsetRequest = result.current.setOffset(250);
    });
    act(() => {
      MockEventSource.latest?.emitSnapshot(snapshot(300, 'Current Track', 2_000, 3));
    });

    await act(async () => {
      mutation.resolve(response(snapshot(300, 'Stale Mutation Track', 50_000, 2)));
      await offsetRequest;
    });
    expect(result.current.snapshot?.track?.title).toBe('Current Track');
    expect(result.current.elapsedMs).toBe(2_000);
  });

  it('accepts a lower revision only when its capture time proves a server restart', () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    act(() => {
      MockEventSource.latest?.emitSnapshot(snapshot(1_000, 'Before Restart', 5_000, 900));
      MockEventSource.latest?.emitSnapshot(snapshot(2_000, 'After Restart', 100, 1));
      MockEventSource.latest?.emitSnapshot(snapshot(1_500, 'Delayed Old Process', 90_000, 901));
    });

    expect(result.current.snapshot?.track?.title).toBe('After Restart');
    expect(result.current.elapsedMs).toBe(100);
  });

  it('backs off recovery GETs after an SSE error and cancels them on a valid snapshot', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot(100, 'Initial Track', 1_000, 1)))
      .mockResolvedValueOnce(response(snapshot(110, 'Recovered by HTTP', 1_100, 1)))
      .mockResolvedValueOnce(response(snapshot(120, 'Recovered by HTTP again', 1_200, 1)));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => usePlayer());
    await act(settlePromises);

    act(() => {
      MockEventSource.latest?.emitError();
      MockEventSource.latest?.emitError();
      vi.advanceTimersByTime(999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1_999);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    act(() => {
      MockEventSource.latest?.emitSnapshot(snapshot(200, 'SSE Restored', 2_000, 2));
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps initial and recovery GETs single-flight', async () => {
    vi.useFakeTimers();
    const initial = deferred<Response>();
    const recovery = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => recovery.promise);
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => usePlayer());
    act(() => {
      MockEventSource.latest?.emitError();
      vi.advanceTimersByTime(2_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      initial.resolve(response(snapshot(100, 'Initial Track', 1_000, 1)));
      await settlePromises();
      vi.advanceTimersByTime(1_000);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => {
      MockEventSource.latest?.emitError();
      vi.advanceTimersByTime(1_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      recovery.resolve(response(snapshot(110, 'Recovery Track', 1_100, 1)));
      await settlePromises();
    });
  });

  it('aborts an unresponsive initial GET after eight seconds and keeps recovering', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchMock.mock.calls.length > 1) {
        return Promise.resolve(response(snapshot(200, 'Recovered Track', 2_000, 2)));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(async () => {
      vi.advanceTimersByTime(8_000);
      await settlePromises();
    });
    expect(result.current.error).toBe('播放器响应超时');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.track?.title).toBe('Recovered Track');
  });

  it('uses a generation-keyed 30 second watchdog without telemetry postponing it', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(loadingSnapshot(100, 'Track A', 1, 1)))
      .mockResolvedValueOnce(response(loadingSnapshot(130, 'Track A', 1, 1)));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => usePlayer());
    await act(settlePromises);

    act(() => vi.advanceTimersByTime(20_000));
    act(() => {
      MockEventSource.latest?.emitSnapshot(loadingSnapshot(120, 'Track A', 1, 2));
      vi.advanceTimersByTime(9_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('restarts the loading watchdog for a new generation and stops after resolution', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(loadingSnapshot(100, 'Track A', 1, 1)))
      .mockResolvedValueOnce(response(snapshot(300, 'Track B', 3_000, 3)));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => usePlayer());
    await act(settlePromises);

    act(() => vi.advanceTimersByTime(20_000));
    act(() => MockEventSource.latest?.emitSnapshot(loadingSnapshot(200, 'Track B', 2, 2)));
    act(() => vi.advanceTimersByTime(29_999));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a delayed recovery GET replace a newer SSE snapshot', async () => {
    vi.useFakeTimers();
    const recovery = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot(100, 'Initial Track', 1_000, 1)))
      .mockImplementationOnce(() => recovery.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(settlePromises);
    await act(async () => {
      MockEventSource.latest?.emitError();
      vi.advanceTimersByTime(1_000);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => {
      MockEventSource.latest?.emitSnapshot(snapshot(300, 'Current SSE Track', 3_000, 3));
    });
    await act(async () => {
      recovery.resolve(response(snapshot(200, 'Stale HTTP Track', 80_000, 2)));
      await settlePromises();
    });

    expect(result.current.snapshot?.track?.title).toBe('Current SSE Track');
    expect(result.current.elapsedMs).toBe(3_000);
  });

  it('stops the stream and all retries when the initial GET returns 401', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401, 'Not authorized'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(settlePromises);

    expect(result.current.unauthorized).toBe(true);
    expect(result.current.error).toBeNull();
    expect(MockEventSource.latest?.close).toHaveBeenCalledTimes(1);

    act(() => {
      MockEventSource.latest?.emitError();
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops an established player session when a recovery GET returns 401', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot(100, 'Initial Track', 1_000, 1)))
      .mockResolvedValueOnce(errorResponse(401, 'Expired activation'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(settlePromises);
    await act(async () => {
      MockEventSource.latest?.emitError();
      vi.advanceTimersByTime(1_000);
      await settlePromises();
    });

    expect(result.current.unauthorized).toBe(true);
    expect(MockEventSource.latest?.close).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a delayed mutation reopen a session after a recovery 401', async () => {
    vi.useFakeTimers();
    const mutation = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot(100, 'Initial Track', 1_000, 1)))
      .mockImplementationOnce(() => mutation.promise)
      .mockResolvedValueOnce(errorResponse(401, 'Expired activation'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(settlePromises);
    let mutationRequest!: Promise<void>;
    act(() => {
      mutationRequest = result.current.setOffset(250);
      MockEventSource.latest?.emitError();
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await settlePromises();
    });
    expect(result.current.unauthorized).toBe(true);

    await act(async () => {
      mutation.resolve(response(snapshot(300, 'Delayed Mutation', 3_000, 3)));
      await mutationRequest;
    });
    expect(result.current.unauthorized).toBe(true);
    expect(result.current.snapshot?.track?.title).toBe('Initial Track');
  });

  it('protects against malformed SSE snapshots and recovers through HTTP', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot(100, 'Initial Track', 1_000, 1)))
      .mockResolvedValueOnce(response(snapshot(200, 'HTTP Recovery', 2_000, 2)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(settlePromises);
    act(() => MockEventSource.latest?.emitRawSnapshot('{not-json'));
    expect(result.current.streamConnected).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.track?.title).toBe('HTTP Recovery');
  });

  it('rejects structurally incomplete initial JSON and starts recovery', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ capturedAtMs: 1 } as PlayerSnapshot))
      .mockResolvedValueOnce(response(snapshot(200, 'Valid Recovery', 2_000, 2)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(settlePromises);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBe('播放器返回了无效数据');

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.track?.title).toBe('Valid Recovery');
  });

  it('does not let an incomplete or stale SSE event cancel HTTP recovery', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(snapshot(200, 'Current Track', 2_000, 2)))
      .mockResolvedValueOnce(response(snapshot(300, 'HTTP Recovery', 3_000, 3)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePlayer());
    await act(settlePromises);
    act(() => {
      MockEventSource.latest?.emitError();
      MockEventSource.latest?.emitRawSnapshot(JSON.stringify({ capturedAtMs: 250 }));
      MockEventSource.latest?.emitSnapshot(snapshot(100, 'Stale SSE', 1_000, 1));
    });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await settlePromises();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.track?.title).toBe('HTTP Recovery');
  });

  it('closes the stream, clears retries, and aborts the in-flight GET on unmount', () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() => usePlayer());
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    act(() => MockEventSource.latest?.emitError());
    unmount();

    expect(MockEventSource.latest?.close).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    act(() => vi.advanceTimersByTime(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
