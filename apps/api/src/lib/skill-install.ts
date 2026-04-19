/**
 * Phase 4 Task 4.6 — JIT skill installation.
 *
 * `ensureSkillInstalled(employeeId, skillId)` is called by the agent dispatch
 * handlers (task + message) before running a job. It checks the
 * `agent_employee_skills` junction and — when the skill is bundled or
 * org-authored — inserts the row, merges capability packs into the employee
 * row, and for openclaw employees with an active connection enqueues a
 * `deploy-provision` job in `update` mode so the sidecar picks up the new
 * pack(s). Marketplace skills never auto-install; the caller is expected to
 * post an approval notification and skip dispatch.
 */
import { and, eq } from 'drizzle-orm';
import { db } from './db.js';
import {
  agentEmployees,
  agentEmployeeSkills,
  skills,
} from '@deft/db/schema';
import type { SkillAgentConfig } from './skill-config.js';
import { enqueue } from './queues.js';
import {
  findTriggerConflicts,
  type TriggerConflict,
} from './trigger-resolver.js';
import { decrypt } from './encryption.js';
import { getGatewayForDeployment, type OpenClawGateway } from './openclaw-gateway.js';

// Block 1.3 — test seam so install/remove paths can inject a mock gateway.
let _gatewayResolver: (
  employeeId: string,
  connectionUrl: string,
  token: string,
) => OpenClawGateway | null = (id, url, tok) => getGatewayForDeployment(id, url, tok);
export function _setSkillInstallGatewayResolver(
  fn: (employeeId: string, connectionUrl: string, token: string) => OpenClawGateway | null,
): void { _gatewayResolver = fn; }
export function _resetSkillInstallGatewayResolver(): void {
  _gatewayResolver = (id, url, tok) => getGatewayForDeployment(id, url, tok);
}

/**
 * Fire-and-forget live install on the sidecar. Wraps decrypt + gateway call
 * + error swallow so callers don't block on gateway latency.
 */
async function liveInstallOnGateway(
  employeeId: string,
  connectionUrl: string | null,
  tokenEncrypted: string | null,
  slug: string,
  version: string,
): Promise<{ forwarded: boolean; error?: string }> {
  if (!connectionUrl || !tokenEncrypted) return { forwarded: false };
  let token: string;
  try { token = decrypt(tokenEncrypted); }
  catch { return { forwarded: false, error: 'decrypt failed' }; }
  const gateway = _gatewayResolver(employeeId, connectionUrl, token);
  if (!gateway) return { forwarded: false, error: 'gateway unresolved' };
  try {
    await gateway.skills.install(slug, version);
    return { forwarded: true };
  } catch (err) {
    return { forwarded: false, error: (err as Error).message };
  }
}

async function liveRemoveOnGateway(
  employeeId: string,
  connectionUrl: string | null,
  tokenEncrypted: string | null,
  slug: string,
): Promise<{ forwarded: boolean; error?: string }> {
  if (!connectionUrl || !tokenEncrypted) return { forwarded: false };
  let token: string;
  try { token = decrypt(tokenEncrypted); }
  catch { return { forwarded: false, error: 'decrypt failed' }; }
  const gateway = _gatewayResolver(employeeId, connectionUrl, token);
  if (!gateway) return { forwarded: false, error: 'gateway unresolved' };
  try {
    await gateway.skills.remove(slug);
    return { forwarded: true };
  } catch (err) {
    return { forwarded: false, error: (err as Error).message };
  }
}

export type SkillInstallResult =
  | { status: 'already_installed' }
  | { status: 'installed'; requires_reprovision: boolean }
  | {
      status: 'requires_approval';
      skill: { id: string; name: string; source: 'marketplace' };
    }
  | {
      status: 'requires_user_decision';
      skill: { id: string; name: string };
      conflicting_triggers: TriggerConflict[];
    };

/**
 * Idempotently install a skill onto an agent employee.
 *
 * Rules:
 *   - If `(employeeId, skillId)` already in the junction → already_installed.
 *   - `bundled` or `org` skills → insert junction row with the skill's
 *     current version; merge any `agent_config.capability_packs` into the
 *     employee's inline `capability_packs` column (set union). For openclaw
 *     employees currently `connected` whose pack set actually changed, flip
 *     `connection_status` to `pending` and enqueue a `deploy-provision` job
 *     tagged `mode: 'update'`.
 *   - `marketplace` skills → never auto-install. The caller decides whether
 *     to surface a prompt to the employee owner or skip the dispatch.
 */
export async function ensureSkillInstalled(
  employeeId: string,
  skillId: string,
): Promise<SkillInstallResult> {
  // 1. Already installed?
  const [existing] = await db
    .select({ skill_id: agentEmployeeSkills.skill_id })
    .from(agentEmployeeSkills)
    .where(
      and(
        eq(agentEmployeeSkills.agent_employee_id, employeeId),
        eq(agentEmployeeSkills.skill_id, skillId),
      ),
    )
    .limit(1);

  if (existing) {
    return { status: 'already_installed' };
  }

  // 2. Load skill.
  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);

  if (!skill) {
    throw new Error(`ensureSkillInstalled: skill ${skillId} not found`);
  }

  // 3. Marketplace → requires approval; do not mutate anything.
  if (skill.source === 'marketplace') {
    return {
      status: 'requires_approval',
      skill: {
        id: skill.id,
        name: skill.name,
        source: 'marketplace',
      },
    };
  }

  // 4. bundled / org → auto-install.
  const [employee] = await db
    .select()
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);

  if (!employee) {
    throw new Error(`ensureSkillInstalled: employee ${employeeId} not found`);
  }

  // Task 4.15 — before mutating anything, check if this skill's declared
  // triggers would collide with a trigger kind already claimed by another
  // active employee in the same org. If yes, bail with a
  // `requires_user_decision` result so the caller can surface a reassign
  // prompt instead of silently blocking (or silently stealing).
  const agentConfig = (skill.agent_config ?? {}) as SkillAgentConfig;
  const incomingTriggers = agentConfig.triggers ?? [];
  if (incomingTriggers.length > 0) {
    const conflicts = await findTriggerConflicts({
      orgId: employee.org_id,
      targetEmployeeId: employeeId,
      candidateTriggers: incomingTriggers,
    });
    if (conflicts.length > 0) {
      return {
        status: 'requires_user_decision',
        skill: { id: skill.id, name: skill.name },
        conflicting_triggers: conflicts,
      };
    }
  }

  await db
    .insert(agentEmployeeSkills)
    .values({
      agent_employee_id: employeeId,
      skill_id: skillId,
      installed_version: skill.version,
    })
    .onConflictDoNothing();

  // Merge capability_packs (set union) into the employee row.
  const incomingPacks = agentConfig.capability_packs ?? [];
  const existingPacks = employee.capability_packs ?? [];

  const mergedPacks = Array.from(new Set([...existingPacks, ...incomingPacks]));
  const packsChanged = mergedPacks.length !== existingPacks.length;

  let requiresReprovision = false;

  if (packsChanged) {
    const isConnectedOpenclaw =
      employee.kind === 'openclaw' && employee.connection_status === 'connected';

    await db
      .update(agentEmployees)
      .set({
        capability_packs: mergedPacks,
        ...(isConnectedOpenclaw ? { connection_status: 'pending' as const } : {}),
      })
      .where(eq(agentEmployees.id, employeeId));

    if (isConnectedOpenclaw) {
      requiresReprovision = true;
      await enqueue('agent-jobs', 'deploy-provision', {
        employee_id: employeeId,
        mode: 'update',
      });
    }
  }

  // Block 1.3 — live install on the sidecar for connected openclaw
  // employees. Best-effort: a gateway error doesn't roll back the DB
  // install — the reconciliation loop (Block 1.8) will retry next tick.
  // Fires regardless of packsChanged: a skill can install without any
  // new capability pack (e.g. a ClawHub slug).
  if (employee.kind === 'openclaw' && employee.connection_status === 'connected') {
    void liveInstallOnGateway(
      employeeId,
      employee.connection_url,
      employee.gateway_token_encrypted,
      skill.slug,
      skill.version,
    ).then((r) => {
      if (!r.forwarded && r.error) {
        console.warn(`[skill-install ${employeeId}] gateway install ${skill.slug} deferred: ${r.error}`);
      }
    }).catch(() => undefined);
  }

  return { status: 'installed', requires_reprovision: requiresReprovision };
}

/**
 * Block 1.6 — marketplace install with secret resolution + gateway push.
 *
 * Call site: after the user clears the security-review approval for a
 * marketplace skill. Performs the Block 1.6 flow:
 *
 *   1. Parse `requires.env` from the skill's agent_config.
 *   2. Resolve each required key via OAuth → skill_secrets fallback.
 *   3. If any still missing → return `{ status: 'missing_secrets', missing }`
 *      so the UI can prompt. Caller saves via setSecretForSkill() and retries.
 *   4. Otherwise push to the gateway via config.set(skills/<slug>/<KEY>),
 *      then call gateway.skills.install(slug, version).
 *   5. Insert the junction row + merge capability_packs.
 *
 * Only runs for marketplace skills with requires_env declared. Everything
 * else falls back to the standard ensureSkillInstalled path.
 */
export type MarketplaceInstallResult =
  | { status: 'installed'; requires_reprovision: boolean }
  | { status: 'already_installed' }
  | { status: 'missing_secrets'; missing: string[] }
  | { status: 'gateway_unreachable' }
  | { status: 'skill_not_found' }
  | { status: 'employee_not_found' }
  | { status: 'push_failed'; failed: string[] };

export async function installMarketplaceSkillWithSecrets(
  employeeId: string,
  skillId: string,
): Promise<MarketplaceInstallResult> {
  const [existing] = await db
    .select({ skill_id: agentEmployeeSkills.skill_id })
    .from(agentEmployeeSkills)
    .where(
      and(
        eq(agentEmployeeSkills.agent_employee_id, employeeId),
        eq(agentEmployeeSkills.skill_id, skillId),
      ),
    )
    .limit(1);
  if (existing) return { status: 'already_installed' };

  const [skill] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!skill) return { status: 'skill_not_found' };

  const [employee] = await db.select().from(agentEmployees).where(eq(agentEmployees.id, employeeId)).limit(1);
  if (!employee) return { status: 'employee_not_found' };

  const { resolveSecretsForInstall, pushSkillSecretsToGateway } = await import('./skill-secret-resolver.js');
  const agentConfig = (skill.agent_config ?? {}) as { requires_env?: string[]; capability_packs?: string[] };
  const requiredKeys = agentConfig.requires_env ?? [];

  const secretResult = await resolveSecretsForInstall(employee.org_id, skillId, requiredKeys);
  if (secretResult.missing.length > 0) {
    return { status: 'missing_secrets', missing: secretResult.missing };
  }

  if (employee.kind === 'openclaw' && employee.connection_status === 'connected') {
    if (!employee.connection_url || !employee.gateway_token_encrypted) {
      return { status: 'gateway_unreachable' };
    }
    let token: string;
    try { token = decrypt(employee.gateway_token_encrypted); }
    catch { return { status: 'gateway_unreachable' }; }

    const gateway = _gatewayResolver(employee.id, employee.connection_url, token);
    if (!gateway) return { status: 'gateway_unreachable' };

    if (Object.keys(secretResult.resolved).length > 0) {
      const push = await pushSkillSecretsToGateway(gateway, skill.slug, secretResult.resolved);
      if (push.failed.length > 0) return { status: 'push_failed', failed: push.failed };
    }

    try {
      await gateway.skills.install(skill.slug, skill.version);
    } catch (err) {
      console.warn(`[skill-install ${employeeId}] gateway install ${skill.slug} failed: ${(err as Error).message}`);
      // Continue — reconciliation loop will retry. DB-level install still commits below.
    }
  }

  // Junction row + capability pack merge (same as ensureSkillInstalled tail)
  await db
    .insert(agentEmployeeSkills)
    .values({
      agent_employee_id: employeeId,
      skill_id: skillId,
      installed_version: skill.version,
    })
    .onConflictDoNothing();

  const incomingPacks = agentConfig.capability_packs ?? [];
  const existingPacks = employee.capability_packs ?? [];
  const mergedPacks = Array.from(new Set([...existingPacks, ...incomingPacks]));
  const packsChanged = mergedPacks.length !== existingPacks.length;

  let requiresReprovision = false;
  if (packsChanged) {
    await db
      .update(agentEmployees)
      .set({ capability_packs: mergedPacks })
      .where(eq(agentEmployees.id, employeeId));
    if (employee.kind === 'openclaw' && employee.connection_status === 'connected') {
      requiresReprovision = true;
      await enqueue('agent-jobs', 'deploy-provision', {
        employee_id: employeeId,
        mode: 'update',
      });
    }
  }

  return { status: 'installed', requires_reprovision: requiresReprovision };
}

/**
 * Block 1.3 — remove a skill from an agent employee.
 *
 * Idempotent: removing a not-installed skill is a no-op success. For
 * connected openclaw employees, also fires `gateway.skills.remove(slug)`
 * live (fire-and-forget — a gateway error is logged but does not block
 * the DB detach).
 */
export async function removeSkillFromEmployee(
  employeeId: string,
  skillId: string,
): Promise<{ removed: boolean; reason?: 'not_installed' | 'skill_not_found' | 'employee_not_found' }> {
  const [existing] = await db
    .select({ skill_id: agentEmployeeSkills.skill_id })
    .from(agentEmployeeSkills)
    .where(
      and(
        eq(agentEmployeeSkills.agent_employee_id, employeeId),
        eq(agentEmployeeSkills.skill_id, skillId),
      ),
    )
    .limit(1);

  if (!existing) return { removed: false, reason: 'not_installed' };

  const [skill] = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  if (!skill) return { removed: false, reason: 'skill_not_found' };

  const [employee] = await db.select().from(agentEmployees).where(eq(agentEmployees.id, employeeId)).limit(1);
  if (!employee) return { removed: false, reason: 'employee_not_found' };

  await db
    .delete(agentEmployeeSkills)
    .where(
      and(
        eq(agentEmployeeSkills.agent_employee_id, employeeId),
        eq(agentEmployeeSkills.skill_id, skillId),
      ),
    );

  if (employee.kind === 'openclaw' && employee.connection_status === 'connected') {
    void liveRemoveOnGateway(
      employeeId,
      employee.connection_url,
      employee.gateway_token_encrypted,
      skill.slug,
    ).then((r) => {
      if (!r.forwarded && r.error) {
        console.warn(`[skill-install ${employeeId}] gateway remove ${skill.slug} deferred: ${r.error}`);
      }
    }).catch(() => undefined);
  }

  return { removed: true };
}
