import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { appResourceBindings as bindings, appResourceProjections as projections, appRuntimeRegistrations as registrations, appSyncCheckpoints as checkpoints, appInstallations } from '@deft/db/schema';
import { canonicalCapabilityJson } from '@deft/shared';
import type { AppRunTransaction } from './app-run-repository.js';
import { loadLiveResourceSyncBindingAuthority } from './app-resource-sync-authority.js';
import { decodePrivateProjection } from './app-resource-private-projection.js';
import type { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { accessUnavailable, type AccessSnapshot } from './app-resource-access-contract.js';
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex')}`;

/** Shared exact parent evaluator. Callers supply their complete participant fence
 * before App/registration locks; each caller retains its own purpose/final fence. */
export async function loadLockedPrivateAccessParent(options: {
  tx: AppRunTransaction;
  orgId: string;
  ref: AccessSnapshot['ref'];
  recipient: string;
  lockParticipants: (owner: string, recipient: string, operator: string) => Promise<void>;
  clock: () => Date;
  secrets: AppResourceSyncSecretService;
  signal?: AbortSignal;
  decrypt?: boolean;
}) {
  const { tx, orgId, ref, recipient, lockParticipants, clock, secrets, signal, decrypt = true } = options;
    const [locator] = await tx.select().from(bindings).innerJoin(projections, and(eq(projections.org_id, bindings.org_id), eq(projections.resource_binding_id, bindings.id))).where(and(eq(bindings.org_id, orgId), eq(projections.id, ref.resource_id), eq(bindings.runtime_registration_id, ref.provider.provider_instance_id), eq(bindings.resource_family, ref.resource_type))).limit(1);
    if (!locator) {
      throw accessUnavailable();
    }
    const b = locator.app_resource_bindings;
    const [r] = await tx.select().from(registrations).where(and(eq(registrations.org_id, orgId), eq(registrations.id, b.runtime_registration_id))).limit(1);
    if (!r) {
      throw accessUnavailable();
    }
    await lockParticipants(b.owner_user_id, recipient, r.operator_user_id);
    await tx.execute(sql `SELECT id FROM app_installations WHERE org_id=${orgId} AND id=${b.app_installation_id} FOR SHARE`);
    const [app] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, orgId), eq(appInstallations.id, b.app_installation_id))).limit(1);
    if (!app || app.active_version_id !== b.app_version_id || app.active_grant_snapshot_id !== b.grant_snapshot_id) {
      throw accessUnavailable();
    }
    await tx.execute(sql `SELECT id FROM app_versions WHERE org_id=${orgId} AND id=${b.app_version_id} FOR SHARE`);
    await tx.execute(sql `SELECT id FROM app_grant_snapshots WHERE org_id=${orgId} AND id=${b.grant_snapshot_id} FOR SHARE`);
    await tx.execute(sql `SELECT id FROM app_runtime_registrations WHERE org_id=${orgId} AND id=${r.id} FOR SHARE`);
    await tx.execute(sql `SELECT id FROM app_resource_bindings WHERE org_id=${orgId} AND id=${b.id} FOR SHARE`);
    const [lockedB] = await tx.select().from(bindings).where(and(eq(bindings.org_id, orgId), eq(bindings.id, b.id))), [lockedR] = await tx.select().from(registrations).where(and(eq(registrations.org_id, orgId), eq(registrations.id, r.id)));
    if (!lockedB || !lockedR || digest({
      owner: lockedB.owner_user_id,
      app: lockedB.app_installation_id,
      version: lockedB.app_version_id,
      grant: lockedB.grant_snapshot_id,
      registration: lockedB.runtime_registration_id,
      key: lockedB.resource_key,
      operator: lockedR.operator_user_id
    }) !== digest({
      owner: b.owner_user_id,
      app: b.app_installation_id,
      version: b.app_version_id,
      grant: b.grant_snapshot_id,
      registration: b.runtime_registration_id,
      key: b.resource_key,
      operator: r.operator_user_id
    })) {
      throw accessUnavailable();
    }
    const authority = await loadLiveResourceSyncBindingAuthority(tx, { org_id: orgId, resource_binding_id: b.id, clock: clock });
    if (!authority || authority.descriptor.resource_type !== ref.resource_type || authority.registration.id !== ref.provider.provider_instance_id) {
      throw accessUnavailable();
    }
    await tx.execute(sql `SELECT id FROM app_sync_checkpoints WHERE org_id=${orgId} AND resource_binding_id=${b.id} FOR SHARE`);
    const [checkpoint] = await tx.select().from(checkpoints).where(and(eq(checkpoints.org_id, orgId), eq(checkpoints.resource_binding_id, b.id), eq(checkpoints.state, "active"))).limit(1);
    if (!checkpoint) {
      throw accessUnavailable();
    }
    const [row] = await tx.select().from(projections).where(and(eq(projections.org_id, orgId), eq(projections.id, ref.resource_id), eq(projections.resource_binding_id, b.id), eq(projections.checkpoint_id, checkpoint.id), eq(projections.generation, checkpoint.generation), eq(projections.state, "live"))).limit(1);
    if (!row) {
      throw accessUnavailable();
    }
    signal?.throwIfAborted();
    let record: ReturnType<typeof decodePrivateProjection> | null = null;
    try {
      if (decrypt) {
        record = decodePrivateProjection(secrets, row, authority.descriptor);
      }
    }
    catch {
      throw accessUnavailable();
    }
    return {
      authority,
      checkpoint,
      row,
      record,
      participants: [b.owner_user_id, recipient, r.operator_user_id]
    };
}
