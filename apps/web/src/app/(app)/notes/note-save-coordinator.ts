export type NoteSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type SaveRequest = (payload: Record<string, unknown>) => Promise<boolean>;
type StatusListener = (status: NoteSaveStatus) => void;

/**
 * Keeps every note mutation on one ordered lane and tracks dirtiness per field.
 * A successful title/icon write therefore cannot acknowledge an unsent body edit.
 */
export class NoteSaveCoordinator {
  private revisions = new Map<string, number>();
  private dirty = new Map<string, number>();
  private failed = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private currentStatus: NoteSaveStatus = 'idle';

  constructor(
    private readonly request: SaveRequest,
    private readonly onStatus: StatusListener = () => {},
  ) {}

  get status(): NoteSaveStatus {
    return this.currentStatus;
  }

  markDirty(field: string): number {
    const revision = (this.revisions.get(field) ?? 0) + 1;
    this.revisions.set(field, revision);
    this.dirty.set(field, revision);
    this.failed.delete(field);
    this.setStatus('saving');
    return revision;
  }

  isDirty(field: string): boolean {
    return this.dirty.has(field);
  }

  async awaitIdle(): Promise<void> {
    while (true) {
      const observedQueue = this.queue;
      await observedQueue;
      if (this.queue === observedQueue) return;
    }
  }

  save(field: string, revision: number, payload: Record<string, unknown>): Promise<void> {
    const operation = async () => {
      this.inFlight += 1;
      this.updateStatus();
      try {
        const ok = await this.request(payload);
        if (ok) {
          if (this.dirty.get(field) === revision) this.dirty.delete(field);
          if (this.failed.get(field) === revision) this.failed.delete(field);
        } else if (this.dirty.get(field) === revision) {
          this.failed.set(field, revision);
        }
      } catch {
        if (this.dirty.get(field) === revision) this.failed.set(field, revision);
      } finally {
        this.inFlight -= 1;
        this.updateStatus();
      }
    };

    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  private updateStatus() {
    if (this.failed.size > 0) this.setStatus('error');
    else if (this.dirty.size > 0 || this.inFlight > 0) this.setStatus('saving');
    else this.setStatus('saved');
  }

  private setStatus(status: NoteSaveStatus) {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.onStatus(status);
  }
}
