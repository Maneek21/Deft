import { RESOURCE_ATTACHMENT_LIMITS } from '@deft/app-kit';
import { AppError } from './app-errors.js';

/** HTTP completion is bounded even if an adapter ignores abort. Its occupied
 * permit is retained until actual I/O settles; late work must check this
 * signal before publishing authority. No timed-out operation starts a retry. */
export class AppAttachmentTransferLimiter {
  #active = 0;
  constructor(private readonly durationMs = RESOURCE_ATTACHMENT_LIMITS.transfer_ms) {}
  async run<T>(operation: (signal: AbortSignal, deadline: number) => Promise<T>, caller?: AbortSignal, outerDeadline?:number): Promise<T> {
    caller?.throwIfAborted();
    if (this.#active >= RESOURCE_ATTACHMENT_LIMITS.concurrent_transfers) {
      throw new AppError('Attachment transfer capacity unavailable', 'APP_STATE_CONFLICT', 503);
    }
    this.#active++;
    const controller = new AbortController();
    const signal = caller ? AbortSignal.any([caller,controller.signal]) : controller.signal;
    const deadline = Math.min(performance.now() + this.durationMs,outerDeadline??Number.POSITIVE_INFINITY);
    if(deadline<=performance.now()){this.#active--;throw new AppError('Attachment transfer unavailable','APP_STATE_CONFLICT',503);}
    let settled = false;
    const timer = setTimeout(() => controller.abort(new Error('Attachment transfer deadline')),Math.max(1,deadline-performance.now()));
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal,deadline); });
    let listener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve,reject) => {
      listener = () => reject(new AppError('Attachment transfer unavailable', 'APP_STATE_CONFLICT', 503));
      signal.addEventListener('abort',listener,{once:true}); if (signal.aborted) listener();
    });
    const finished = () => { if (!settled) { settled=true; this.#active--; }
      clearTimeout(timer); if (listener) signal.removeEventListener('abort',listener); };
    void work.then(finished,finished);
    return Promise.race([work,aborted]);
  }
}
