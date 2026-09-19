/** Compare server time with the request interval, allowing for network latency. */
export function assessDatabaseClock(input: {
  startedAtMs: number;
  finishedAtMs: number;
  databaseTimeMs: number;
}) {
  const { startedAtMs, finishedAtMs, databaseTimeMs } = input;
  if (![startedAtMs, finishedAtMs, databaseTimeMs].every(Number.isFinite)
    || finishedAtMs < startedAtMs) {
    return { name: 'Database clock', ok: false,
      detail: 'Could not compare clocks reliably. Check time synchronization and rerun the doctor.' };
  }
  // A database timestamp anywhere inside the request interval is consistent.
  const offsetMs = databaseTimeMs < startedAtMs ? databaseTimeMs - startedAtMs
    : databaseTimeMs > finishedAtMs ? databaseTimeMs - finishedAtMs : 0;
  const ok = Math.abs(offsetMs) <= 5_000;
  return { name: 'Database clock', ok,
    detail: ok
      ? 'Database time agrees with this host within 5 seconds (allowing for request latency). Run this check on the API host.'
      : `Database time is at least ${Math.abs(offsetMs / 1000).toFixed(1)} seconds ${offsetMs > 0 ? 'ahead of' : 'behind'} this host. Synchronize the API host and database/VM clocks; mixed clocks can make updates appear before creation. Historical timestamps are not changed by this check.` };
}
