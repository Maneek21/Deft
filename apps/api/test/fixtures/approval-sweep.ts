/**
 * The maintenance sweep takes its advisory connection within a short bound and
 * reports `poolBusy` when the small advisory pool has not yet replaced a
 * connection. A busy pass may still have completed some work before it hit the
 * busy pool, so tests that assert on what the sweep did wait out a busy pool
 * and receive the work counters of every pass added together, with `poolBusy`
 * taken from the last pass.
 */
export async function sweepUntilNotBusy<T extends { poolBusy: boolean }>(
  run: () => Promise<T>,
  { attempts = 20, pauseMs = 150 }: { attempts?: number; pauseMs?: number } = {},
): Promise<T> {
  let total: T | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run();
    total = total === null ? result : addCounters(total, result);
    if (!result.poolBusy) return total;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  throw new Error(`sweep still reported a busy pool after ${attempts} attempts`);
}

function addCounters<T extends { poolBusy: boolean }>(sum: T, next: T): T {
  const merged: Record<string, unknown> = { ...sum };
  for (const [key, value] of Object.entries(next)) {
    const prior = merged[key];
    merged[key] = typeof value === 'number' && typeof prior === 'number' ? prior + value : value;
  }
  return merged as T;
}
