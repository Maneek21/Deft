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
  /**
   * Block 1.6 / 3.4 — env vars the skill requires at install time.
   * Pre-deploy flow matches each key against connected_accounts (OAuth)
   * first, falls back to `skill_secrets` on miss.
   */
  requires_env?: string[];
  /**
   * Block 3.4 — MCP server the skill wires the sidecar to. Declared by
   * `deft-mcp-client` so OpenClaw sidecars register Deft's MCP server at
   * boot; other skills may use this too in the future.
   */
  mcp_servers?: Array<{
    name: string;
    transport: 'stdio' | 'sse' | 'streamable-http';
    /** URL for sse/streamable-http; command for stdio. */
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
  }>;
};
