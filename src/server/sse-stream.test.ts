import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { LatestSseStream, type SseStreamObserver } from './sse-stream.js';

class ResponseStub extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  readonly writes: string[] = [];
  readonly writeResults: boolean[] = [];
  writeError: Error | undefined;

  write(payload: string): boolean {
    if (this.writeError) throw this.writeError;
    this.writes.push(payload);
    return this.writeResults.shift() ?? true;
  }
}

function observer(): SseStreamObserver {
  return {
    snapshotWritten: vi.fn(),
    heartbeatWritten: vi.fn(),
    backpressure: vi.fn(),
    snapshotCoalesced: vi.fn(),
    heartbeatSkipped: vi.fn(),
    writeFailed: vi.fn(),
  };
}

function response(stub: ResponseStub): ServerResponse {
  return stub as unknown as ServerResponse;
}

describe('LatestSseStream', () => {
  it('retains only the latest snapshot while the client is backpressured', () => {
    const raw = new ResponseStub();
    raw.writableLength = 16_384;
    raw.writeResults.push(false, true);
    const observed = observer();
    const stream = new LatestSseStream(response(raw), observed);

    stream.writeSnapshot('{"revision":1}');
    stream.writeSnapshot('{"revision":2}');
    stream.writeSnapshot('{"revision":3}');
    stream.writeHeartbeat();

    expect(raw.writes).toEqual([
      'event: snapshot\ndata: {"revision":1}\n\n',
    ]);
    expect(observed.backpressure).toHaveBeenCalledWith(16_384);
    expect(observed.snapshotCoalesced).toHaveBeenCalledTimes(1);
    expect(observed.heartbeatSkipped).toHaveBeenCalledTimes(1);

    raw.emit('drain');

    expect(raw.writes).toEqual([
      'event: snapshot\ndata: {"revision":1}\n\n',
      'event: snapshot\ndata: {"revision":3}\n\n',
    ]);
    expect(observed.snapshotWritten).toHaveBeenCalledTimes(2);
  });

  it('waits for another drain when flushing the latest snapshot backpressures again', () => {
    const raw = new ResponseStub();
    raw.writeResults.push(false, false, true);
    const observed = observer();
    const stream = new LatestSseStream(response(raw), observed);

    stream.writeHeartbeat();
    stream.writeSnapshot('{"revision":1}');
    raw.emit('drain');
    stream.writeSnapshot('{"revision":2}');
    raw.emit('drain');

    expect(raw.writes).toEqual([
      ': keepalive\n\n',
      'event: snapshot\ndata: {"revision":1}\n\n',
      'event: snapshot\ndata: {"revision":2}\n\n',
    ]);
    expect(observed.backpressure).toHaveBeenCalledTimes(2);
  });

  it('stops pending writes when disposed', () => {
    const raw = new ResponseStub();
    raw.writeResults.push(false);
    const observed = observer();
    const stream = new LatestSseStream(response(raw), observed);

    stream.writeSnapshot('{"revision":1}');
    stream.writeSnapshot('{"revision":2}');
    stream.dispose();
    raw.emit('drain');

    expect(raw.writes).toHaveLength(1);
    expect(raw.listenerCount('drain')).toBe(0);
  });

  it('reports response write failures without throwing into the publisher', () => {
    const raw = new ResponseStub();
    raw.writeError = new Error('socket closed');
    const observed = observer();
    const stream = new LatestSseStream(response(raw), observed);

    expect(() => stream.writeSnapshot('{"revision":1}')).not.toThrow();
    expect(observed.writeFailed).toHaveBeenCalledTimes(1);
    expect(observed.snapshotWritten).not.toHaveBeenCalled();
  });
});
