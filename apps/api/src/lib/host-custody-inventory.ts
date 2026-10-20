import { z } from 'zod';
import type { AppRunTransaction } from './app-run-repository.js';
import { APP_RUN_KEY_PURPOSES, type AppRunKeyReference } from './app-run-keyrings.js';

/** Trusted Host storage owners only. Apps never decide whether a key is retained.
 * Providers must include all physically retained ciphertext, regardless of grants,
 * expiry, soft deletion, installation status or availability of the app runtime. */
export interface HostCustodyInventoryProvider {
  readonly id: string;
  listReferences(tx: Pick<AppRunTransaction, 'execute'>, orgId?: string): Promise<readonly AppRunKeyReference[]>;
}

const referenceSchema = z.strictObject({
  purpose: z.enum(APP_RUN_KEY_PURPOSES),
  key_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
});

/** A missing/failed/invalid provider aborts the entire inventory. Returning a
 * partial inventory would incorrectly authorize retirement of retained keys. */
export async function listHostCustodyKeyReferences(
  tx: Pick<AppRunTransaction, 'execute'>,
  providers: readonly HostCustodyInventoryProvider[],
  orgId?: string,
): Promise<readonly AppRunKeyReference[]> {
  if (orgId !== undefined) z.uuid().parse(orgId);
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!provider.id || ids.has(provider.id)) throw new Error('HOST_CUSTODY_PROVIDER_INVALID');
    ids.add(provider.id);
  }
  const references = new Map<string, AppRunKeyReference>();
  for (const provider of providers) {
    for (const candidate of await provider.listReferences(tx, orgId)) {
      const reference = Object.freeze(referenceSchema.parse(candidate));
      references.set(JSON.stringify([reference.purpose, reference.key_id]), reference);
    }
  }
  return Object.freeze([...references.values()].sort((a, b) =>
    a.purpose.localeCompare(b.purpose) || a.key_id.localeCompare(b.key_id)));
}
