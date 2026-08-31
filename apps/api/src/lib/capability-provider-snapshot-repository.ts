import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { capabilityProviderSnapshots } from '@deft/db/schema';
import type { CapabilityProviderDiscoverySnapshot } from '@deft/shared';
import { db } from './db.js';

type SnapshotExecutor = Pick<typeof db, 'insert' | 'select'>;

/**
 * Persists the immutable safe provider projection and returns its stable
 * tenant/provider/digest identity. Discovery callers never persist credentials
 * or executable clients in this repository.
 */
export async function persistCapabilityProviderSnapshotWithExecutor(
  executor: SnapshotExecutor,
  snapshot: Readonly<CapabilityProviderDiscoverySnapshot>,
): Promise<string> {
  const id = randomUUID();
  await executor.insert(capabilityProviderSnapshots).values({
    id,
    org_id: snapshot.provider.org_id,
    provider_kind: snapshot.provider.provider_kind,
    provider_instance_id: snapshot.provider.provider_instance_id,
    adapter_contract_version: snapshot.adapter_contract_version,
    snapshot_digest: snapshot.snapshot_digest,
    safe_snapshot: snapshot,
    captured_at: new Date(snapshot.captured_at),
  }).onConflictDoNothing();
  const [stored] = await executor.select({ id: capabilityProviderSnapshots.id })
    .from(capabilityProviderSnapshots)
    .where(and(
      eq(capabilityProviderSnapshots.org_id, snapshot.provider.org_id),
      eq(capabilityProviderSnapshots.provider_kind, snapshot.provider.provider_kind),
      eq(capabilityProviderSnapshots.provider_instance_id, snapshot.provider.provider_instance_id),
      eq(capabilityProviderSnapshots.snapshot_digest, snapshot.snapshot_digest),
    ))
    .limit(1);
  if (!stored) throw new Error('APP_RUN_PROVIDER_UNAVAILABLE');
  return stored.id;
}

export function persistCapabilityProviderSnapshot(
  snapshot: Readonly<CapabilityProviderDiscoverySnapshot>,
): Promise<string> {
  return persistCapabilityProviderSnapshotWithExecutor(db, snapshot);
}
