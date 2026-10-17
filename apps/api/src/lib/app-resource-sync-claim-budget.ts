import type { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
import type { AppRunTransaction } from './app-run-repository.js';

export const RESOURCE_SYNC_CLAIM_BUDGET_MS = 8_000;
export type ResourceSyncClaimRequest = Readonly<{ signal?: AbortSignal; deadline?: number }>;

/** One deadline covers pool acquisition, identity reads, recovery and claim.
 * The bounded database checks every query, including COMMIT, and discards the
 * connection on expiry/abort so a queued old request cannot claim after stop.
 */
export function resourceSyncClaimContext(
  database: Pick<ReturnType<typeof createBoundedAppRunDatabase>, 'transaction'>,
  request: ResourceSyncClaimRequest = {},
) {
  const signal = request.signal ?? new AbortController().signal;
  const deadline = Math.min(request.deadline ?? Infinity, performance.now() + RESOURCE_SYNC_CLAIM_BUDGET_MS);
  const check = () => {
    signal.throwIfAborted();
    if (!Number.isFinite(deadline) || performance.now() >= deadline) throw new Error('TIMEOUT');
  };
  check();
  return Object.freeze({ check,
    async transaction<T>(work: (tx: AppRunTransaction) => Promise<T>): Promise<T> {
      check();
      return database.transaction(async tx => {
        check(); // A late pool acquisition cannot start any claim work.
        const value = await work(tx);
        check(); // A delayed callback cannot publish a claim after its deadline.
        return value;
      }, signal, deadline);
    },
  });
}
