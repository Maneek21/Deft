/**
 * Collapsed resolver — always returns engineering defaults.
 *
 * Previously read `project_skills` and merged `skills.project_config`
 * jsonb. That machinery retired in the Phase-4-reversal simplification;
 * per-project customization is a non-goal. See:
 *   docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md
 *
 * Kept as a function (not a constant) so existing async callers don't
 * need signature changes. invalidate/clear helpers are no-ops retained
 * for API compatibility — callers that invalidate after mutations still
 * compile without change.
 */
import {
  ENGINEERING_STATUSES,
  ENGINEERING_TRANSITIONS,
  ENGINEERING_PRIORITY_VOCAB,
  type ProjectResolvedConfig as BaseProjectResolvedConfig,
} from './task-status-machine.js';

export type TaskTemplateItem = {
  id: string;
  name: string;
  tasks: Array<{ title: string; status?: string; due_date?: string }>;
};

export type CustomFieldItem = {
  id: string;
  label: string;
  type: string;
  options?: string[];
};

export type ProjectResolvedConfig = BaseProjectResolvedConfig & {
  priority_vocab: typeof ENGINEERING_PRIORITY_VOCAB;
  default_view: 'board' | 'list' | 'calendar' | 'pipeline' | 'timeline';
  hide_prefix_ids: boolean;
  custom_fields: CustomFieldItem[];
  task_templates: TaskTemplateItem[];
};

const RESOLVED: ProjectResolvedConfig = {
  statuses: ENGINEERING_STATUSES,
  allowed_transitions: ENGINEERING_TRANSITIONS,
  priority_vocab: ENGINEERING_PRIORITY_VOCAB,
  default_view: 'board',
  hide_prefix_ids: false,
  custom_fields: [] as CustomFieldItem[],
  task_templates: [] as TaskTemplateItem[],
};

export async function getProjectResolvedConfig(
  _projectId: string,
): Promise<ProjectResolvedConfig> {
  return RESOLVED;
}

export function invalidateProjectResolvedConfig(_projectId: string): void {
  // No-op. Kept for call-site compatibility.
}

export function _clearProjectResolvedConfigCache(): void {
  // No-op. Kept for call-site compatibility.
}
