import { SharedTaskPool } from './shared-task-pool.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('SharedTaskPool', () => {
  it('rejects invalid concurrency and already canceled callers without starting work', async () => {
    expect(() => new SharedTaskPool(0)).toThrow('Concurrency must be positive');
    const pool = new SharedTaskPool<string>();
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => 'unused');
    await expect(pool.run('song', run, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(run).not.toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  it('keeps a shared request alive until the last subscriber leaves', async () => {
    const pool = new SharedTaskPool<string>();
    const gate = deferred<string>();
    const run = vi.fn((_signal: AbortSignal) => gate.promise);
    const first = new AbortController();
    const second = new AbortController();
    const a = pool.run('song', run, first.signal);
    const b = pool.run('song', run, second.signal);
    first.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].aborted).toBe(false);
    gate.resolve('lyrics');
    await expect(b).resolves.toBe('lyrics');
    expect(pool.size).toBe(0);
  });

  it('cancels the last subscriber immediately but holds the slot until work settles', async () => {
    const pool = new SharedTaskPool<string>(1);
    const gate = deferred<string>();
    const oldRun = vi.fn((_signal: AbortSignal) => gate.promise);
    const nextRun = vi.fn(async () => 'new');
    const controller = new AbortController();
    const old = pool.run('song', oldRun, controller.signal);
    controller.abort();
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    expect(oldRun.mock.calls[0][0].aborted).toBe(true);
    const next = pool.run('song', nextRun);
    expect(nextRun).not.toHaveBeenCalled();
    gate.resolve('obsolete');
    await expect(next).resolves.toBe('new');
    expect(pool.size).toBe(0);
  });

  it('removes canceled queued tasks without executing them', async () => {
    const pool = new SharedTaskPool<string>(1);
    const gate = deferred<string>();
    const active = pool.run('active', () => gate.promise);
    const controller = new AbortController();
    const queuedRun = vi.fn(async () => 'unused');
    const queued = pool.run('queued', queuedRun, controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve('done');
    await active;
    await expect(pool.run('next', async () => 'next')).resolves.toBe('next');
    expect(queuedRun).not.toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  it('releases concurrency after a synchronous failure', async () => {
    const pool = new SharedTaskPool<string>(1);
    const broken = pool.run('broken', () => {
      throw new Error('failed');
    });
    const next = pool.run('next', async () => 'healthy');
    await expect(broken).rejects.toThrow('failed');
    await expect(next).resolves.toBe('healthy');
  });

  it('does not let an invalidated task delete its replacement', async () => {
    const pool = new SharedTaskPool<string>();
    const old = deferred<string>();
    const next = deferred<string>();
    const a = pool.run('song', () => old.promise);
    pool.forget('song');
    const b = pool.run('song', () => next.promise);
    old.resolve('old');
    await a;
    expect(pool.has('song')).toBe(true);
    next.resolve('new');
    await expect(b).resolves.toBe('new');
    expect(pool.size).toBe(0);
  });
});
