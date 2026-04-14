/**
 * Phase 9 — Seed the 8 first-party employee templates.
 *
 * Reads SOUL.md / AGENTS.md / USER.md / TOOLS.md from
 *   apps/api/src/scripts/templates/<slug>/{soul,agents,user,tools}.md
 * and upserts each template into `agent_employee_templates`.
 *
 * Idempotent: running twice results in 8 rows (not 16). Re-running refreshes
 * the markdown content without breaking FK relationships from deployed
 * employees — `agent_employees.template_slug` is FK to the slug column.
 *
 * Run:
 *   pnpm --filter @deft/api exec tsx src/scripts/seed-templates.ts
 *   # or from repo root:
 *   pnpm tsx apps/api/src/scripts/seed-templates.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../lib/db.js';
import { agentEmployeeTemplates } from '@deft/db/schema';
import { sql } from 'drizzle-orm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

// ─── Template metadata ────────────────────────────────────────────────────
// Note: `role` is constrained by the agent_employee_role enum which in Phase
// 2 has only four values: project_manager, engineering_lead,
// executive_assistant, custom, plus the task-61 expansions:
// product_designer, qa_engineer, customer_success, community_manager, cfo.
// Every Phase-9 template now maps to its semantic role rather than 'custom'.
type TemplateMeta = {
  slug: string;
  name: string;
  version: string;
  role:
    | 'project_manager'
    | 'engineering_lead'
    | 'executive_assistant'
    | 'custom'
    | 'product_designer'
    | 'qa_engineer'
    | 'customer_success'
    | 'community_manager'
    | 'cfo';
  description: string;
  default_tools: string[];
  default_capability_packs: string[];
  default_trust_level: 'conservative' | 'standard' | 'autonomous';
  default_trigger_subscriptions: string[];
  model_recommendation: string;
  fallback_models: string[];
  source: 'first-party' | 'community' | 'user';
  source_attribution: string | null;
};

const DEFAULT_FALLBACKS = ['anthropic/claude-haiku-4-5-20251001'];

export const TEMPLATE_META: TemplateMeta[] = [
  {
    slug: 'alex-pm',
    name: 'Alex — Project Manager',
    version: '1.0.0',
    role: 'project_manager',
    description:
      'Keeps sprints on track, summarises standups, flags blockers, and turns chat activity into tasks. Good for any team that wants an always-on PM.',
    default_tools: [
      'deft_platform_context',
      'wiki_search',
      'tasks_list',
      'task_create',
      'task_update',
      'messages_recent',
      'message_post',
      'reminder_create',
      'delegation_self_report',
      'memory_write',
      'events_upcoming',
    ],
    default_capability_packs: [
      'deft-workspace',
      'web-browsing',
      'tavily',
      'github',
      'google-calendar',
    ],
    default_trust_level: 'standard',
    default_trigger_subscriptions: ['cron:standup'],
    model_recommendation: 'anthropic/claude-sonnet-4-6',
    fallback_models: DEFAULT_FALLBACKS,
    source: 'community',
    source_attribution:
      'Adapted from mergisi/awesome-openclaw-agents (MIT): agents/productivity/daily-standup/SOUL.md',
  },
  {
    slug: 'designer',
    name: 'Dara — Product Designer',
    version: '1.0.0',
    role: 'product_designer',
    description:
      'Product designer and UX researcher. Reviews specs, audits design patterns in the wiki, and drafts design tickets with clear user stories.',
    default_tools: [
      'deft_platform_context',
      'wiki_search',
      'tasks_list',
      'task_create',
      'task_update',
      'messages_recent',
      'message_post',
      'memory_write',
      'delegation_self_report',
      'events_upcoming',
    ],
    default_capability_packs: ['deft-workspace', 'web-browsing', 'tavily'],
    default_trust_level: 'standard',
    default_trigger_subscriptions: [],
    model_recommendation: 'anthropic/claude-sonnet-4-6',
    fallback_models: DEFAULT_FALLBACKS,
    source: 'community',
    source_attribution:
      'Adapted from mergisi/awesome-openclaw-agents (MIT): agents/creative/ux-researcher/SOUL.md',
  },
  {
    slug: 'qa',
    name: 'Quinn — QA Engineer',
    version: '1.0.0',
    role: 'qa_engineer',
    description:
      'QA engineer and test-plan author. Reproduces bugs before filing, writes repeatable steps, and drives release go/no-go reports.',
    default_tools: [
      'deft_platform_context',
      'wiki_search',
      'tasks_list',
      'task_create',
      'task_update',
      'messages_recent',
      'message_post',
      'memory_write',
      'delegation_self_report',
      'github_list_pulls',
      'github_get_pr',
    ],
    default_capability_packs: ['deft-workspace', 'web-browsing', 'github'],
    default_trust_level: 'standard',
    default_trigger_subscriptions: [],
    model_recommendation: 'anthropic/claude-sonnet-4-6',
    fallback_models: DEFAULT_FALLBACKS,
    source: 'community',
    source_attribution:
      'Adapted from mergisi/awesome-openclaw-agents (MIT): agents/development/qa-tester/SOUL.md',
  },
  {
    slug: 'cs',
    name: 'Sam — Customer Success',
    version: '1.0.0',
    role: 'customer_success',
    description:
      'Customer success lead. Responds to support tickets with empathy and precision, turns recurring complaints into product-team follow-ups.',
    default_tools: [
      'deft_platform_context',
      'wiki_search',
      'tasks_list',
      'task_create',
      'task_update',
      'messages_recent',
      'message_post',
      'reminder_create',
      'memory_write',
      'delegation_self_report',
    ],
    default_capability_packs: ['deft-workspace', 'web-browsing'],
    default_trust_level: 'standard',
    default_trigger_subscriptions: [],
    model_recommendation: 'anthropic/claude-sonnet-4-6',
    fallback_models: DEFAULT_FALLBACKS,
    source: 'community',
    source_attribution:
      'Adapted from mergisi/awesome-openclaw-agents (MIT): agents/customer-success/onboarding-guide/SOUL.md',
  },
  {
    slug: 'community',
    name: 'Riley — Community Manager',
    version: '1.0.0',
    role: 'community_manager',
    description:
      'Community manager and voice-of-the-brand. Scans external channels, drafts public replies, surfaces community sentiment back to the team.',
    default_tools: [
      'deft_platform_context',
      'wiki_search',
      'tasks_list',
      'task_create',
      'messages_recent',
      'message_post',
      'memory_write',
      'delegation_self_report',
    ],
    default_capability_packs: ['deft-workspace', 'web-browsing', 'tavily'],
    default_trust_level: 'conservative',
    default_trigger_subscriptions: [],
    model_recommendation: 'anthropic/claude-haiku-4-5-20251001',
    fallback_models: DEFAULT_FALLBACKS,
    source: 'community',
    source_attribution:
      'Adapted from mergisi/awesome-openclaw-agents (MIT): agents/marketing/social-media/SOUL.md',
  },
  {
    slug: 'on-call',
    name: 'Nova — On-call Responder',
    version: '1.0.0',
    role: 'engineering_lead',
    description:
      'Incident responder and post-mortem facilitator. Acknowledges alerts, classifies severity, coordinates responders, and drives blameless post-mortems.',
    default_tools: [
      'deft_platform_context',
      'wiki_search',
      'tasks_list',
      'task_create',
      'task_update',
      'messages_recent',
      'message_post',
      'memory_write',
      'delegation_self_report',
      'github_list_pulls',
      'github_get_pr',
      'events_upcoming',
      'shell_exec',
    ],
    default_capability_packs: [
      'deft-workspace',
      'web-browsing',
      'tavily',
      'github',
      'shell-exec',
    ],
    default_trust_level: 'conservative',
    default_trigger_subscriptions: [],
    model_recommendation: 'anthropic/claude-opus-4-6',
    fallback_models: DEFAULT_FALLBACKS,
    source: 'community',
    source_attribution:
      'Adapted from mergisi/awesome-openclaw-agents (MIT): agents/devops/incident-responder/SOUL.md',
  },
  {
    slug: 'cfo',
    name: 'Morgan — CFO',
    version: '1.0.0',
    role: 'cfo',
    description:
      'CFO and financial analyst. Tracks runway, drafts the weekly burn report, models spend scenarios, and flags auto-renewing contracts.',
    default_tools: [
      'deft_platform_context',
      'wiki_search',
      'members_list',
      'tasks_list',
      'task_create',
      'task_update',
      'message_post',
      'memory_write',
      'delegation_self_report',
      'events_upcoming',
    ],
    default_capability_packs: ['deft-workspace', 'google-calendar'],
    default_trust_level: 'conservative',
    default_trigger_subscriptions: ['cron:weekly-burn-report'],
    model_recommendation: 'anthropic/claude-opus-4-6',
    fallback_models: DEFAULT_FALLBACKS,
    source: 'first-party',
    source_attribution: null,
  },
  {
    slug: 'devops',
    name: 'Devin — DevOps Engineer',
    version: '1.0.0',
    role: 'engineering_lead',
    description:
      'DevOps and platform engineer. Reviews merged PRs for deploy impact, maintains runbooks in the wiki, and coordinates releases with rollback plans.',
    default_tools: [
      'deft_platform_context',
      'wiki_search',
      'tasks_list',
      'task_create',
      'task_update',
      'messages_recent',
      'message_post',
      'memory_write',
      'delegation_self_report',
      'github_list_pulls',
      'github_get_pr',
      'shell_exec',
    ],
    default_capability_packs: [
      'deft-workspace',
      'web-browsing',
      'github',
      'shell-exec',
    ],
    default_trust_level: 'standard',
    default_trigger_subscriptions: ['webhook:pr-merged'],
    model_recommendation: 'anthropic/claude-sonnet-4-6',
    fallback_models: DEFAULT_FALLBACKS,
    source: 'first-party',
    source_attribution: null,
  },
];

function readMarkdown(slug: string, file: 'soul' | 'agents' | 'user' | 'tools'): string {
  const path = join(TEMPLATES_DIR, slug, `${file}.md`);
  return readFileSync(path, 'utf8');
}

export async function seedTemplates(opts: { silent?: boolean } = {}): Promise<number> {
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };
  log(`[seed-templates] Upserting ${TEMPLATE_META.length} templates from ${TEMPLATES_DIR}`);

  for (const meta of TEMPLATE_META) {
    const soulMd = readMarkdown(meta.slug, 'soul');
    const agentsMd = readMarkdown(meta.slug, 'agents');
    const userMdTemplate = readMarkdown(meta.slug, 'user');
    const toolsMd = readMarkdown(meta.slug, 'tools');

    // Deterministic id derived from slug so re-runs update in place. We
    // intentionally use a stable id instead of random so the ON CONFLICT
    // path targets the same row even across clean-room re-seeds.
    const id = `tmpl_${meta.slug}`;

    await db
      .insert(agentEmployeeTemplates)
      .values({
        id,
        slug: meta.slug,
        name: meta.name,
        version: meta.version,
        role: meta.role,
        description: meta.description,
        soul_md: soulMd,
        agents_md: agentsMd,
        user_md_template: userMdTemplate,
        tools_md: toolsMd,
        default_tools: meta.default_tools,
        default_capability_packs: meta.default_capability_packs,
        default_trust_level: meta.default_trust_level,
        default_trigger_subscriptions: meta.default_trigger_subscriptions,
        model_recommendation: meta.model_recommendation,
        fallback_models: meta.fallback_models,
        source: meta.source,
        source_attribution: meta.source_attribution,
        is_public: true,
      })
      .onConflictDoUpdate({
        target: agentEmployeeTemplates.slug,
        set: {
          name: meta.name,
          version: meta.version,
          role: meta.role,
          description: meta.description,
          soul_md: soulMd,
          agents_md: agentsMd,
          user_md_template: userMdTemplate,
          tools_md: toolsMd,
          default_tools: meta.default_tools,
          default_capability_packs: meta.default_capability_packs,
          default_trust_level: meta.default_trust_level,
          default_trigger_subscriptions: meta.default_trigger_subscriptions,
          model_recommendation: meta.model_recommendation,
          fallback_models: meta.fallback_models,
          source: meta.source,
          source_attribution: meta.source_attribution,
          is_public: true,
          updated_at: sql`now()`,
        },
      });
    log(`  upserted ${meta.slug}`);
  }

  log(`[seed-templates] Done. Seeded ${TEMPLATE_META.length} templates.`);
  return TEMPLATE_META.length;
}

// Run when invoked directly (not when imported as a module).
const entryPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] === entryPath ||
  process.argv[1]?.replace(/\\/g, '/') === entryPath.replace(/\\/g, '/');
if (invokedDirectly) {
  seedTemplates()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed-templates] FAILED:', err);
      process.exit(1);
    });
}
