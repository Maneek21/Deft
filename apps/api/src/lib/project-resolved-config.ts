/**
 * Phase 4 Task 4.5 — Real project resolved-config resolver.
 *
 * Replaces the Phase 0.2 interim that always returned Engineering. Reads the
 * project's attached skills (project_skills, ordered by attachment_order),
 * joins to skills.project_config, and merges the per-skill payloads into a
 * single resolved config the UI + status-transition validator consume.
 *
 * Merge rules:
 *   - First-attached wins for UI-exclusive fields:
 *       statuses, priority_vocab, default_view, hide_prefix_ids,
 *       allowed_transitions
 *   - Union (dedupe by id) for additive fields:
 *       custom_fields, task_templates
 *
 * Fallback order when a field has no contributor:
 *   1. Attached skill (per rules above)
 *   2. Bundled 'engineering' skill from the DB
 *   3. Hardcoded ENGINEERING_FALLBACK (same shape as Phase 0.2's interim)
 *
 * 60s in-memory TTL cache keyed by project_id. Mutations through
 * `invalidateProjectResolvedConfig(projectId)` clear the entry.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from './db.js';
import { projectSkills, skills } from '@deft/db/schema';
import type { ProjectResolvedConfig as BaseProjectResolvedConfig } from './task-status-machine.js';
import type { SkillProjectConfig, SkillProjectStatus } from './skill-config.js';

/**
 * Full resolved-config shape returned by the resolver. Structurally a
 * superset of the status-machine's `ProjectResolvedConfig` (so it still
 * satisfies `isValidTransition`) plus the additive + UI-only fields used
 * by the frontend hook.
 */
export type ProjectResolvedConfig = BaseProjectResolvedConfig & {
  priority_vocab?: SkillProjectConfig['priority_vocab'];
  default_view?: SkillProjectConfig['default_view'];
  hide_prefix_ids?: boolean;
  custom_fields: NonNullable<SkillProjectConfig['custom_fields']>;
  task_templates: NonNullable<SkillProjectConfig['task_templates']>;
};

const ENGINEERING_STATUSES: SkillProjectStatus[] = [
  { id: 'backlog', label: 'Backlog', color: '#6b7280', order: 0 },
  { id: 'todo', label: 'To Do', color: '#3b82f6', order: 1 },
  { id: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2 },
  { id: 'in_review', label: 'In Review', color: '#8b5cf6', order: 3 },
  { id: 'done', label: 'Done', color: '#10b981', order: 4 },
  { id: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 5 },
];

const ENGINEERING_TRANSITIONS: Record<string, string[]> = {
  backlog: ['todo', 'in_progress', 'cancelled'],
  todo: ['in_progress', 'backlog', 'cancelled'],
  in_progress: ['in_review', 'done', 'backlog', 'cancelled'],
  in_review: ['in_progress', 'done', 'cancelled'],
  done: ['in_progress', 'backlog'],
  cancelled: ['backlog'],
};

const ENGINEERING_FALLBACK: ProjectResolvedConfig = {
  statuses: ENGINEERING_STATUSES,
  allowed_transitions: ENGINEERING_TRANSITIONS,
  priority_vocab: { kind: 'numbered', labels: ['p0', 'p1', 'p2', 'p3'] },
  default_view: 'board',
  hide_prefix_ids: false,
  custom_fields: [],
  task_templates: [],
};

// ─── 60-second TTL cache ─────────────────────────────────────────────────
const CACHE_TTL_MS = 60_000;
type CacheEntry = { value: ProjectResolvedConfig; expires_at: number };
const cache = new Map<string, CacheEntry>();

export function invalidateProjectResolvedConfig(projectId: string): void {
  cache.delete(projectId);
}

/** Test-only — clear the whole cache. */
export function _clearProjectResolvedConfigCache(): void {
  cache.clear();
}

// ─── Merge ───────────────────────────────────────────────────────────────
function mergeConfigs(ordered: SkillProjectConfig[]): ProjectResolvedConfig {
  // First-attached-wins for UI-exclusive fields.
  let statuses: SkillProjectStatus[] | undefined;
  let allowed_transitions: Record<string, string[]> | null | undefined;
  let priority_vocab: SkillProjectConfig['priority_vocab'] | undefined;
  let default_view: SkillProjectConfig['default_view'] | undefined;
  let hide_prefix_ids: boolean | undefined;

  // Union + dedupe by id for additive fields.
  const customFieldsById = new Map<string, NonNullable<SkillProjectConfig['custom_fields']>[number]>();
  const taskTemplatesById = new Map<string, NonNullable<SkillProjectConfig['task_templates']>[number]>();

  for (const cfg of ordered) {
    if (statuses === undefined && cfg.statuses && cfg.statuses.length > 0) {
      statuses = cfg.statuses;
    }
    if (allowed_transitions === undefined && cfg.allowed_transitions !== undefined) {
      allowed_transitions = cfg.allowed_transitions;
    }
    if (priority_vocab === undefined && cfg.priority_vocab) {
      priority_vocab = cfg.priority_vocab;
    }
    if (default_view === undefined && cfg.default_view) {
      default_view = cfg.default_view;
    }
    if (hide_prefix_ids === undefined && cfg.hide_prefix_ids !== undefined) {
      hide_prefix_ids = cfg.hide_prefix_ids;
    }

    if (cfg.custom_fields) {
      for (const f of cfg.custom_fields) {
        if (!customFieldsById.has(f.id)) customFieldsById.set(f.id, f);
      }
    }
    if (cfg.task_templates) {
      for (const t of cfg.task_templates) {
        if (!taskTemplatesById.has(t.id)) taskTemplatesById.set(t.id, t);
      }
    }
  }

  return {
    statuses: statuses ?? ENGINEERING_FALLBACK.statuses,
    allowed_transitions:
      allowed_transitions === undefined
        ? ENGINEERING_FALLBACK.allowed_transitions
        : allowed_transitions,
    priority_vocab: priority_vocab ?? ENGINEERING_FALLBACK.priority_vocab,
    default_view: default_view ?? ENGINEERING_FALLBACK.default_view,
    hide_prefix_ids: hide_prefix_ids ?? ENGINEERING_FALLBACK.hide_prefix_ids,
    custom_fields: Array.from(customFieldsById.values()),
    task_templates: Array.from(taskTemplatesById.values()),
  };
}

async function loadEngineeringBundled(): Promise<SkillProjectConfig | null> {
  try {
    const rows = await db
      .select({ project_config: skills.project_config })
      .from(skills)
      .where(
        and(
          eq(skills.source, 'bundled'),
          eq(skills.slug, 'engineering'),
          isNull(skills.org_id),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    return (rows[0]!.project_config as SkillProjectConfig) ?? null;
  } catch {
    return null;
  }
}

// ─── Public resolver ─────────────────────────────────────────────────────
export async function getProjectResolvedConfig(
  projectId: string,
): Promise<ProjectResolvedConfig> {
  const now = Date.now();
  const hit = cache.get(projectId);
  if (hit && hit.expires_at > now) {
    return hit.value;
  }

  // 1. Attached project skills, ordered.
  const attached = await db
    .select({ project_config: skills.project_config })
    .from(projectSkills)
    .innerJoin(skills, eq(projectSkills.skill_id, skills.id))
    .where(eq(projectSkills.project_id, projectId))
    .orderBy(asc(projectSkills.attachment_order));

  let resolved: ProjectResolvedConfig;

  if (attached.length > 0) {
    resolved = mergeConfigs(
      attached.map((r) => (r.project_config as SkillProjectConfig) ?? {}),
    );
  } else {
    // 2. No skills — fall back to the bundled Engineering skill row.
    const bundled = await loadEngineeringBundled();
    if (bundled) {
      resolved = mergeConfigs([bundled]);
    } else {
      // 3. Even the bundled row is missing — use the hardcoded fallback.
      resolved = ENGINEERING_FALLBACK;
    }
  }

  cache.set(projectId, { value: resolved, expires_at: now + CACHE_TTL_MS });
  return resolved;
}
