interface SharedTask<T> {
  controller: AbortController;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  run: (signal: AbortSignal) => Promise<T>;
  subscribers: number;
  finished: boolean;
}

/** Coalesces identical work without letting one subscriber cancel another. */
export class SharedTaskPool<T> {
  private readonly tasks = new Map<string, SharedTask<T>>();
  private readonly queue = new Set<SharedTask<T>>();
  private active = 0;

  constructor(private readonly concurrency = Infinity) {
    if (!(concurrency >= 1)) throw new Error('Concurrency must be positive');
  }

  get size(): number {
    return this.tasks.size;
  }
  has(key: string): boolean {
    return this.tasks.has(key);
  }

  /** Invalidate coalescing; existing subscribers can still finish their work. */
  forget(key: string): void {
    this.tasks.delete(key);
  }

  run(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let task = this.tasks.get(key);
    if (!task) {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      task = {
        promise,
        resolve,
        reject,
        controller: new AbortController(),
        run,
        subscribers: 0,
        finished: false,
      };
      this.tasks.set(key, task);
      this.queue.add(task);
    }
    const shared = task;
    shared.subscribers += 1;
    const subscribed = new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        shared.subscribers -= 1;
        if (shared.subscribers === 0) {
          if (this.tasks.get(key) === shared) this.tasks.delete(key);
          if (this.queue.delete(shared)) shared.reject(signal?.reason);
          if (!shared.finished) shared.controller.abort(signal?.reason);
        }
        callback();
      };
      const onAbort = () => finish(() => reject(signal!.reason));
      signal?.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
    this.drain();
    return subscribed;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.size > 0) {
      const task = this.queue.values().next().value!;
      this.queue.delete(task);
      this.active += 1;
      // Keep the slot until the underlying operation settles, even on abort.
      const operation = (async () => {
        task.controller.signal.throwIfAborted();
        return task.run(task.controller.signal);
      })();
      void operation
        .then(
          (value) => {
            task.finished = true;
            task.resolve(value);
          },
          (error: unknown) => {
            task.finished = true;
            task.reject(error);
          },
        )
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
