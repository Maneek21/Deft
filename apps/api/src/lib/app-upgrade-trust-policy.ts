import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appInstallations, auditLog } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { diffUpgradeAuthority, type UpgradeAuthorityDiff } from './app-upgrade-manifest-diff.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const TRUST_ACTION = 'app.upgrade_continuity_trust_changed';
const TrustSchema = z.strictObject({ trusted: z.boolean(), revision: z.number().int().nonnegative().max(2147483647) });
export const UpgradeTrustUpdateSchema = TrustSchema.safeExtend({ expected_revision: z.number().int().nonnegative().max(2147483646) }).omit({ revision: true });
export function upgradeContinuityDecision(trusted: boolean, before: unknown, after: unknown,
  connection?: Readonly<{ before: unknown; after: unknown }>) {
  const diff: UpgradeAuthorityDiff = diffUpgradeAuthority(before, after, connection);
  return { eligible: trusted && !diff.requires_review, reason: !trusted ? 'installation_not_trusted' as const
    : diff.requires_review ? 'authority_requires_review' as const : 'compatible_trusted_upgrade' as const, diff };
}
/** Server-authored audit records are the durable policy register. Absence is
 * OFF; malformed records fail closed. Callers hold the installation lock, so
 * revisions serialize settings changes and fence an off/on ABA transition.
 * No migration or historical schema-catalog mutation is needed. */
export async function readInstallationUpgradeTrust(tx: Tx, orgId: string, installationId: string) {
  const [latest] = await currentInstallationUpgradeTrustRows(tx, orgId, installationId);
  return decodeInstallationUpgradeTrust(latest);
}
/** The exact current policy point read can join other unlocked scoped facts.
 * This remains live SQL; no policy or revision is retained between checks. */
export function currentInstallationUpgradeTrustRows(tx: Tx, orgId: string, installationId: string) {
  return tx.select({ after_state: auditLog.after_state }).from(auditLog).where(and(
    eq(auditLog.org_id, orgId), eq(auditLog.entity_type, 'app_installation'), eq(auditLog.entity_id, installationId),
    eq(auditLog.action, TRUST_ACTION), eq(auditLog.actor_type, 'human')))
    .orderBy(sql`(${auditLog.after_state}->>'revision')::integer DESC`).limit(1);
}
export function decodeInstallationUpgradeTrust(latest: { after_state: unknown } | null | undefined) {
  return latest ? TrustSchema.parse(latest.after_state) : { trusted: false, revision: 0 };
}
export async function installationUpgradeTrust(actor: ModuleActor, installationId: string, guard: WebAuthorityGuard,
  change?: z.infer<typeof UpgradeTrustUpdateSchema>) {
  if (actor.kind !== 'human' || !['owner', 'admin'].includes(actor.role) || !['rest', 'ui'].includes(actor.source))
    throw new AppError('Current installation administrator required', 'APP_ACCESS_DENIED', 403);
  return db.transaction(async tx => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    const query = tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installationId))).limit(1);
    const [installation] = await (change ? query.for('update') : query.for('share'));
    if (!installation) throw new AppError('Installation unavailable', 'APP_NOT_FOUND', 404);
    const policy = await readInstallationUpgradeTrust(tx, actor.org_id, installationId);
    if (change && policy.revision !== change.expected_revision) throw new AppError('Upgrade trust setting changed', 'APP_STALE', 409);
    await guard(tx);
    if (guard.current_web_session_expires_at() <= new Date()) throw new AppError('Administrator session expired', 'APP_ACCESS_DENIED', 403);
    if (!change || policy.trusted === change.trusted) return policy;
    const updated = { trusted: change.trusted, revision: policy.revision + 1 };
    await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human', actor_id: actor.actor_id,
      action: TRUST_ACTION, entity_type: 'app_installation', entity_id: installationId,
      before_state: policy, after_state: updated, metadata: { source: actor.source } });
    await guard(tx);
    if (guard.current_web_session_expires_at() <= new Date()) throw new AppError('Administrator session expired', 'APP_ACCESS_DENIED', 403);
    return updated;
  });
}
