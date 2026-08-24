/**
 * Canonical status vocabulary, transition graph, and priority vocabulary
 * for every project. Previously driven by skills.project_config via
 * project-resolved-config.ts; now hardcoded after the Phase-4-reversal
 * simplification. See:
 *   docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md
 *
 * If per-project customization is ever re-introduced, these constants are
 * the thing that becomes configurable.
 */
export type StatusId = string;

export type ProjectResolvedConfig = {
  statuses: { id: StatusId; label: string; color: string; order: number }[];
  allowed_transitions: Record<StatusId, StatusId[]> | null;
};

export const ENGINEERING_STATUSES: ProjectResolvedConfig['statuses'] = [
  { id: 'backlog', label: 'Backlog', color: '#6b7280', order: 0 },
  { id: 'todo', label: 'To Do', color: '#3b82f6', order: 1 },
  { id: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2 },
  { id: 'in_review', label: 'In Review', color: '#8b5cf6', order: 3 },
  { id: 'done', label: 'Done', color: '#10b981', order: 4 },
  { id: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 5 },
];

export const ENGINEERING_TRANSITIONS: Record<StatusId, StatusId[]> = {
  backlog: ['todo', 'in_progress', 'cancelled'],
  todo: ['in_progress', 'backlog', 'cancelled'],
  in_progress: ['in_review', 'done', 'backlog', 'cancelled'],
  in_review: ['in_progress', 'done', 'cancelled'],
  done: ['in_progress', 'backlog'],
  cancelled: ['backlog'],
};

export const ENGINEERING_PRIORITY_VOCAB = {
  kind: 'numbered' as const,
  labels: ['p0', 'p1', 'p2', 'p3'],
};

export const ENGINEERING_DEFAULTS: ProjectResolvedConfig = {
  statuses: ENGINEERING_STATUSES,
  allowed_transitions: ENGINEERING_TRANSITIONS,
};

export function isValidTransition(
  from: StatusId,
  to: StatusId,
  projectResolvedConfig: ProjectResolvedConfig,
): boolean {
  const statusIds = new Set(projectResolvedConfig.statuses.map((s) => s.id));
  if (!statusIds.has(to)) return false;
  if (from === to) return true;
  if (projectResolvedConfig.allowed_transitions) {
    const allowed = projectResolvedConfig.allowed_transitions[from];
    if (!allowed) return false;
    return allowed.includes(to);
  }
  return true;
}

/**
 * Return the status values a caller may choose next, preserving the transition
 * graph's preferred order. A same-status no-op remains valid for update
 * semantics but is not a next state and is therefore omitted from this
 * executable read contract.
 */
export function allowedNextStatuses(
  from: StatusId,
  projectResolvedConfig: ProjectResolvedConfig,
): StatusId[] {
  const statusIds = projectResolvedConfig.statuses.map((status) => status.id);
  if (!statusIds.includes(from)) return [];
  if (!projectResolvedConfig.allowed_transitions) {
    return statusIds.filter((status) => status !== from);
  }
  const validStatuses = new Set(statusIds);
  return (projectResolvedConfig.allowed_transitions[from] ?? [])
    .filter((status) => status !== from && validStatuses.has(status));
}
