import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { canonicalCapabilityJson } from '@deft/shared';
import type { AppRunTransaction } from './app-run-repository.js';
import type { AccessCaller } from './app-resource-access-service.js';
import { accessUnavailable } from './app-resource-access-contract.js';
import { loadLockedPrivateAccessParent } from './app-private-access-parent.js';
import type { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { DEFTY_EMAIL, DEFTY_SYSTEM_EMPLOYEE_SLUG, DEFTY_SYSTEM_RUNTIME_KIND } from './defty-identity.js';
import { decodeOrgAIConfig, resolveReasonProviderFromConfig, type OrgAIConfigStored } from './org-ai-config.js';
import { privateDeftyDestination } from './app-private-defty-model.js';
import type { AppRunKeyProvider } from './app-run-keyrings.js';
import type { PrivateDeftySnapshot } from './app-private-defty-contract.js';
import { isAppResourceSyncChannelEnabled } from './env.js';
import { assertAttachmentBrokerEnabled } from './app-attachment-authority.js';

export const privateDeftyEnabled = () => isAppResourceSyncChannelEnabled()
  && process.env.DEFT_APP_PRIVATE_DEFTY_ENABLED === 'true';
export const privateDeftyDigest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex')}`;

export async function canonicalPrivateDefty(tx: AppRunTransaction, org: string) {
  const result = await tx.execute(sql`
    SELECT u.id,e.id AS employee_id FROM users u INNER JOIN agent_employees e ON e.user_id=u.id
    WHERE e.org_id=${org} AND u.email=${DEFTY_EMAIL} AND u.kind='agent' AND u.is_agent
    AND e.slug=${DEFTY_SYSTEM_EMPLOYEE_SLUG} AND e.runtime_kind=${DEFTY_SYSTEM_RUNTIME_KIND}
    AND NOT e.is_byoa AND e.is_active AND NOT e.unhealthy
  `);
  if (result.rows.length !== 1) throw accessUnavailable();
  return { id: String(result.rows[0]!.id), employee_id: String(result.rows[0]!.employee_id) };
}

/** Prelocks every participant before parent helpers can acquire App locks.
 * This reconstructs authority; no actor label or existing human/MCP grant is used. */
export async function lockedPrivateDeftyContext(options: {
  tx: AppRunTransaction; caller: AccessCaller; spaceId: string;
  ref: PrivateDeftySnapshot['ref']; keys: AppRunKeyProvider;
  secrets: AppResourceSyncSecretService; clock: () => Date; signal?: AbortSignal;
  write?: boolean; empty?: boolean; credentialKeyVersion?: string;
}) {
  const { tx, caller: c } = options;
  const locator = await canonicalPrivateDefty(tx, c.org_id);
  let memberPins: { owner: number; defty: number } | undefined;
  let resolved: ReturnType<typeof resolveReasonProviderFromConfig> | undefined;
  const parent = await loadLockedPrivateAccessParent({
    tx, orgId: c.org_id, ref: options.ref, recipient: locator.id, secrets: options.secrets,
    clock: options.clock, signal: options.signal,
    lockParticipants: async (owner, defty, operator) => {
      if (owner !== c.user_id || defty !== locator.id) throw accessUnavailable();
      for (const id of [...new Set([owner, defty, operator])].sort()) {
        await tx.execute(options.write && id === owner
          ? sql`SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${id} FOR UPDATE`
          : sql`SELECT id FROM org_members WHERE org_id=${c.org_id} AND user_id=${id} FOR SHARE`);
      }
      const members = await tx.execute(sql`
        SELECT m.user_id,m.is_active,m.role,m.app_run_authorization_version,u.kind
        FROM org_members m INNER JOIN users u ON u.id=m.user_id
        WHERE m.org_id=${c.org_id} AND m.user_id IN (${owner},${defty},${operator})
      `);
      for (const id of [...new Set([owner, defty, operator])]) {
        const row = members.rows.find(value => value.user_id === id);
        if (!row?.is_active || row.role === 'guest' || row.kind !== (id === defty ? 'agent' : 'human')) throw accessUnavailable();
      }
      memberPins = {
        owner: Number(members.rows.find(row => row.user_id === owner)!.app_run_authorization_version),
        defty: Number(members.rows.find(row => row.user_id === defty)!.app_run_authorization_version),
      };
      await tx.execute(sql`SELECT id FROM agent_employees WHERE org_id=${c.org_id} AND id=${locator.employee_id} FOR SHARE`);
      const actual = await canonicalPrivateDefty(tx, c.org_id);
      if (actual.id !== locator.id || actual.employee_id !== locator.employee_id) throw accessUnavailable();
      const configs = await tx.execute(sql`SELECT ai_config FROM orgs WHERE id=${c.org_id} FOR SHARE`);
      if (configs.rows.length !== 1) throw accessUnavailable();
      resolved = resolveReasonProviderFromConfig(decodeOrgAIConfig((configs.rows[0]!.ai_config ?? {}) as OrgAIConfigStored));
      if (resolved.provider !== 'ollama' && !resolved.apiKey) throw accessUnavailable();
    },
  });
  await tx.execute(options.write
    ? sql`SELECT id FROM spaces WHERE org_id=${c.org_id} AND id=${options.spaceId} FOR UPDATE`
    : sql`SELECT id FROM spaces WHERE org_id=${c.org_id} AND id=${options.spaceId} FOR SHARE`);
  const spaces = await tx.execute(sql`SELECT id,type,created_by,is_archived FROM spaces WHERE org_id=${c.org_id} AND id=${options.spaceId}`);
  const space = spaces.rows[0];
  if (!space || space.type !== 'agent_conversation' || space.created_by !== c.user_id || space.is_archived) throw accessUnavailable();
  const audience = await tx.execute(sql`SELECT user_id FROM space_members WHERE space_id=${options.spaceId} ORDER BY user_id`);
  if (audience.rows.length !== 2 || !audience.rows.some(row => row.user_id === c.user_id)
    || !audience.rows.some(row => row.user_id === locator.id)) throw accessUnavailable();
  if (options.empty) {
    const old = await tx.execute(sql`SELECT id FROM messages WHERE org_id=${c.org_id} AND space_id=${options.spaceId} LIMIT 1`);
    if (old.rows.length) throw accessUnavailable();
  }
  if (!memberPins || !resolved || !parent.record) throw accessUnavailable();
  return { parent, defty: locator, memberPins, resolved, spaceId: options.spaceId,
    destination: privateDeftyDestination(options.keys, resolved, options.credentialKeyVersion) };
}

/** Last authority fence follows all writes. Revocation/owner retained viewing
 * use their own narrower owner fence, never require a still-live parent. */
export async function finalPrivateDefty(tx: AppRunTransaction, caller: AccessCaller,
  context: Awaited<ReturnType<typeof lockedPrivateDeftyContext>>, expires: Date, clock: () => Date) {
  await caller.guard(tx);
  const members = await tx.execute(sql`
    SELECT m.user_id,m.is_active,m.role,u.kind FROM org_members m INNER JOIN users u ON u.id=m.user_id
    WHERE m.org_id=${caller.org_id} AND m.user_id IN (${caller.user_id},${context.defty.id},${context.parent.authority.registration.operator_user_id})
  `);
  for (const id of [...new Set([caller.user_id, context.defty.id, context.parent.authority.registration.operator_user_id])]) {
    const row = members.rows.find(value => value.user_id === id);
    if (!row?.is_active || row.role === 'guest' || row.kind !== (id === context.defty.id ? 'agent' : 'human')) throw accessUnavailable();
  }
  const identity = await canonicalPrivateDefty(tx, caller.org_id);
  if (identity.id !== context.defty.id || identity.employee_id !== context.defty.employee_id) throw accessUnavailable();
  const audience = await tx.execute(sql`SELECT user_id FROM space_members WHERE space_id=${context.spaceId} ORDER BY user_id`);
  if (audience.rows.length !== 2 || !audience.rows.some(row => row.user_id === caller.user_id)
    || !audience.rows.some(row => row.user_id === context.defty.id)) throw accessUnavailable();
  const now = clock();
  if (context.parent.authority.version.protocol_version === '7') assertAttachmentBrokerEnabled();
  if (!privateDeftyEnabled() || expires <= now || caller.guard.current_web_session_expires_at() <= now
    || !context.parent.authority.binding.consent_expires_at || context.parent.authority.binding.consent_expires_at <= now) throw accessUnavailable();
}
