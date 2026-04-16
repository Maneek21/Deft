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

export type SkillInstallResult =
  | { status: 'already_installed' }
  | { status: 'installed'; requires_reprovision: boolean }
  | {
      status: 'requires_approval';
      skill: { id: string; name: string; source: 'marketplace' };
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

  await db
    .insert(agentEmployeeSkills)
    .values({
      agent_employee_id: employeeId,
      skill_id: skillId,
      installed_version: skill.version,
    })
    .onConflictDoNothing();

  // Merge capability_packs (set union) into the employee row.
  const agentConfig = (skill.agent_config ?? {}) as SkillAgentConfig;
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

  return { status: 'installed', requires_reprovision: requiresReprovision };
}
