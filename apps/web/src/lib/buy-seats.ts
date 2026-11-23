/**
 * The "Buy more seats" link. The API sends `buy_seats_url` only to the owner
 * of a hosted workspace whose control plane has a seats page; everyone else,
 * and every self-hosted install, gets none. This only refuses anything that
 * is not an https address, so a bad value never becomes a link.
 */
export function buySeatsHref(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The link for a refused add, when it was refused for want of seats. */
export function buySeatsHrefForRefusal(body: unknown): string | null {
  const refusal = body as { code?: unknown; buy_seats_url?: unknown } | null;
  return refusal?.code === 'SEAT_LIMIT_REACHED' ? buySeatsHref(refusal.buy_seats_url) : null;
}
