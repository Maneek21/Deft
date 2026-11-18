import type pg from 'pg';

const failures = new WeakMap<pg.PoolClient, Error>();
export function connectionFailure(client: pg.PoolClient): Error | undefined { return failures.get(client); }

/** Pool events cover idle sockets; connect listeners also cover checked-out clients. */
export function handleDatabaseConnectionErrors(pool: pg.Pool): void {
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on('acquire', client => checkedOut.add(client));
  pool.on('release', (_error, client) => checkedOut.delete(client));
  pool.on('error', () => console.warn('[database] Idle connection lost; reconnecting on next checkout'));
  pool.on('connect', client => {
    client.on('error', error => {
      failures.set(client, error);
      // Drizzle can fail BEGIN before entering its release finally. Destroy a
      // failed checkout here, and let later owner cleanup remain idempotent.
      if (checkedOut.has(client)) {
        const release = client.release;
        client.release = () => {};
        release.call(client, error);
      }
      console.warn('[database] Checked-out connection lost');
    });
  });
}

/** Drizzle wraps driver failures in cause. Never confuse unavailable storage with invalid credentials. */
export function isDatabaseFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    const code = (error as Error & { code?: string }).code;
    if (code && (/^[0-9A-Z]{5}$/.test(code) || /^(ECONN|ENET|EHOST|EPIPE|ETIMEDOUT|EAI_|ENOTFOUND)/.test(code))) return true;
    if (/connection terminated|connection timeout|timeout exceeded when trying to connect|query read timeout|client (?:has encountered a connection error and is|was closed and is) not queryable/i.test(error.message)) return true;
    error = error.cause;
  }
  return false;
}
