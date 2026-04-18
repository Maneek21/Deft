/**
 * Unified skill primitive typings — agent-only after the
 * Phase-4-reversal simplification (2026-04-18). See:
 *   docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md
 *
 * The per-project fork (SkillProjectConfig + SkillProjectStatus) retired
 * alongside the project_skills junction and skills.project_config column.
 * A skill is now strictly a bundle of agent capabilities.
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
