/**
 * Collapsed web resolver — synchronously returns hardcoded engineering
 * defaults. Previously fetched `/api/projects/:id/resolved-config` and
 * merged per-skill jsonb. That machinery retired in the
 * Phase-4-reversal simplification (2026-04-18):
 *   docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md
 *
 * Preserves the `{ config, loading, error, refresh }` return shape so
 * consumers (task-board, task-card, task-table, task-filters,
 * task-pipeline-view, task-quick-create, task-detail, tasks/page) keep
 * compiling without changes. Every project renders the same engineering
 * vocabulary and `config` is always non-null (fixes the Marketing board
 * crash: "Cannot read properties of undefined (reading 'length')").
 *
 * All exported types and utility functions are preserved because
 * task-board, task-filters, and task-detail import them directly.
 */

export type ResolvedStatus = {
  id: string;
  label: string;
  color: string;
  order: number;
};

export type PriorityVocab = {
  kind: 'numbered' | 'named' | 'temperature';
  labels: string[];
};

export type CustomField = {
  id: string;
  label: string;
  type: string;
  options?: string[];
};

export type TaskTemplate = {
  id: string;
  name: string;
  tasks: Array<{ title: string; status?: string; due_date?: string }>;
};

export type ResolvedConfig = {
  statuses: ResolvedStatus[];
  priority_vocab: PriorityVocab;
  default_view: 'board' | 'list' | 'calendar' | 'pipeline' | 'timeline';
  hide_prefix_ids: boolean;
  custom_fields: CustomField[];
  task_templates: TaskTemplate[];
  allowed_transitions: Record<string, string[]> | null;
};

const ENGINEERING_STATUSES: ResolvedStatus[] = [
  { id: 'backlog', label: 'Backlog', color: '#6b7280', order: 0 },
  { id: 'todo', label: 'To Do', color: '#3b82f6', order: 1 },
  { id: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2 },
  { id: 'in_review', label: 'In Review', color: '#8b5cf6', order: 3 },
  { id: 'done', label: 'Done', color: '#10b981', order: 4 },
  { id: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 5 },
];

const HARDCODED: ResolvedConfig = {
  statuses: ENGINEERING_STATUSES,
  allowed_transitions: {
    backlog: ['todo', 'in_progress', 'cancelled'],
    todo: ['in_progress', 'backlog', 'cancelled'],
    in_progress: ['in_review', 'done', 'backlog', 'cancelled'],
    in_review: ['in_progress', 'done', 'cancelled'],
    done: ['in_progress', 'backlog'],
    cancelled: ['backlog'],
  },
  priority_vocab: { kind: 'numbered', labels: ['p0', 'p1', 'p2', 'p3'] },
  default_view: 'board',
  hide_prefix_ids: false,
  custom_fields: [],
  task_templates: [],
};

/**
 * No-op kept for call-site compatibility. The sessionStorage cache no
 * longer exists so there is nothing to invalidate.
 */
export function invalidateCachedResolvedConfig(_projectId: string): void {
  // no-op
}

export function useProjectResolvedConfig(_projectId: string | null | undefined) {
  return {
    config: HARDCODED,
    loading: false,
    error: null as string | null,
    refresh: (): Promise<void> => Promise.resolve(),
  };
}

// ─── Priority label mapping (render-time only) ──────────────────────────────
//
// The DB stores canonical p0/p1/p2/p3; the UI maps at render time based on
// the project's priority_vocab kind.

export type CanonicalPriority = 'p0' | 'p1' | 'p2' | 'p3';

const NAMED_MAP: Record<CanonicalPriority, string> = {
  p0: 'High',
  p1: 'Medium',
  p2: 'Low',
  p3: 'Low',
};

const TEMPERATURE_MAP: Record<CanonicalPriority, string> = {
  p0: 'Hot',
  p1: 'Warm',
  p2: 'Cold',
  p3: 'Cold',
};

export function priorityLabel(priority: CanonicalPriority, vocab?: PriorityVocab | null): string {
  if (!vocab || vocab.kind === 'numbered') {
    return priority.toUpperCase();
  }
  if (vocab.kind === 'named') return NAMED_MAP[priority];
  if (vocab.kind === 'temperature') return TEMPERATURE_MAP[priority];
  return priority.toUpperCase();
}

/** Extended label (includes urgency qualifier) used in filter dropdown UI. */
export function priorityFullLabel(priority: CanonicalPriority, vocab?: PriorityVocab | null): string {
  const short = priorityLabel(priority, vocab);
  if (!vocab || vocab.kind === 'numbered') {
    const map: Record<CanonicalPriority, string> = {
      p0: 'Urgent',
      p1: 'High',
      p2: 'Medium',
      p3: 'Low',
    };
    return `${short} — ${map[priority]}`;
  }
  return short;
}
