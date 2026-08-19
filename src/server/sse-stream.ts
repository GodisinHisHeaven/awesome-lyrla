import type { ServerResponse } from 'node:http';

type SseResponse = Pick<
  ServerResponse,
  'destroyed' | 'off' | 'once' | 'writableEnded' | 'writableLength' | 'write'
>;

export interface SseStreamObserver {
  snapshotWritten(): void;
  heartbeatWritten(): void;
  backpressure(bufferedBytes: number): void;
  snapshotCoalesced(): void;
  heartbeatSkipped(): void;
  writeFailed(): void;
}

/**
 * Writes an SSE stream without allowing a slow client to build an unbounded
 * queue. While the response is backpressured, only the newest snapshot is
 * retained and heartbeats are unnecessary because a write is already pending.
 */
export class LatestSseStream {
  private blocked = false;
  private disposed = false;
  private pendingSnapshot: string | undefined;

  constructor(
    private readonly response: SseResponse,
    private readonly observer: SseStreamObserver,
  ) {}

  writeSnapshot(serializedSnapshot: string): void {
    if (this.disposed) return;
    if (this.blocked) {
      if (this.pendingSnapshot !== undefined) this.observer.snapshotCoalesced();
      this.pendingSnapshot = serializedSnapshot;
      return;
    }
    this.write(`event: snapshot\ndata: ${serializedSnapshot}\n\n`, 'snapshot');
  }

  writeHeartbeat(): void {
    if (this.disposed) return;
    if (this.blocked) {
      this.observer.heartbeatSkipped();
      return;
    }
    this.write(': keepalive\n\n', 'heartbeat');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingSnapshot = undefined;
    if (this.blocked) this.response.off('drain', this.handleDrain);
  }

  private readonly handleDrain = (): void => {
    if (this.disposed) return;
    this.blocked = false;
    const snapshot = this.pendingSnapshot;
    this.pendingSnapshot = undefined;
    if (snapshot !== undefined) this.writeSnapshot(snapshot);
  };

  private write(payload: string, kind: 'snapshot' | 'heartbeat'): void {
    if (this.response.writableEnded || this.response.destroyed) return;
    try {
      const accepted = this.response.write(payload);
      if (kind === 'snapshot') this.observer.snapshotWritten();
      else this.observer.heartbeatWritten();
      if (!accepted) {
        this.blocked = true;
        this.response.once('drain', this.handleDrain);
        this.observer.backpressure(this.response.writableLength);
      }
    } catch {
      this.observer.writeFailed();
    }
  }
}
