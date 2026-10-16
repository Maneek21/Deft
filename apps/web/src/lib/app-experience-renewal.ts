/** The original consent interval is never extended by Web token rotation. */
export function experienceRenewalDue(sessionExpiry: string, exposureExpiry: string | undefined, now = Date.now()): boolean {
  const deadline = Math.min(Date.parse(sessionExpiry), exposureExpiry ? Date.parse(exposureExpiry) : Infinity);
  return Number.isFinite(deadline) && deadline > now && deadline - now <= 90_000;
}

/** Wait only for writes already dispatched by the host, not unseen Worker debounce. */
export async function settleDispatchedExperienceWrites(writes: Iterable<Promise<unknown>>, timeoutMs = 5_000): Promise<boolean> {
  const snapshot = Array.from(writes);
  if (!snapshot.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(snapshot).then(results => results.every(result => result.status === 'fulfilled')),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
