export type WorkerStartupPhase = 'not_required' | 'starting' | 'ready' | 'failed' | 'stopping';
export type WorkerStartupSnapshot = { required: boolean; phase: WorkerStartupPhase; attempts: number };

type Options = {
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onFailure?: (attempt: number, error: unknown) => void;
};

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Server lifecycle only: retries idempotent startup, never alters queued work. */
export class WorkerStartup {
  private state: WorkerStartupSnapshot = { required: false, phase: 'not_required', attempts: 0 };
  private readonly controller = new AbortController();
  private pending: Promise<boolean> | undefined;

  require(): void { this.state = { required: true, phase: 'starting', attempts: 0 }; }
  snapshot(): WorkerStartupSnapshot { return { ...this.state }; }
  isReady(): boolean { return !this.state.required || this.state.phase === 'ready'; }
  stop(): void { this.state = { ...this.state, phase: 'stopping' }; this.controller.abort(); }

  start(start: () => Promise<void>, options: Options = {}): Promise<boolean> {
    if (this.pending) return this.pending;
    if (this.controller.signal.aborted || this.state.phase === 'failed') return Promise.resolve(false);
    this.pending = this.run(start, options);
    return this.pending;
  }

  private async run(start: () => Promise<void>, options: Options): Promise<boolean> {
    const delays = [1000, 2000, 4000, 8000];
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (this.controller.signal.aborted) return false;
      this.state = { required: true, phase: 'starting', attempts: attempt };
      try {
        await start();
        if (this.controller.signal.aborted) return false;
        this.state = { required: true, phase: 'ready', attempts: attempt };
        return true;
      } catch (error) {
        if (this.controller.signal.aborted) return false;
        options.onFailure?.(attempt, error);
        if (attempt === 5) break;
        try { await (options.wait ?? wait)(delays[attempt - 1]!, this.controller.signal); }
        catch { if (this.controller.signal.aborted) return false; throw error; }
      }
    }
    this.state = { required: true, phase: 'failed', attempts: 5 };
    return false;
  }
}

// Importing the app in a source test does not start a real server. server.ts
// declares the requirement synchronously before opening its listening socket.
export const workerStartup = new WorkerStartup();
