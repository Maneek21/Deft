/**
 * Phase 4 Task 4.15 — deduped trigger resolver.
 *
 * `agentEmployees.trigger_subscriptions` is the authoritative JSONB array of
 * trigger kinds claimed by an employee, but since skills (via their
 * `agent_config.triggers`) can also contribute kinds at install time we need
 * a single read helper that unions the two sources and dedupes.
 *
 * If two installed skills on the same employee declare the same trigger kind,
 * the union collapses it to one entry — the cron dispatchers then fire the
 * employee exactly once.
 *
 * The conflict helper below finds which *other* employee (in the same org)
 * already claims any of a candidate set of trigger kinds. It's consumed by
 * `ensureSkillInstalled` before auto-install to surface a reassign prompt
 * instead of silently blocking.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from './db.js';
import {
  agentEmployees,
  agentEmployeeSkills,
  skills,
} from '@deft/db/schema';
import type { SkillAgentConfig } from './skill-config.js';

/**
 * Return the deduped set of trigger kinds this employee is currently
 * subscribed to — union of the inline column and every installed skill's
 * `agent_config.triggers`.
 */
export async function resolveActiveTriggers(
  employeeId: string,
): Promise<string[]> {
  const [employee] = await db
    .select({
      trigger_subscriptions: agentEmployees.trigger_subscriptions,
    })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);

  const base = employee?.trigger_subscriptions ?? [];

  const skillRows = await db
    .select({ agent_config: skills.agent_config })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(skills.id, agentEmployeeSkills.skill_id))
    .where(eq(agentEmployeeSkills.agent_employee_id, employeeId));

  const skillTriggers: string[] = [];
  for (const row of skillRows) {
    const cfg = (row.agent_config ?? {}) as SkillAgentConfig;
    for (const t of cfg.triggers ?? []) skillTriggers.push(t);
  }

  return Array.from(new Set([...base, ...skillTriggers]));
}

export type TriggerConflict = {
  trigger_kind: string;
  current_owner_id: string;
  current_owner_name: string;
};

/**
 * For a candidate set of trigger kinds the caller wants to claim on
 * `targetEmployeeId`, find which OTHER employees in the same org already
 * claim any of them (via either the inline column or an installed skill's
 * agent_config.triggers).
 */
export async function findTriggerConflicts(params: {
  orgId: string;
  targetEmployeeId: string;
  candidateTriggers: string[];
}): Promise<TriggerConflict[]> {
  const { orgId, targetEmployeeId, candidateTriggers } = params;
  if (candidateTriggers.length === 0) return [];

  // Pull all active employees in the org except the target, with their
  // inline trigger_subscriptions.
  const peers = await db
    .select({
      id: agentEmployees.id,
      name: agentEmployees.name,
      trigger_subscriptions: agentEmployees.trigger_subscriptions,
    })
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_active, true),
        ne(agentEmployees.id, targetEmployeeId),
      ),
    );

  if (peers.length === 0) return [];

  // Also pull each peer's installed-skill triggers so the union is complete.
  const peerIds = peers.map((p) => p.id);
  const skillRows = await db
    .select({
      agent_employee_id: agentEmployeeSkills.agent_employee_id,
      agent_config: skills.agent_config,
    })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(skills.id, agentEmployeeSkills.skill_id));

  const skillTriggersByEmp = new Map<string, string[]>();
  for (const row of skillRows) {
    if (!peerIds.includes(row.agent_employee_id)) continue;
    const cfg = (row.agent_config ?? {}) as SkillAgentConfig;
    const list = skillTriggersByEmp.get(row.agent_employee_id) ?? [];
    for (const t of cfg.triggers ?? []) list.push(t);
    skillTriggersByEmp.set(row.agent_employee_id, list);
  }

  const conflicts: TriggerConflict[] = [];
  const seen = new Set<string>(); // trigger_kind:owner dedup key
  for (const peer of peers) {
    const active = new Set<string>([
      ...(peer.trigger_subscriptions ?? []),
      ...(skillTriggersByEmp.get(peer.id) ?? []),
    ]);
    for (const trig of candidateTriggers) {
      if (!active.has(trig)) continue;
      const key = `${trig}:${peer.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({
        trigger_kind: trig,
        current_owner_id: peer.id,
        current_owner_name: peer.name,
      });
    }
  }

  return conflicts;
}
