/**
 * The maintenance sweep takes its advisory connection within a short bound and
 * reports `poolBusy` (doing nothing that pass) when the small advisory pool has
 * not yet replaced a connection. Tests that assert on what one sweep did wait
 * out a busy pool and use the first pass that was not busy.
 */
export async function sweepUntilNotBusy<T extends { poolBusy: boolean }>(
  run: () => Promise<T>,
  { attempts = 20, pauseMs = 150 }: { attempts?: number; pauseMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run();
    if (!result.poolBusy) return result;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  throw new Error(`sweep still reported a busy pool after ${attempts} attempts`);
}
