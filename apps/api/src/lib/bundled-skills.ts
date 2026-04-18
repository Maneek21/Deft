/**
 * Phase 4 Task 4.3 — First-party bundled skills shipped with Deft.
 *
 * Two families:
 *
 *   * Capability-pack skills (6) — one per entry in CAPABILITY_PACKS that is
 *     not marked coming_soon. Each is an agent-only skill whose agent_config
 *     simply grants the matching pack slug. Wizards + the deploy flow will
 *     install these on employees via agent_employee_skills rather than
 *     continuing to dump into agentEmployees.capability_packs[]. The
 *     project_config is an empty object.
 *
 *   * Project-workflow skills (3) — engineering / marketing-campaign /
 *     sales-pipeline. These populate project_config with statuses, priority
 *     vocab, default view, custom fields, task templates, and (for
 *     engineering) the allowed_transitions graph that mirrors the current
 *     hardcoded ENGINEERING_CONFIG. Engineering also ships the 9 new task
 *     tools from Phase 3 in agent_config.tools so an engineering-flavoured
 *     project automatically teaches them to any employee attached.
 *
 * Bundled rows live outside any tenant (org_id = NULL). The unique index is
 * (source='bundled', org_id IS NULL, slug) so every seeder re-run upserts in
 * place. Coming-soon capability packs are intentionally NOT seeded — they
 * will be added when they graduate out of coming_soon.
 */
import type { SkillAgentConfig } from './skill-config.js';
// Temporary shim — Task 16 will remove project_config from BundledSkill entirely.
type SkillProjectConfig = Record<string, unknown>;
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
  project_config: SkillProjectConfig;
};

const DEFAULT_VERSION = '1.0.0';

// The 9 verb-first task tools introduced in Phase 3. Engineering-flavoured
// projects ship these so employees attached to such projects get them
// without a separate install step.
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

// ─── Capability-pack skills (1 per available pack) ────────────────────
const capabilityPackSkills: BundledSkill[] = getAvailableCapabilityPacks().map((pack) => {
  const baseAgentConfig: BundledSkill['agent_config'] = {
    capability_packs: [pack.slug],
  };
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
    project_config: {},
  };
});

// ─── Project-workflow skill 1: engineering ────────────────────────────
const engineeringSkill: BundledSkill = {
  id: 'skill_bundled_engineering',
  slug: 'engineering',
  name: 'Engineering',
  description:
    'Software delivery workflow. Kanban board, p0–p3 priority, the six-status life cycle (backlog → todo → in_progress → in_review → done, plus cancelled), and the nine Phase-3 task tools.',
  icon: null,
  version: DEFAULT_VERSION,
  agent_config: { tools: PHASE3_TASK_TOOLS },
  project_config: {
    statuses: [
      { id: 'backlog', label: 'Backlog', color: '#6b7280', order: 0 },
      { id: 'todo', label: 'To Do', color: '#3b82f6', order: 1 },
      { id: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2 },
      { id: 'in_review', label: 'In Review', color: '#8b5cf6', order: 3 },
      { id: 'done', label: 'Done', color: '#10b981', order: 4 },
      { id: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 5 },
    ],
    priority_vocab: { kind: 'numbered', labels: ['p0', 'p1', 'p2', 'p3'] },
    default_view: 'board',
    hide_prefix_ids: false,
    // Matches the hardcoded ENGINEERING_CONFIG in project-resolved-config.ts
    // so the seeded skill is a drop-in replacement when Task 4.5 lands.
    allowed_transitions: {
      backlog: ['todo', 'in_progress', 'cancelled'],
      todo: ['in_progress', 'backlog', 'cancelled'],
      in_progress: ['in_review', 'done', 'backlog', 'cancelled'],
      in_review: ['in_progress', 'done', 'cancelled'],
      done: ['in_progress', 'backlog'],
      cancelled: ['backlog'],
    },
  },
};

// ─── Project-workflow skill 2: marketing-campaign ─────────────────────
const marketingSkill: BundledSkill = {
  id: 'skill_bundled_marketing_campaign',
  slug: 'marketing-campaign',
  name: 'Marketing Campaign',
  description:
    'Editorial + campaign workflow. Calendar view by default, High/Medium/Low priority, and a 7-task launch template. Heartbeat-ready for review queue hygiene.',
  icon: null,
  version: DEFAULT_VERSION,
  agent_config: {
    heartbeat_checklist: [
      'Review campaigns near publish date',
      'Flag briefs waiting >24h in review',
    ],
  },
  project_config: {
    statuses: [
      { id: 'ideas', label: 'Ideas', color: '#94a3b8', order: 0 },
      { id: 'drafting', label: 'Drafting', color: '#3b82f6', order: 1 },
      { id: 'in_review', label: 'In Review', color: '#f59e0b', order: 2 },
      { id: 'approved', label: 'Approved', color: '#8b5cf6', order: 3 },
      { id: 'scheduled', label: 'Scheduled', color: '#06b6d4', order: 4 },
      { id: 'live', label: 'Live', color: '#10b981', order: 5 },
      { id: 'archived', label: 'Archived', color: '#6b7280', order: 6 },
    ],
    priority_vocab: { kind: 'named', labels: ['High', 'Medium', 'Low'] },
    default_view: 'calendar',
    hide_prefix_ids: true,
    allowed_transitions: null,
    custom_fields: [
      {
        id: 'content_type',
        label: 'Content Type',
        type: 'select',
        options: ['Blog', 'Social', 'Email', 'Video', 'Landing Page', 'Press'],
      },
      {
        id: 'channel',
        label: 'Channel',
        type: 'select',
        options: ['Twitter', 'LinkedIn', 'Instagram', 'YouTube', 'Email', 'Web', 'Other'],
      },
      { id: 'asset_url', label: 'Asset URL', type: 'url' },
      { id: 'publish_url', label: 'Publish URL', type: 'url' },
      { id: 'approver', label: 'Approver', type: 'user' },
    ],
    task_templates: [
      {
        id: 'new-launch-campaign',
        name: 'New launch campaign',
        tasks: [
          { title: 'Campaign brief + goals', status: 'drafting' },
          { title: 'Asset list + copy doc', status: 'drafting' },
          { title: 'Design + creative assets', status: 'drafting' },
          { title: 'Stakeholder review', status: 'in_review' },
          { title: 'Schedule channels + posts', status: 'approved' },
          { title: 'Launch day coordination', status: 'scheduled' },
          { title: 'Post-launch retro + metrics', status: 'live' },
        ],
      },
    ],
  },
};

// ─── Project-workflow skill 3: sales-pipeline ─────────────────────────
const salesSkill: BundledSkill = {
  id: 'skill_bundled_sales_pipeline',
  slug: 'sales-pipeline',
  name: 'Sales Pipeline',
  description:
    'Deal pipeline with temperature priority (Hot/Warm/Cold), pipeline view, custom deal fields, and a 14-day re-engage sequence template. Heartbeat flags stale + hot deals.',
  icon: null,
  version: DEFAULT_VERSION,
  agent_config: {
    heartbeat_checklist: [
      'Flag deals with no contact in 7+ days',
      'Surface hot deals awaiting response',
    ],
  },
  project_config: {
    statuses: [
      { id: 'new', label: 'New', color: '#3b82f6', order: 0 },
      { id: 'qualified', label: 'Qualified', color: '#06b6d4', order: 1 },
      { id: 'demo', label: 'Demo', color: '#f59e0b', order: 2 },
      { id: 'proposal', label: 'Proposal', color: '#8b5cf6', order: 3 },
      { id: 'won', label: 'Won', color: '#10b981', order: 4 },
      { id: 'lost', label: 'Lost', color: '#ef4444', order: 5 },
      { id: 'snoozed', label: 'Snoozed', color: '#6b7280', order: 6 },
    ],
    priority_vocab: { kind: 'temperature', labels: ['Hot', 'Warm', 'Cold'] },
    default_view: 'pipeline',
    hide_prefix_ids: true,
    allowed_transitions: null,
    custom_fields: [
      { id: 'contact_name', label: 'Contact', type: 'text' },
      { id: 'company', label: 'Company', type: 'text' },
      { id: 'deal_value', label: 'Deal Value', type: 'currency' },
      { id: 'last_contact_at', label: 'Last Contact', type: 'date' },
      { id: 'next_step', label: 'Next Step', type: 'text' },
    ],
    task_templates: [
      {
        id: '14-day-reengage-sequence',
        name: '14-day re-engage sequence',
        tasks: [
          { title: 'Day 1 — value-add email referencing last convo', status: 'new' },
          { title: 'Day 4 — LinkedIn touch + relevant resource', status: 'new' },
          { title: 'Day 7 — case study from similar company', status: 'new' },
          { title: 'Day 11 — short calendar-link follow-up', status: 'new' },
          { title: 'Day 14 — break-up email, move to snoozed if no reply', status: 'new' },
        ],
      },
    ],
  },
};

export const BUNDLED_SKILLS: BundledSkill[] = [
  ...capabilityPackSkills,
  engineeringSkill,
  marketingSkill,
  salesSkill,
];
