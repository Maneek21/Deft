import { appConsentDeadline, type AppConsentLifetime } from '@deft/app-kit/core';

type Pin = Readonly<{ id: string; digest: string }>;
type CurrentRow = { state: string; expires_at?: Date | null; snapshot?: { consent_lifetime?: AppConsentLifetime } };

/** Batch only unlocked reads. Issuance retains the original per-pin share-lock
 * order; every returned row still needs its exact current digest and expiry. */
export async function assertCurrentUpgradeRowPins<Row extends CurrentRow>(input: {
  pins: readonly Pin[]; issuance: boolean;
  read: (ids: readonly string[], share: boolean) => Promise<Row[]>;
  id: (row: Row) => string; digest: (row: Row) => string; denied: () => Error;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const valid = (row: Row | undefined, pin: Pin) => {
    if (!row || input.id(row) !== pin.id || row.state !== 'active' || input.digest(row) !== pin.digest
      || ('expires_at' in row && (row.expires_at === undefined
        || appConsentDeadline(row.expires_at, row.snapshot?.consent_lifetime) <= now()))) throw input.denied();
  };
  if (input.issuance) {
    for (const pin of input.pins) valid((await input.read([pin.id], true))[0], pin);
    return;
  }
  if (!input.pins.length) return;
  const ids = input.pins.map(pin => pin.id);
  if (new Set(ids).size !== ids.length) throw input.denied();
  const rows = await input.read(ids, false), current = new Map(rows.map(row => [input.id(row), row]));
  if (rows.length !== ids.length || current.size !== rows.length) throw input.denied();
  for (const pin of input.pins) valid(current.get(pin.id), pin);
}
