import { sql } from 'drizzle-orm';
import type { AppRunTransaction } from './app-run-repository.js';

export type PrivateAccessClock = {
  current: () => Date; issuance: () => Date;
  bindDeadline: (expires: Date) => () => Date;
  expired: () => boolean;
};

/** Authority expires against the conservative upper clock. Issuance uses the
 * lower clock so a maximum TTL cannot exceed the database's accepted_at cap.
 * The interval between dispatch and response is counted only in the upper
 * bound: a delayed SQL response must not prolong private disclosure. */
export function privateAccessClockBounds(
  applicationClock: () => Date,
  applicationSample: number,
  databaseSample: number,
  dispatchedAt: number,
  receivedAt: number,
  monotonic: () => number = () => performance.now(),
): PrivateAccessClock {
  if (![applicationSample, databaseSample, dispatchedAt, receivedAt].every(Number.isFinite)
    || receivedAt < dispatchedAt) throw new Error('Private access clock unavailable');
  let deadline = Infinity;
  const current = () => {
      const elapsed = Math.max(0, monotonic() - dispatchedAt);
      const applicationNow = applicationClock().getTime();
      if (!Number.isFinite(applicationNow)) throw new Error('Private access clock unavailable');
      return new Date(Math.max(applicationNow, applicationSample + elapsed, databaseSample + elapsed));
  };
  return {
    current,
    issuance: () => {
      const elapsed = Math.max(0, monotonic() - receivedAt);
      const applicationNow = applicationClock().getTime();
      if (!Number.isFinite(applicationNow)) throw new Error('Private access clock unavailable');
      return new Date(Math.min(applicationNow, applicationSample + elapsed, databaseSample + elapsed));
    },
    bindDeadline: expires => {
      if (!Number.isFinite(expires.getTime())) throw new Error('Private access deadline unavailable');
      deadline = Math.min(deadline, expires.getTime());
      return current;
    },
    expired: () => deadline <= current().getTime(),
  };
}

export async function samplePrivateAccessClock(tx: AppRunTransaction, applicationClock: () => Date) {
  const dispatchedAt = performance.now(), applicationSample = applicationClock().getTime();
  const result = await tx.execute(sql`SELECT (extract(epoch FROM clock_timestamp())*1000)::text AS now_ms`);
  const receivedAt = performance.now(), databaseSample = Number(result.rows[0]?.now_ms);
  return privateAccessClockBounds(applicationClock, applicationSample, databaseSample, dispatchedAt, receivedAt);
}
