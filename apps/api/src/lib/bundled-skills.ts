/**
 * First-party bundled skills shipped with Deft. Agent-only after the
 * 2026-04-18 simplification — see
 * docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md.
 *
 * One skill per available capability pack. Deft Workspace carries the 9
 * task tools (PHASE3_TASK_TOOLS); every other skill exposes just its
 * capability pack. Bundled rows live cross-tenant (org_id = NULL); the
 * seeder upserts on (source, COALESCE(org_id,''), slug).
 */
import type { SkillAgentConfig } from './skill-config.js';
import { getAvailableCapabilityPacks } from './capability-packs.js';

export type BundledSkill = {
  /** Stable id derived from slug so re-seeds target the same row. */
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  version: string;
  agent_config: SkillAgentConfig;
};

const DEFAULT_VERSION = '1.0.0';

// The 9 verb-first task tools introduced in Phase 3. Originally lived on
// the Engineering bundled skill; moved to Deft Workspace in Task 7 so
// every tenant picks them up automatically (Deft Workspace is installed
// on every agent by default).
const PHASE3_TASK_TOOLS = [
  'comment_on_task',
  'set_priority',
  'set_due_date',
  'add_label',
  'close_task',
  'reopen_task',
  'add_dependency',
  'remove_dependency',
  'list_my_tasks',
];

const capabilityPackSkills: BundledSkill[] = getAvailableCapabilityPacks().map((pack) => {
  const baseAgentConfig: SkillAgentConfig = { capability_packs: [pack.slug] };
  if (pack.slug === 'deft-workspace') {
    baseAgentConfig.tools = PHASE3_TASK_TOOLS;
  }
  return {
    id: `skill_bundled_${pack.slug}`,
    slug: pack.slug,
    name: pack.display_name,
    description: pack.description,
    icon: null,
    version: DEFAULT_VERSION,
    agent_config: baseAgentConfig,
  };
});

// `deft-mcp-client` bundled skill.
//
// On-ramp for any BYOA agent to talk back into a Deft workspace.
// Installing it on an agent wires the sidecar to register Deft's MCP
// server at boot so the agent can call task_query / message_post /
// platform_context / etc. without per-agent config.
const deftMcpClientSkill: BundledSkill = {
  id: 'skill_bundled_deft-mcp-client',
  slug: 'deft-mcp-client',
  name: 'Deft MCP client',
  description:
    'Wires a BYOA agent back into its Deft workspace over MCP. Grants task_query, message_post, platform_context, memory_recall, and thread_fetch without per-agent config.',
  icon: null,
  version: DEFAULT_VERSION,
  agent_config: {
    mcp_servers: [
      {
        name: 'deft',
        transport: 'streamable-http',
        url: '${DEFT_API_URL}/api/mcp/v1',
        headers: {
          Authorization: 'Bearer ${DEFT_MCP_TOKEN}',
        },
      },
    ],
    requires_env: ['DEFT_API_URL', 'DEFT_MCP_TOKEN'],
    system_prompt_addition:
      'You have an MCP connection to your Deft workspace. Call `deft_platform_context` first on every turn — it is the source of truth for today, your org, your teammates, and your active work.',
  },
};

export const BUNDLED_SKILLS: BundledSkill[] = [...capabilityPackSkills, deftMcpClientSkill];
