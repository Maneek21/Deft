/**
 * Phase 4 — Unified skill primitive typings.
 *
 * A skill row (see `skills` table in `packages/db/src/schema.ts`) carries two
 * jsonb payloads, `agent_config` and `project_config`. These types are the
 * canonical TypeScript shape; runtime validation lives in per-route schemas.
 *
 * agent_config — attached via `agent_employee_skills`. Expands an employee's
 *   toolset, prompt, and trigger subscriptions when the skill is installed.
 *
 * project_config — attached via `project_skills`. Overrides a project's
 *   status vocabulary, priority labels, default board view, and optional
 *   task templates. Allowed-transition graphs pin workflow flow.
 */

export type SkillAgentConfig = {
  /** Native tool slugs granted to employees with this skill. */
  tools?: string[];
  /** Capability packs granted (see `apps/api/src/lib/capability-packs.ts`). */
  capability_packs?: string[];
  /** Trigger subscriptions appended to the employee's trigger list. */
  triggers?: string[];
  /** Additional instructions appended to the employee's system prompt. */
  system_prompt_addition?: string;
  /** Override the employee's trust level while the skill is installed. */
  trust_level_override?: 'conservative' | 'standard' | 'autonomous' | null;
  /** Preferred model the skill was authored against (advisory). */
  model_recommendation?: string;
  /** Periodic checks the employee runs when heartbeats are enabled. */
  heartbeat_checklist?: string[];
  /** Legacy JSON schema for skill params; retained from pre-Phase-4 rows. */
  param_schema?: Record<string, unknown>;
};

export type SkillProjectStatus = {
  id: string;
  label: string;
  color: string;
  order: number;
};

export type SkillProjectConfig = {
  /** Ordered status vocabulary; replaces the tasks.status enum display. */
  statuses?: SkillProjectStatus[];
  /** Priority vocabulary for the project; drives TaskCard + filters UI. */
  priority_vocab?: {
    kind: 'numbered' | 'named' | 'temperature';
    labels: string[];
  };
  /** Default view surfaced when opening the project. */
  default_view?: 'board' | 'list' | 'calendar' | 'pipeline' | 'timeline';
  /** When true, the task ID prefix (e.g. ENG-17) is hidden in UI. */
  hide_prefix_ids?: boolean;
  /** Extra typed fields appended to the task form. */
  custom_fields?: Array<{
    id: string;
    label: string;
    type: string;
    options?: string[];
  }>;
  /** Named task bundles the user can instantiate with one click. */
  task_templates?: Array<{
    id: string;
    name: string;
    tasks: Array<{ title: string; status?: string; due_date?: string }>;
  }>;
  /**
   * Optional adjacency list describing which status transitions are allowed.
   * `null` means no restriction; any status can move to any other. The key
   * and values must be status ids from `statuses[]`.
   */
  allowed_transitions?: Record<string, string[]> | null;
};
