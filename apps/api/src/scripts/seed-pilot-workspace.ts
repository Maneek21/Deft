/**
 * Post-demo pilot polish seed.
 *
 * `packages/db/seed-demo.ts` builds the core Testers Tomatoes workspace. This
 * script makes the clean local pilot state match the current self-hostable
 * direction: Defty + BYOA employees, no stale unread/audit noise, and a fresh
 * chat-to-wiki proof surface.
 *
 * Run:
 *   pnpm --filter @deft/api exec tsx src/scripts/seed-pilot-workspace.ts
 */
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { and, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { generateReceipt } from '../lib/receipts.js';
import { reconcileProjectTaskCountersForOrg } from '../lib/task-numbering.js';
import {
  actionReceipts,
  agentEmployees,
  agentEmployeeSkills,
  agentActions,
  crossReferences,
  events,
  labels,
  mcpTokens,
  messageClassifications,
  messages,
  notes,
  notifications,
  orgMembers,
  orgs,
  projectSpaces,
  projects,
  reminders,
  reactions,
  spaceMembers,
  spaces,
  standups,
  taskActivity,
  taskComments,
  taskLabels,
  taskReactions,
  taskRelationships,
  taskWatchers,
  teamDashboardSnapshots,
  teamHealthSnapshots,
  teamMembers,
  teamResources,
  teams,
  threadReads,
  tasks,
  userGroupMembers,
  userGroups,
  users,
  workIntents,
  wikiCitations,
  wikiLinks,
  wikiOpsLog,
  wikiPages,
  skills,
} from '@deft/db/schema';

const TOM_TOKEN = process.env.SEED_TOM_MCP_TOKEN ?? 'tom-pilot-mcp-token-2026';
const MAYA_TOKEN = process.env.SEED_MAYA_MCP_TOKEN ?? 'maya-pilot-mcp-token-2026';
const DIEGO_MCP_TOKEN = process.env.SEED_DIEGO_MCP_TOKEN ?? 'diego-demo-mcp-token-2026';
const PROOF_PHRASE = 'ruby-sunrise-2026';
const PILOT_ACTION_SOURCES_TO_PRUNE = [
  'pilot-living',
  'task_extract',
  'blocked_classifier',
  'defty_capture',
];

type SeedUser = typeof users.$inferSelect;
type SeedSpace = typeof spaces.$inferSelect;
type SeedProject = typeof projects.$inferSelect;
type SeedTaskInput = {
  number: number;
  title: string;
  description: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  assignee_id: string;
  due_date: Date;
  sort_order: number;
  start_date?: Date | null;
  estimation?: string | null;
  metadata?: Record<string, unknown>;
};
type PilotNotificationChannels = {
  chat: boolean;
  tasks: boolean;
  approvals: boolean;
  calendar: boolean;
  agents: boolean;
};
type PilotTeamRole = 'lead' | 'member' | 'viewer';
type PilotTeamResourceType = 'space' | 'project' | 'wiki_page' | 'note' | 'calendar_feed' | 'task_template' | 'agent_employee';

function expectOne<T>(rows: T[], label: string): T {
  const [row] = rows;
  if (!row) {
    throw new Error(`Expected ${label} to be returned.`);
  }
  return row;
}

function plusDays(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(17, 0, 0, 0);
  return date;
}

function atToday(hour: number, minute = 0): Date {
  const date = new Date();
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

function atOffsetDay(days: number, hour: number, minute = 0): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function mustFindPilotOrg() {
  const [org] = await db
    .select()
    .from(orgs)
    .where(eq(orgs.slug, 'testers-tomatoes'))
    .limit(1);
  if (!org) {
    throw new Error('Testers Tomatoes org not found. Run `pnpm db:seed:demo` first.');
  }
  return org;
}

async function findUserByEmail(email: string): Promise<SeedUser> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    throw new Error(`Expected seeded user ${email} was not found.`);
  }
  return user;
}

async function upsertAgentUser(params: {
  orgId: string;
  createdBy: string;
  name: string;
  slug: string;
  title: string;
  runtimeKind: string;
  jobTitle: string;
  systemPrompt: string;
  expertiseDescription: string;
  token: string;
  wakeMode: string;
  triggerSubscriptions: string[];
}): Promise<SeedUser> {
  const [existingEmployee] = await db
    .select()
    .from(agentEmployees)
    .where(and(eq(agentEmployees.org_id, params.orgId), eq(agentEmployees.slug, params.slug)))
    .limit(1);

  let userId = existingEmployee?.user_id;
  if (!userId) {
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, `${params.slug}@agents.testers-tomatoes.local`))
      .limit(1);

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const inserted = expectOne(await db
        .insert(users)
        .values({
          email: `${params.slug}@agents.testers-tomatoes.local`,
          name: params.name,
          kind: 'agent',
          is_agent: true,
          title: params.title,
          email_verified: true,
          timezone: 'America/Chicago',
          status_emoji: 'ready',
          status_text: 'Available for pilot work',
          last_seen_at: new Date(),
        })
        .returning(), `inserted user for ${params.slug}`);
      userId = inserted.id;
    }
  }

  await db
    .insert(orgMembers)
    .values({
      org_id: params.orgId,
      user_id: userId,
      role: 'member',
      is_active: true,
    })
    .onConflictDoUpdate({
      target: [orgMembers.org_id, orgMembers.user_id],
      set: { role: 'member', is_active: true, updated_at: new Date() },
    });

  const tokenHash = await bcrypt.hash(params.token, 10);
  const employeeValues = {
    org_id: params.orgId,
    user_id: userId,
    name: params.name,
    slug: params.slug,
    role: 'custom' as const,
    system_prompt: params.systemPrompt,
    expertise_description: params.expertiseDescription,
    starter_prompts: [
      'Read my assigned tasks and tell me what you will do first.',
      `Search company memory for ${PROOF_PHRASE} and summarize the relevant pilot context.`,
    ],
    trust_level: 'autonomous' as const,
    max_daily_actions: 80,
    heartbeat_enabled: false,
    is_active: true,
    is_deleted: false,
    is_byoa: true,
    byoa_model_info: params.runtimeKind,
    mcp_token_hash: tokenHash,
    runtime_kind: params.runtimeKind,
    job_title: params.jobTitle,
    wake_mode: params.wakeMode,
    certification_status: 'verified',
    last_verified_at: new Date(),
    last_mcp_call_at: null,
    last_work_outcome_at: null,
    connection_notes:
      'Clean local pilot seed assumes this BYOA runtime is already running and connects to Deft over MCP.',
    trigger_subscriptions: params.triggerSubscriptions,
    created_by: params.createdBy,
    updated_at: new Date(),
  };

  const employee = expectOne(await db
    .insert(agentEmployees)
    .values(employeeValues)
    .onConflictDoUpdate({
      target: [agentEmployees.org_id, agentEmployees.slug],
      set: employeeValues,
    })
    .returning(), `agent employee ${params.slug}`);

  const [workspaceSkill] = await db
    .select({ id: skills.id, version: skills.version })
    .from(skills)
    .where(and(eq(skills.slug, 'deft-workspace'), eq(skills.is_deleted, false)))
    .limit(1);
  if (!workspaceSkill) {
    throw new Error('Bundled deft-workspace skill is missing. Run seed-platform-bundles first.');
  }
  await db
    .insert(agentEmployeeSkills)
    .values({
      agent_employee_id: employee.id,
      skill_id: workspaceSkill.id,
      installed_version: workspaceSkill.version,
    })
    .onConflictDoUpdate({
      target: [agentEmployeeSkills.agent_employee_id, agentEmployeeSkills.skill_id],
      set: { installed_version: workspaceSkill.version, installed_at: new Date() },
    });

  const user = expectOne(await db
    .update(users)
    .set({
      name: params.name,
      kind: 'agent',
      is_agent: true,
      title: params.title,
      email_verified: true,
      agent_employee_id: employee.id,
      last_seen_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(users.id, userId))
    .returning(), `updated user for ${params.slug}`);

  return user;
}

async function ensureSpace(params: {
  orgId: string;
  createdBy: string;
  name: string;
  description: string;
  topic: string;
}): Promise<SeedSpace> {
  const [existing] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.org_id, params.orgId), eq(spaces.name, params.name)))
    .limit(1);

  if (existing) {
    const updated = expectOne(await db
      .update(spaces)
      .set({
        description: params.description,
        topic: params.topic,
        type: 'public',
        is_archived: false,
        agent_enabled: true,
        updated_at: new Date(),
      })
      .where(eq(spaces.id, existing.id))
      .returning(), `updated space ${params.name}`);
    return updated;
  }

  const created = expectOne(await db
    .insert(spaces)
    .values({
      org_id: params.orgId,
      name: params.name,
      description: params.description,
      topic: params.topic,
      type: 'public',
      is_default: false,
      is_archived: false,
      agent_enabled: true,
      created_by: params.createdBy,
    })
    .returning(), `created space ${params.name}`);
  return created;
}

async function ensureSpaceMembers(spaceIds: string[], userIds: string[]) {
  for (const spaceId of spaceIds) {
    for (const userId of userIds) {
      await db
        .insert(spaceMembers)
        .values({
          space_id: spaceId,
          user_id: userId,
          notification_level: 'all',
          last_read_at: new Date(),
        })
        .onConflictDoUpdate({
          target: [spaceMembers.space_id, spaceMembers.user_id],
          set: { notification_level: 'all', last_read_at: new Date() },
        });
    }
  }
}

async function ensureProject(params: {
  orgId: string;
  leadId: string;
  name: string;
  description: string;
  prefix: string;
  icon?: string;
  color?: string;
  taskCounter?: number;
}): Promise<SeedProject> {
  const [existing] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.org_id, params.orgId), eq(projects.prefix, params.prefix)))
    .limit(1);

  const values = {
    name: params.name,
    description: params.description,
    lead_id: params.leadId,
    is_archived: false,
    is_deleted: false,
    deleted_at: null,
    task_counter: params.taskCounter ?? 16,
    updated_at: new Date(),
  };

  if (existing) {
    const updated = expectOne(await db
      .update(projects)
      .set(values)
      .where(eq(projects.id, existing.id))
      .returning(), `updated project ${params.prefix}`);
    return updated;
  }

  const created = expectOne(await db
    .insert(projects)
    .values({
      org_id: params.orgId,
      name: params.name,
      description: params.description,
      prefix: params.prefix,
      icon: params.icon ?? 'Megaphone',
      color: params.color ?? '#0ea5e9',
      lead_id: params.leadId,
      task_counter: params.taskCounter ?? 16,
    })
    .returning(), `created project ${params.prefix}`);
  return created;
}

async function ensurePilotLabels(orgId: string): Promise<Map<string, string>> {
  const labelInputs = [
    { name: 'launch-critical', color: '#dc2626' },
    { name: 'buyer-facing', color: '#2563eb' },
    { name: 'agent-owned', color: '#7c3aed' },
    { name: 'needs-human-review', color: '#d97706' },
    { name: 'operations-risk', color: '#059669' },
    { name: 'demo-beat', color: '#0f766e' },
  ];

  for (const label of labelInputs) {
    const [existing] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.org_id, orgId), eq(labels.name, label.name)))
      .limit(1);

    if (existing) {
      await db
        .update(labels)
        .set({ color: label.color, updated_at: new Date() })
        .where(eq(labels.id, existing.id));
    } else {
      await db
        .insert(labels)
        .values({ org_id: orgId, name: label.name, color: label.color });
    }
  }

  const rows = await db
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(and(eq(labels.org_id, orgId), inArray(labels.name, labelInputs.map((label) => label.name))));
  return new Map(rows.map((row) => [row.name, row.id]));
}

async function attachLabelsToTasks(params: {
  taskByNumber: Map<number, string>;
  labelsByName: Map<string, string>;
  assignments: Record<number, string[]>;
}) {
  const taskIds = [...params.taskByNumber.values()];
  if (taskIds.length > 0) {
    await db.delete(taskLabels).where(inArray(taskLabels.task_id, taskIds));
  }

  const values = Object.entries(params.assignments).flatMap(([taskNumber, labelNames]) => {
    const taskId = params.taskByNumber.get(Number(taskNumber));
    if (!taskId) return [];
    return labelNames.flatMap((labelName) => {
      const labelId = params.labelsByName.get(labelName);
      return labelId ? [{ task_id: taskId, label_id: labelId }] : [];
    });
  });

  if (values.length > 0) {
    await db.insert(taskLabels).values(values).onConflictDoNothing();
  }
}

async function seedTasks(params: {
  orgId: string;
  projectId: string;
  createdBy: string;
  diegoId: string;
  linaId: string;
  sageId: string;
  tomId: string;
  mayaId: string;
}) {
  const seededTasks: SeedTaskInput[] = [
    {
      number: 1,
      title: 'Draft farmers market launch copy for Sun Gold trial',
      description:
        'Use the wiki positioning notes and the proof phrase ruby-sunrise-2026. Produce short booth copy, one SMS blurb, and one buyer-facing paragraph.',
      status: 'todo' as const,
      priority: 'p1' as const,
      assignee_id: params.tomId,
      due_date: plusDays(1),
      sort_order: 1,
      estimation: '2h',
      metadata: { demo_surface: 'agent_task', customer: 'farmers_market' },
    },
    {
      number: 2,
      title: 'Summarize Field Co-op visit talking points',
      description:
        'Prepare the weekly comms summary for Diego and Lina. Include pricing sensitivity, cold-chain promise, and next follow-up owner.',
      status: 'todo' as const,
      priority: 'p1' as const,
      assignee_id: params.mayaId,
      due_date: plusDays(2),
      sort_order: 2,
      estimation: '90m',
      metadata: { demo_surface: 'agent_task', customer: 'field_coop' },
    },
    {
      number: 3,
      title: 'Prepare buyer FAQ for cold-chain claims',
      description:
        'Turn operations notes into a plain-language FAQ that a wholesale buyer can trust without reading internal ops docs.',
      status: 'in_progress' as const,
      priority: 'p2' as const,
      assignee_id: params.tomId,
      due_date: plusDays(4),
      sort_order: 3,
      estimation: '3h',
      metadata: { demo_surface: 'buyer_enablement', risk: 'claims_review' },
    },
    {
      number: 4,
      title: 'Write weekly marketing pulse for Diego',
      description:
        'Create a concise update with wins, risks, and asks. Pull context from wiki and current marketing tasks.',
      status: 'todo' as const,
      priority: 'p2' as const,
      assignee_id: params.mayaId,
      due_date: plusDays(5),
      sort_order: 4,
      estimation: '1h',
      metadata: { demo_surface: 'weekly_update' },
    },
    {
      number: 5,
      title: 'Review cold-chain wording for buyer launch',
      description:
        'Review Tom\'s buyer-facing copy for operational accuracy. Keep claims specific: delivery window, harvest timing, and temperature-log practice.',
      status: 'in_review' as const,
      priority: 'p1' as const,
      assignee_id: params.linaId,
      due_date: plusDays(2),
      sort_order: 5,
      estimation: '45m',
      metadata: { demo_surface: 'human_review', review_gate: 'sales_accuracy' },
    },
    {
      number: 6,
      title: 'Validate food-safety language in launch FAQ',
      description:
        'Check that the FAQ does not overstate audit status or cold-chain guarantees. Approve only claims backed by the wiki and current operating procedure.',
      status: 'todo' as const,
      priority: 'p2' as const,
      assignee_id: params.sageId,
      due_date: plusDays(3),
      sort_order: 6,
      estimation: '45m',
      metadata: { demo_surface: 'human_review', review_gate: 'food_safety' },
    },
    {
      number: 7,
      title: 'Approve Sun Gold trial launch package',
      description:
        'Final Diego review once Tom drafts copy, Maya summarizes the buyer context, Lina reviews claims, and Sage clears food-safety language.',
      status: 'done' as const,
      priority: 'p2' as const,
      assignee_id: params.diegoId,
      due_date: plusDays(5),
      sort_order: 7,
      estimation: '30m',
      metadata: { demo_surface: 'manager_approval' },
    },
    {
      number: 8,
      title: 'Confirm Tuesday route capacity with Tomas',
      description:
        'Before any buyer promise goes out, confirm whether Tomas can hold the Tuesday delivery window for the Sun Gold trial.',
      status: 'in_progress' as const,
      priority: 'p0' as const,
      assignee_id: params.diegoId,
      due_date: atToday(11, 30),
      sort_order: 8,
      start_date: atToday(9, 0),
      estimation: '30m',
      metadata: { demo_surface: 'launch_blocker', blocker: true },
    },
    {
      number: 9,
      title: 'Call Chef Amara about first Sun Gold sample box',
      description:
        'Confirm sample size, delivery preference, and whether the kitchen wants flavor notes or farm handling notes in the package.',
      status: 'todo' as const,
      priority: 'p1' as const,
      assignee_id: params.diegoId,
      due_date: atToday(15, 0),
      sort_order: 9,
      start_date: atToday(14, 30),
      estimation: '30m',
      metadata: { demo_surface: 'buyer_call', customer: 'chef_amara' },
    },
    {
      number: 10,
      title: 'Update buyer list with cold-chain confidence notes',
      description:
        'Add a short note beside each buyer: needs strict delivery window, flexible pickup, chef sample, or wholesale volume conversation.',
      status: 'todo' as const,
      priority: 'p2' as const,
      assignee_id: params.diegoId,
      due_date: plusDays(1),
      sort_order: 10,
      estimation: '1h',
      metadata: { demo_surface: 'crm_lightweight' },
    },
    {
      number: 11,
      title: 'Pull three quotes from farmers market regulars',
      description:
        'Collect short, plain-spoken customer quotes Tom can weave into booth signage without sounding like a cereal box.',
      status: 'todo' as const,
      priority: 'p2' as const,
      assignee_id: params.mayaId,
      due_date: plusDays(1),
      sort_order: 11,
      estimation: '45m',
      metadata: { demo_surface: 'field_research' },
    },
    {
      number: 12,
      title: 'Check greenhouse photo set for launch visuals',
      description:
        'Choose four photos that show the actual Sun Gold crop, the harvest bins, and the cold-room handoff.',
      status: 'in_progress' as const,
      priority: 'p2' as const,
      assignee_id: params.linaId,
      due_date: plusDays(2),
      sort_order: 12,
      estimation: '1h',
      metadata: { demo_surface: 'assets' },
    },
    {
      number: 13,
      title: 'Draft booth sign microcopy for Saturday market',
      description:
        'Use the flavor-first positioning page. Keep it warm, specific, and operationally honest.',
      status: 'todo' as const,
      priority: 'p1' as const,
      assignee_id: params.tomId,
      due_date: plusDays(2),
      sort_order: 13,
      estimation: '90m',
      metadata: { demo_surface: 'creative_copy' },
    },
    {
      number: 14,
      title: 'Reconcile sample-box inventory with harvest forecast',
      description:
        'Check whether the launch plan matches expected Sun Gold yield after tomorrow morning\'s harvest estimate.',
      status: 'todo' as const,
      priority: 'p1' as const,
      assignee_id: params.sageId,
      due_date: plusDays(2),
      sort_order: 14,
      estimation: '1h',
      metadata: { demo_surface: 'inventory_risk' },
    },
    {
      number: 15,
      title: 'Post launch-readiness update in marketing space',
      description:
        'Summarize what is ready, what is blocked, and which task owners need attention before the buyer send.',
      status: 'todo' as const,
      priority: 'p2' as const,
      assignee_id: params.mayaId,
      due_date: plusDays(3),
      sort_order: 15,
      estimation: '45m',
      metadata: { demo_surface: 'status_update' },
    },
    {
      number: 16,
      title: 'Archive old spring promo claims from buyer deck',
      description:
        'Remove stale delivery and yield claims so the launch deck only reflects current Sun Gold operating reality.',
      status: 'done' as const,
      priority: 'p3' as const,
      assignee_id: params.diegoId,
      due_date: atOffsetDay(-1, 16, 0),
      sort_order: 16,
      estimation: '25m',
      metadata: { demo_surface: 'cleanup' },
    },
  ];

  for (const task of seededTasks) {
    await db
      .insert(tasks)
      .values({
        org_id: params.orgId,
        project_id: params.projectId,
        created_by: params.createdBy,
        ...task,
      })
      .onConflictDoUpdate({
        target: [tasks.project_id, tasks.number],
        set: {
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          assignee_id: task.assignee_id,
          due_date: task.due_date,
          start_date: task.start_date ?? null,
          estimation: task.estimation ?? null,
          metadata: task.metadata ?? null,
          sort_order: task.sort_order,
          is_deleted: false,
          updated_at: new Date(),
        },
      });
  }

  const taskRows = await db
    .select({ id: tasks.id, number: tasks.number })
    .from(tasks)
    .where(and(eq(tasks.org_id, params.orgId), eq(tasks.project_id, params.projectId)));
  const taskByNumber = new Map(taskRows.map((task) => [task.number, task.id]));
  const commentTaskIds = [...taskByNumber.values()];
  if (commentTaskIds.length > 0) {
    await db.delete(taskComments).where(inArray(taskComments.task_id, commentTaskIds));
    await db.delete(taskActivity).where(inArray(taskActivity.task_id, commentTaskIds));
    await db.delete(taskReactions).where(inArray(taskReactions.task_id, commentTaskIds));
    await db.delete(taskWatchers).where(inArray(taskWatchers.task_id, commentTaskIds));
  }

  const seededComments = [
    {
      task_id: taskByNumber.get(1),
      user_id: params.tomId,
      content:
        'I will use the Marketing Positioning wiki page, keep the copy practical, and avoid making cold-chain claims before Lina reviews them.',
    },
    {
      task_id: taskByNumber.get(2),
      user_id: params.mayaId,
      content:
        'Drafting a weekly summary for Diego and Lina with buyer pressure, follow-up owner, and the ruby-sunrise-2026 decision marker.',
    },
    {
      task_id: taskByNumber.get(5),
      user_id: params.linaId,
      content:
        'Review focus: promise Tuesday delivery only after Tomas confirms route capacity. No fuzzy reliability language.',
    },
    {
      task_id: taskByNumber.get(6),
      user_id: params.sageId,
      content:
        'I will clear the FAQ language against food-safety notes and the cold storage procedure before launch.',
    },
    {
      task_id: taskByNumber.get(7),
      user_id: params.diegoId,
      content:
        'Approved for the demo board: the workflow shows chat to memory to tasks to agent work to human review.',
    },
    {
      task_id: taskByNumber.get(8),
      user_id: params.diegoId,
      content:
        'This is the gating item. No Tuesday language leaves the farm until route capacity is confirmed.',
    },
    {
      task_id: taskByNumber.get(9),
      user_id: params.diegoId,
      content:
        'Chef Amara wants confidence more than poetry. Ask about prep timing and whether the sample box needs basil pairings.',
    },
    {
      task_id: taskByNumber.get(13),
      user_id: params.tomId,
      content:
        'I will draft this from the positioning page and keep the tomatoes charming, not suspiciously heroic.',
    },
    {
      task_id: taskByNumber.get(14),
      user_id: params.sageId,
      content:
        'I will reconcile the sample-box count after the harvest forecast lands tomorrow morning.',
    },
  ].filter((comment): comment is { task_id: string; user_id: string; content: string } => Boolean(comment.task_id));

  if (seededComments.length > 0) {
    await db.insert(taskComments).values(seededComments.map((comment) => ({
      org_id: params.orgId,
      task_id: comment.task_id,
      user_id: comment.user_id,
      content: comment.content,
    })));
  }

  const labelsByName = await ensurePilotLabels(params.orgId);
  await attachLabelsToTasks({
    taskByNumber,
    labelsByName,
    assignments: {
      1: ['agent-owned', 'buyer-facing'],
      2: ['agent-owned', 'demo-beat'],
      5: ['needs-human-review', 'buyer-facing'],
      6: ['needs-human-review', 'operations-risk'],
      8: ['launch-critical', 'operations-risk'],
      9: ['buyer-facing'],
      13: ['agent-owned', 'buyer-facing'],
      14: ['operations-risk'],
      15: ['agent-owned', 'demo-beat'],
    },
  });

  const watchedTaskIds = [1, 5, 8, 9, 13]
    .map((number) => taskByNumber.get(number))
    .filter((taskId): taskId is string => Boolean(taskId));
  if (watchedTaskIds.length > 0) {
    await db.insert(taskWatchers).values(watchedTaskIds.flatMap((taskId) => [
      { task_id: taskId, user_id: params.diegoId },
      { task_id: taskId, user_id: params.linaId },
    ])).onConflictDoNothing();
  }

  const taskReactionRows = [
    { task_id: taskByNumber.get(1), user_id: params.diegoId, emoji: 'review' },
    { task_id: taskByNumber.get(2), user_id: params.linaId, emoji: 'useful' },
    { task_id: taskByNumber.get(8), user_id: params.sageId, emoji: 'blocked' },
    { task_id: taskByNumber.get(13), user_id: params.mayaId, emoji: 'draft' },
  ].filter((row): row is { task_id: string; user_id: string; emoji: string } => Boolean(row.task_id));
  if (taskReactionRows.length > 0) {
    await db.insert(taskReactions).values(taskReactionRows.map((row) => ({
      org_id: params.orgId,
      task_id: row.task_id,
      user_id: row.user_id,
      emoji: row.emoji,
    }))).onConflictDoNothing();
  }

  const rawActivityRows: Array<{
    task_id: string | undefined;
    user_id: string | null;
    action: string;
    field: string;
    old_value: string | null;
    new_value: string | null;
    acting_agent_employee_id?: string | null;
    created_at: Date;
    updated_at: Date;
  }> = [
    {
      task_id: taskByNumber.get(8),
      user_id: params.diegoId,
      action: 'status_changed',
      field: 'status',
      old_value: 'todo',
      new_value: 'in_progress',
      created_at: hoursAgo(3),
      updated_at: hoursAgo(3),
    },
    {
      task_id: taskByNumber.get(5),
      user_id: params.linaId,
      action: 'status_changed',
      field: 'status',
      old_value: 'in_progress',
      new_value: 'in_review',
      created_at: hoursAgo(2.5),
      updated_at: hoursAgo(2.5),
    },
    {
      task_id: taskByNumber.get(7),
      user_id: params.diegoId,
      action: 'status_changed',
      field: 'status',
      old_value: 'in_review',
      new_value: 'done',
      created_at: hoursAgo(2),
      updated_at: hoursAgo(2),
    },
    {
      task_id: taskByNumber.get(1),
      user_id: null,
      action: 'commented',
      field: 'comment',
      old_value: null,
      new_value: 'Tom accepted the buyer-copy task and pulled the positioning page.',
      acting_agent_employee_id: null,
      created_at: hoursAgo(1.5),
      updated_at: hoursAgo(1.5),
    },
    {
      task_id: taskByNumber.get(15),
      user_id: null,
      action: 'assigned',
      field: 'assignee',
      old_value: 'Diego',
      new_value: 'Maya',
      created_at: hoursAgo(1),
      updated_at: hoursAgo(1),
    },
  ];
  const activityRows = rawActivityRows.flatMap((row) =>
    row.task_id ? [{ ...row, task_id: row.task_id }] : [],
  );

  if (activityRows.length > 0) {
    await db.insert(taskActivity).values(activityRows.map((row) => ({
      org_id: params.orgId,
      task_id: row.task_id,
      user_id: row.user_id,
      action: row.action,
      field: row.field,
      old_value: row.old_value,
      new_value: row.new_value,
      acting_agent_employee_id: row.acting_agent_employee_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })));
  }
}

async function seedProjectTaskSet(params: {
  orgId: string;
  projectId: string;
  createdBy: string;
  tasks: SeedTaskInput[];
  comments?: Array<{ number: number; userId: string; content: string }>;
  labels?: Record<number, string[]>;
  activities?: Array<{
    number: number;
    userId: string | null;
    action: string;
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    hoursAgo: number;
  }>;
  relationships?: Array<{
    source: number;
    target: number;
    type: 'blocks' | 'blocked_by' | 'relates_to' | 'duplicates';
  }>;
}) {
  for (const task of params.tasks) {
    await db
      .insert(tasks)
      .values({
        org_id: params.orgId,
        project_id: params.projectId,
        created_by: params.createdBy,
        ...task,
      })
      .onConflictDoUpdate({
        target: [tasks.project_id, tasks.number],
        set: {
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          assignee_id: task.assignee_id,
          due_date: task.due_date,
          start_date: task.start_date ?? null,
          estimation: task.estimation ?? null,
          metadata: task.metadata ?? null,
          sort_order: task.sort_order,
          is_deleted: false,
          updated_at: new Date(),
        },
      });
  }

  const taskRows = await db
    .select({ id: tasks.id, number: tasks.number })
    .from(tasks)
    .where(and(eq(tasks.org_id, params.orgId), eq(tasks.project_id, params.projectId)));
  const taskByNumber = new Map(taskRows.map((task) => [task.number, task.id]));
  const taskIds = params.tasks
    .map((task) => taskByNumber.get(task.number))
    .filter((taskId): taskId is string => Boolean(taskId));

  if (taskIds.length > 0) {
    await db.delete(taskComments).where(inArray(taskComments.task_id, taskIds));
    await db.delete(taskActivity).where(inArray(taskActivity.task_id, taskIds));
    await db.delete(taskReactions).where(inArray(taskReactions.task_id, taskIds));
    await db.delete(taskWatchers).where(inArray(taskWatchers.task_id, taskIds));
    await db.delete(taskLabels).where(inArray(taskLabels.task_id, taskIds));
    await db.delete(taskRelationships).where(or(
      inArray(taskRelationships.source_task_id, taskIds),
      inArray(taskRelationships.target_task_id, taskIds),
    ));
  }

  const comments = (params.comments ?? [])
    .map((comment) => ({
      org_id: params.orgId,
      task_id: taskByNumber.get(comment.number),
      user_id: comment.userId,
      content: comment.content,
    }))
    .filter((comment): comment is { org_id: string; task_id: string; user_id: string; content: string } =>
      Boolean(comment.task_id),
    );
  if (comments.length > 0) {
    await db.insert(taskComments).values(comments);
  }

  const labelsByName = await ensurePilotLabels(params.orgId);
  await attachLabelsToTasks({
    taskByNumber,
    labelsByName,
    assignments: params.labels ?? {},
  });

  if (taskIds.length > 0) {
    await db.insert(taskWatchers).values(taskIds.map((taskId) => ({
      task_id: taskId,
      user_id: params.createdBy,
    }))).onConflictDoNothing();
  }

  const activities = (params.activities ?? [])
    .map((activity) => {
      const taskId = taskByNumber.get(activity.number);
      if (!taskId) return null;
      const createdAt = hoursAgo(activity.hoursAgo);
      return {
        org_id: params.orgId,
        task_id: taskId,
        user_id: activity.userId,
        action: activity.action,
        field: activity.field ?? null,
        old_value: activity.oldValue ?? null,
        new_value: activity.newValue ?? null,
        created_at: createdAt,
        updated_at: createdAt,
      };
    })
    .filter((activity): activity is {
      org_id: string;
      task_id: string;
      user_id: string | null;
      action: string;
      field: string | null;
      old_value: string | null;
      new_value: string | null;
      created_at: Date;
      updated_at: Date;
    } => Boolean(activity));
  if (activities.length > 0) {
    await db.insert(taskActivity).values(activities);
  }

  const relationships = (params.relationships ?? [])
    .map((rel) => {
      const sourceId = taskByNumber.get(rel.source);
      const targetId = taskByNumber.get(rel.target);
      return sourceId && targetId
        ? { source_task_id: sourceId, target_task_id: targetId, type: rel.type }
        : null;
    })
    .filter((rel): rel is { source_task_id: string; target_task_id: string; type: 'blocks' | 'blocked_by' | 'relates_to' | 'duplicates' } =>
      Boolean(rel),
    );
  if (relationships.length > 0) {
    await db.insert(taskRelationships).values(relationships);
  }

  return taskByNumber;
}

async function seedSupplementalProjects(params: {
  orgId: string;
  createdBy: string;
  diegoId: string;
  marigoldId: string;
  cesarId: string;
  linaId: string;
  tomasId: string;
  sageId: string;
  tomId: string;
  mayaId: string;
  operationsSpaceId: string;
  buyerSpaceId: string;
  fieldOpsSpaceId: string;
}) {
  const operationsProject = await ensureProject({
    orgId: params.orgId,
    leadId: params.tomasId,
    name: 'Route + Packing Reliability',
    description:
      'Operational readiness for Sun Gold launch promises: route capacity, cold-room handoff, harvest count, and packing flow.',
    prefix: 'OPS',
    icon: 'Truck',
    color: '#059669',
    taskCounter: 8,
  });
  const buyerProject = await ensureProject({
    orgId: params.orgId,
    leadId: params.diegoId,
    name: 'Chef Sample Program',
    description:
      'Lightweight buyer pipeline for sample boxes, chef feedback, quote capture, and launch follow-up.',
    prefix: 'BUY',
    icon: 'Handshake',
    color: '#f97316',
    taskCounter: 7,
  });
  const safetyProject = await ensureProject({
    orgId: params.orgId,
    leadId: params.sageId,
    name: 'Food Safety Claims Review',
    description:
      'Make sure public copy, buyer emails, and booth material only use claims backed by current operating practice.',
    prefix: 'SAFE',
    icon: 'ShieldCheck',
    color: '#7c3aed',
    taskCounter: 6,
  });

  await db.insert(projectSpaces).values([
    { project_id: operationsProject.id, space_id: params.operationsSpaceId },
    { project_id: buyerProject.id, space_id: params.buyerSpaceId },
    { project_id: safetyProject.id, space_id: params.fieldOpsSpaceId },
  ]).onConflictDoNothing();

  await seedProjectTaskSet({
    orgId: params.orgId,
    projectId: operationsProject.id,
    createdBy: params.diegoId,
    tasks: [
      {
        number: 1,
        title: 'Confirm Tuesday delivery window before buyer copy ships',
        description:
          'Tomas checks the route board and cold-room handoff timing. If capacity is not confirmed by 12:30, buyer copy must avoid Tuesday delivery language.',
        status: 'in_progress',
        priority: 'p0',
        assignee_id: params.tomasId,
        due_date: atToday(12, 30),
        start_date: atToday(10, 45),
        estimation: '45m',
        sort_order: 1,
        metadata: { demo_surface: 'blocker_resolution', risk: 'delivery_promise' },
      },
      {
        number: 2,
        title: 'Stage sample-box crates beside cold-room door',
        description:
          'Make sure the first six sample boxes are staged with labels before Chef Amara call notes come in.',
        status: 'todo',
        priority: 'p1',
        assignee_id: params.marigoldId,
        due_date: atToday(14, 0),
        sort_order: 2,
        estimation: '35m',
        metadata: { demo_surface: 'calendar_task', physical_work: true },
      },
      {
        number: 3,
        title: 'Check cold-room sensor export for last 48 hours',
        description:
          'Pull the simple temperature log summary for Sage. No public claim needs the raw export, but review needs the confidence.',
        status: 'in_review',
        priority: 'p1',
        assignee_id: params.sageId,
        due_date: plusDays(1),
        sort_order: 3,
        estimation: '1h',
        metadata: { demo_surface: 'evidence', review_gate: 'safety' },
      },
      {
        number: 4,
        title: 'Update harvest forecast after greenhouse pass',
        description:
          'Cesar and Marigold compare Sun Gold pick estimates against sample-box demand and Saturday booth needs.',
        status: 'todo',
        priority: 'p2',
        assignee_id: params.cesarId,
        due_date: plusDays(1),
        sort_order: 4,
        estimation: '1h',
        metadata: { demo_surface: 'field_ops' },
      },
      {
        number: 5,
        title: 'Print backup labels for market sample cups',
        description:
          'If the booth copy changes after review, labels should be easy to swap without rebuilding the whole table.',
        status: 'backlog',
        priority: 'p3',
        assignee_id: params.marigoldId,
        due_date: plusDays(3),
        sort_order: 5,
        estimation: '40m',
        metadata: { demo_surface: 'backlog_depth' },
      },
      {
        number: 6,
        title: 'Photograph packing handoff for launch deck',
        description:
          'Capture the actual handoff, not stocky glamour shots. Buyer trust comes from operational specificity.',
        status: 'done',
        priority: 'p2',
        assignee_id: params.linaId,
        due_date: atOffsetDay(-1, 15, 0),
        sort_order: 6,
        estimation: '30m',
        metadata: { demo_surface: 'completed_work' },
      },
      {
        number: 7,
        title: 'Set aside one rescue crate for delayed chef pickup',
        description:
          'If the sample-box call slips, keep one crate labeled and cold so Diego can still fulfill the promise.',
        status: 'todo',
        priority: 'p2',
        assignee_id: params.tomasId,
        due_date: plusDays(1),
        sort_order: 7,
        estimation: '20m',
        metadata: { demo_surface: 'operational_buffer' },
      },
      {
        number: 8,
        title: 'Close launch-day route notes after buyer send',
        description:
          'Once the buyer update is approved, capture the route decision in wiki so the next launch has context.',
        status: 'backlog',
        priority: 'p2',
        assignee_id: params.mayaId,
        due_date: plusDays(2),
        sort_order: 8,
        estimation: '30m',
        metadata: { demo_surface: 'chat_to_wiki_followup' },
      },
    ],
    comments: [
      { number: 1, userId: params.tomasId, content: 'I can confirm after the 11:30 board check. The risk is the northern loop, not the cold-room handoff.' },
      { number: 3, userId: params.sageId, content: 'Temperature summary is enough for marketing. Keep raw logs internal unless a buyer asks for audit evidence.' },
      { number: 6, userId: params.linaId, content: 'Photos are in the launch folder. I picked the bins-and-handoff set because it feels specific and honest.' },
    ],
    labels: {
      1: ['launch-critical', 'operations-risk'],
      2: ['operations-risk'],
      3: ['needs-human-review', 'operations-risk'],
      6: ['buyer-facing', 'demo-beat'],
      8: ['demo-beat', 'agent-owned'],
    },
    activities: [
      { number: 1, userId: params.tomasId, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_progress', hoursAgo: 2.2 },
      { number: 3, userId: params.sageId, action: 'status_changed', field: 'status', oldValue: 'in_progress', newValue: 'in_review', hoursAgo: 1.8 },
      { number: 6, userId: params.linaId, action: 'status_changed', field: 'status', oldValue: 'in_review', newValue: 'done', hoursAgo: 5.5 },
    ],
    relationships: [
      { source: 1, target: 8, type: 'blocks' },
      { source: 3, target: 8, type: 'relates_to' },
    ],
  });

  await seedProjectTaskSet({
    orgId: params.orgId,
    projectId: buyerProject.id,
    createdBy: params.diegoId,
    tasks: [
      {
        number: 1,
        title: 'Confirm Chef Amara sample-box size',
        description:
          'Ask whether the restaurant wants a tasting box, a prep box, or a wholesale trial box. Capture answer in buyer-updates.',
        status: 'todo',
        priority: 'p1',
        assignee_id: params.diegoId,
        due_date: atToday(15, 0),
        start_date: atToday(14, 50),
        estimation: '20m',
        sort_order: 1,
        metadata: { demo_surface: 'manager_call', customer: 'chef_amara' },
      },
      {
        number: 2,
        title: 'Send post-call summary to launch channel',
        description:
          'Maya turns Diego call notes into a short update with buyer ask, owner, and next date.',
        status: 'todo',
        priority: 'p1',
        assignee_id: params.mayaId,
        due_date: atToday(16, 0),
        estimation: '30m',
        sort_order: 2,
        metadata: { demo_surface: 'agent_message_write', agent: 'maya' },
      },
      {
        number: 3,
        title: 'Draft one-paragraph grocer pitch',
        description:
          'Tom writes the flavor-first pitch for independent grocers, with no delivery promise until OPS-1 clears.',
        status: 'in_progress',
        priority: 'p1',
        assignee_id: params.tomId,
        due_date: plusDays(1),
        estimation: '1h',
        sort_order: 3,
        metadata: { demo_surface: 'agent_work', agent: 'tom' },
      },
      {
        number: 4,
        title: 'Collect two market-buyer objections',
        description:
          'Capture objections in plain language: price, consistency, shelf life, or pickup window.',
        status: 'todo',
        priority: 'p2',
        assignee_id: params.marigoldId,
        due_date: plusDays(2),
        estimation: '45m',
        sort_order: 4,
        metadata: { demo_surface: 'customer_feedback' },
      },
      {
        number: 5,
        title: 'Turn Field Co-op notes into buyer FAQ item',
        description:
          'Use the Field Co-op concern about Tuesday timing as a FAQ entry and link it back to route policy.',
        status: 'in_review',
        priority: 'p2',
        assignee_id: params.mayaId,
        due_date: plusDays(2),
        estimation: '45m',
        sort_order: 5,
        metadata: { demo_surface: 'wiki_to_task' },
      },
      {
        number: 6,
        title: 'Archive stale buyer list row for Spring Mix',
        description:
          'Remove old Spring Mix buyer assumptions from the current Sun Gold list.',
        status: 'done',
        priority: 'p3',
        assignee_id: params.diegoId,
        due_date: atOffsetDay(-2, 17, 0),
        estimation: '20m',
        sort_order: 6,
        metadata: { demo_surface: 'cleanup' },
      },
      {
        number: 7,
        title: 'Prepare Saturday booth buyer handout',
        description:
          'One half-page: flavor notes, harvest timing, route-dependent delivery language, and sample-box contact.',
        status: 'backlog',
        priority: 'p2',
        assignee_id: params.tomId,
        due_date: plusDays(3),
        estimation: '90m',
        sort_order: 7,
        metadata: { demo_surface: 'backlog_depth' },
      },
    ],
    comments: [
      { number: 1, userId: params.diegoId, content: 'Ask for how they will use the tomatoes first. Box size should follow the kitchen use, not the other way around.' },
      { number: 2, userId: params.mayaId, content: 'I will post the summary after Diego closes the call and tag Lina if buyer language changes.' },
      { number: 3, userId: params.tomId, content: 'Drafting from the positioning page and holding all route language behind the OPS-1 gate.' },
    ],
    labels: {
      1: ['buyer-facing', 'demo-beat'],
      2: ['agent-owned', 'buyer-facing'],
      3: ['agent-owned', 'buyer-facing'],
      5: ['needs-human-review'],
      7: ['buyer-facing'],
    },
    activities: [
      { number: 3, userId: null, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_progress', hoursAgo: 1.4 },
      { number: 5, userId: params.mayaId, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_review', hoursAgo: 2.8 },
      { number: 6, userId: params.diegoId, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'done', hoursAgo: 18 },
    ],
    relationships: [
      { source: 1, target: 2, type: 'blocks' },
      { source: 3, target: 7, type: 'relates_to' },
    ],
  });

  await seedProjectTaskSet({
    orgId: params.orgId,
    projectId: safetyProject.id,
    createdBy: params.diegoId,
    tasks: [
      {
        number: 1,
        title: 'Approve cold-chain sentence for grocer pitch',
        description:
          'Review the exact sentence Tom wants to use. Approve only if it says what we do today, not what we hope to do later.',
        status: 'todo',
        priority: 'p1',
        assignee_id: params.sageId,
        due_date: plusDays(1),
        estimation: '30m',
        sort_order: 1,
        metadata: { demo_surface: 'approval_gate' },
      },
      {
        number: 2,
        title: 'Create food-safety caveat for market handout',
        description:
          'One sentence explaining how samples are handled and when buyers should refrigerate them.',
        status: 'in_progress',
        priority: 'p2',
        assignee_id: params.sageId,
        due_date: plusDays(2),
        estimation: '45m',
        sort_order: 2,
        metadata: { demo_surface: 'copy_review' },
      },
      {
        number: 3,
        title: 'Check launch copy for audit-status overclaim',
        description:
          'Make sure we never imply an external audit that has not happened yet.',
        status: 'done',
        priority: 'p1',
        assignee_id: params.linaId,
        due_date: atOffsetDay(-1, 14, 0),
        estimation: '25m',
        sort_order: 3,
        metadata: { demo_surface: 'completed_review' },
      },
      {
        number: 4,
        title: 'Link cold-room SOP to launch decision page',
        description:
          'The wiki graph should show why the Tuesday route decision depends on the cold-room handoff SOP.',
        status: 'todo',
        priority: 'p2',
        assignee_id: params.mayaId,
        due_date: plusDays(2),
        estimation: '25m',
        sort_order: 4,
        metadata: { demo_surface: 'wiki_graph' },
      },
      {
        number: 5,
        title: 'Write internal note for what agents may promise',
        description:
          'Clarify that agents can draft and summarize, but customer-facing operational promises need human review.',
        status: 'in_review',
        priority: 'p1',
        assignee_id: params.diegoId,
        due_date: plusDays(1),
        estimation: '40m',
        sort_order: 5,
        metadata: { demo_surface: 'agent_governance' },
      },
      {
        number: 6,
        title: 'Prepare next-week packaging checklist',
        description:
          'Keep this as a backlog item so the board shows real continuity after the video story ends.',
        status: 'backlog',
        priority: 'p3',
        assignee_id: params.marigoldId,
        due_date: plusDays(6),
        estimation: '1h',
        sort_order: 6,
        metadata: { demo_surface: 'future_work' },
      },
    ],
    comments: [
      { number: 1, userId: params.sageId, content: 'I need the exact sentence, not the vibe. Claims are where demos become lawsuits.' },
      { number: 4, userId: params.mayaId, content: 'I will link SOP -> route decision -> buyer FAQ so the wiki graph has a clean story.' },
      { number: 5, userId: params.diegoId, content: 'This note is important for the video: agents can work, but accountable humans approve promises.' },
    ],
    labels: {
      1: ['needs-human-review', 'buyer-facing'],
      3: ['needs-human-review', 'demo-beat'],
      4: ['demo-beat', 'agent-owned'],
      5: ['launch-critical', 'needs-human-review'],
    },
    activities: [
      { number: 2, userId: params.sageId, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_progress', hoursAgo: 3.5 },
      { number: 3, userId: params.linaId, action: 'status_changed', field: 'status', oldValue: 'in_review', newValue: 'done', hoursAgo: 20 },
      { number: 5, userId: params.diegoId, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_review', hoursAgo: 1.1 },
    ],
    relationships: [
      { source: 1, target: 5, type: 'relates_to' },
      { source: 4, target: 5, type: 'blocks' },
    ],
  });
}

async function seedWiki(params: {
  orgId: string;
  spaceId: string;
  diegoId: string;
  linaId: string;
  sageId: string;
  tomasId: string;
  tomId: string;
  mayaId: string;
}) {
  const pages = [
    {
      type: 'procedure' as const,
      title: 'Company Memory Proof Protocol',
      slug: 'company-memory-proof-protocol',
      summary:
        'A clean local proof path for verifying chat-to-wiki and BYOA memory retrieval in the Testers Tomatoes pilot.',
      content: [
        '# Company Memory Proof Protocol',
        '',
        `The current clean pilot proof phrase is **${PROOF_PHRASE}**.`,
        '',
        'When a teammate mentions this phrase in chat, Deft should classify the decision/entity/resource context, promote it into knowledge, and make it retrievable from wiki search and MCP memory tools.',
        '',
        'Expected proof: a human can create a new chat decision, the Knowledge panel shows it, the Wiki receives or links the captured memory, and BYOA employees can retrieve it with `memory_recall` or `wiki_search`.',
      ].join('\n'),
      tags: ['pilot', 'memory', 'proof'],
      referenced_user_ids: [params.diegoId, params.tomId, params.mayaId],
    },
    {
      type: 'decision' as const,
      title: 'BYOA Employee Operating Model',
      slug: 'byoa-employee-operating-model',
      summary:
        'Tom and Maya are treated as already-running external employees that connect to Deft over MCP.',
      content: [
        '# BYOA Employee Operating Model',
        '',
        'Tom is the OpenClaw marketing employee for Testers Tomatoes. Maya is the Hermes communications employee.',
        '',
        'Deft should not rewrite their identity or assume ownership of their runtime. Deft gives them workplace context, task assignments, wiki access, and audited MCP tools.',
        '',
        'Pilot acceptance means each BYOA employee can see assigned tasks, use company memory, post useful work updates, and mark work complete according to trust and approval rules.',
      ].join('\n'),
      tags: ['agents', 'byoa', 'pilot'],
      referenced_user_ids: [params.tomId, params.mayaId],
    },
    {
      type: 'resource' as const,
      title: 'Testers Tomatoes Marketing Positioning',
      slug: 'testers-tomatoes-marketing-positioning',
      summary:
        'Position Testers Tomatoes as a flavor-first, reliability-minded tomato supplier for local buyers.',
      content: [
        '# Testers Tomatoes Marketing Positioning',
        '',
        'Core promise: consistently flavorful tomatoes with transparent harvest timing and practical cold-chain reliability.',
        '',
        'Audience: farmers market shoppers, independent grocers, chefs, and wholesale buyers who care about flavor but cannot tolerate missed delivery windows.',
        '',
        'Tone: vivid, plain-spoken, operationally credible. Avoid inflated sustainability claims unless backed by a specific growing or logistics practice.',
      ].join('\n'),
      tags: ['marketing', 'positioning', 'buyers'],
      referenced_user_ids: [params.tomId, params.mayaId],
    },
    {
      type: 'decision' as const,
      title: 'Sun Gold Trial Launch Decision',
      slug: 'sun-gold-trial-launch-decision',
      summary:
        'Diego approved a buyer-facing Sun Gold trial launch with route-confirmed Tuesday delivery and reviewed cold-chain wording.',
      content: [
        '# Sun Gold Trial Launch Decision',
        '',
        `Decision marker: **${PROOF_PHRASE}**.`,
        '',
        'For the Sun Gold trial, Testers Tomatoes will promise Tuesday delivery windows only when Tomas confirms route capacity.',
        '',
        'Tom owns buyer-facing launch copy. Maya owns the weekly communications summary. Lina reviews buyer-facing cold-chain wording. Sage validates food-safety language before the launch package is sent.',
        '',
        'This page exists so the manual demo can show a decision moving from chat into wiki memory, then into tasks assigned to humans and BYOA employees.',
      ].join('\n'),
      tags: ['decision', 'sun-gold', 'launch', 'demo'],
      referenced_user_ids: [params.diegoId, params.tomId, params.mayaId],
    },
    {
      type: 'procedure' as const,
      title: 'Buyer Launch Review Loop',
      slug: 'buyer-launch-review-loop',
      summary:
        'The repeatable review path for agent-drafted buyer copy before it leaves Testers Tomatoes.',
      content: [
        '# Buyer Launch Review Loop',
        '',
        '1. Tom drafts buyer-facing copy from wiki positioning and current project tasks.',
        '2. Maya summarizes stakeholder context for Diego and Lina.',
        '3. Lina reviews claims for buyer practicality and sales accuracy.',
        '4. Sage reviews food-safety and cold-chain language.',
        '5. Diego approves the launch package after human review is complete.',
        '',
        'Agents can draft and summarize, but claims that affect customers stay on human review rails.',
      ].join('\n'),
      tags: ['procedure', 'review', 'agents', 'buyers'],
      referenced_user_ids: [params.diegoId, params.tomId, params.mayaId],
    },
    {
      type: 'entity' as const,
      title: 'Chef Amara Account Brief',
      slug: 'chef-amara-account-brief',
      summary:
        'Chef Amara is the first Sun Gold sample-box buyer and cares most about timing clarity and prep-use context.',
      content: [
        '# Chef Amara Account Brief',
        '',
        'Chef Amara runs a small seasonal kitchen that buys tomatoes when flavor is high and delivery is boringly reliable.',
        '',
        'Known preferences:',
        '- Wants prep-use notes more than farm poetry.',
        '- Will trial a small box before discussing wholesale volume.',
        '- Needs a delivery window that does not shift after the morning prep list is set.',
        '',
        'Demo use: this page gives Defty, Codex, Tom, and Maya concrete buyer context without pasting it into chat.',
      ].join('\n'),
      tags: ['buyer', 'chef-amara', 'sample-box'],
      referenced_user_ids: [params.diegoId, params.mayaId],
    },
    {
      type: 'procedure' as const,
      title: 'Cold-room Handoff SOP',
      slug: 'cold-room-handoff-sop',
      summary:
        'How Sun Gold sample boxes move from harvest bins to cold-room staging before route handoff.',
      content: [
        '# Cold-room Handoff SOP',
        '',
        '1. Harvest bins are weighed before staging.',
        '2. Sample boxes are labeled before they enter the cold room.',
        '3. Tomas confirms route timing before buyer-facing delivery language is approved.',
        '4. Sage reviews any claim that mentions cold-chain reliability.',
        '',
        'The SOP supports practical buyer claims. It does not support broad audit-status claims.',
      ].join('\n'),
      tags: ['operations', 'cold-chain', 'sop'],
      referenced_user_ids: [params.tomasId, params.sageId],
    },
    {
      type: 'decision' as const,
      title: 'Tuesday Route Promise Gate',
      slug: 'tuesday-route-promise-gate',
      summary:
        'No buyer-facing Tuesday delivery promise should ship until Tomas confirms route capacity.',
      content: [
        '# Tuesday Route Promise Gate',
        '',
        'Decision: Tuesday delivery language is gated behind Tomas confirming route capacity in OPS-1.',
        '',
        'Why: buyers can tolerate a smaller sample box, but they cannot build a prep plan around a vague delivery promise.',
        '',
        'Operational owner: Tomas. Customer owner: Diego. Copy owner: Tom. Summary owner: Maya. Review owners: Lina and Sage.',
      ].join('\n'),
      tags: ['decision', 'route', 'buyer-facing', 'launch'],
      referenced_user_ids: [params.diegoId, params.tomasId, params.tomId, params.mayaId],
    },
    {
      type: 'resource' as const,
      title: 'Sun Gold Buyer Personas',
      slug: 'sun-gold-buyer-personas',
      summary:
        'Three practical buyer profiles for the Sun Gold launch: chef, grocer, and farmers market regular.',
      content: [
        '# Sun Gold Buyer Personas',
        '',
        'Chef buyer: cares about prep timing, flavor consistency, and whether the sample can become a weekly order.',
        '',
        'Independent grocer: cares about delivery reliability, sell-through story, and whether the shelf label is simple.',
        '',
        'Farmers market regular: cares about taste, ripeness, and whether the farm sounds like humans grew the tomatoes.',
        '',
        'Tom should draft separate copy beats for each persona. Maya should summarize which persona each task serves.',
      ].join('\n'),
      tags: ['marketing', 'personas', 'buyers'],
      referenced_user_ids: [params.tomId, params.mayaId],
    },
    {
      type: 'procedure' as const,
      title: 'Agent Approval Rails For Launch Work',
      slug: 'agent-approval-rails-for-launch-work',
      summary:
        'Agents can draft, summarize, and update internal work; customer-facing operational promises stay on approval rails.',
      content: [
        '# Agent Approval Rails For Launch Work',
        '',
        'Auto-safe agent work: read workspace context, summarize threads, draft internal notes, and update low-risk task status.',
        '',
        'Approval-required work: buyer-facing messages, delivery promises, food-safety claims, and decisions that change launch scope.',
        '',
        'Demo beat: show the agent proposing work, Diego approving, then task/chat/wiki receipts landing in the shared work record.',
      ].join('\n'),
      tags: ['agents', 'approvals', 'governance', 'demo'],
      referenced_user_ids: [params.diegoId, params.tomId, params.mayaId, params.sageId],
    },
    {
      type: 'resource' as const,
      title: 'Demo Video Recording Map',
      slug: 'demo-video-recording-map',
      summary:
        'The surfaces to show in order: dashboard, chat, notes, approvals, tasks, wiki graph, calendar, and MCP access.',
      content: [
        '# Demo Video Recording Map',
        '',
        '1. Dashboard: show active projects, unread spaces, calendar, and pending agent approval.',
        '2. Chat: show the blocker in marketing and the replies from operations/safety.',
        '3. Notes: show Diego turning the discussion into manager notes.',
        '4. Approvals: show Tom or Maya proposing a write and Diego reviewing it.',
        '5. Tasks: show task detail, comments, labels, activity, and related blockers.',
        '6. Wiki: show the route decision, SOP, buyer persona, and graph links.',
        '7. Calendar: show today as an operating day, not an empty date grid.',
        '8. MCP Access: show how Codex/Claude-style clients connect as accountable users.',
      ].join('\n'),
      tags: ['demo', 'recording', 'walkthrough'],
      referenced_user_ids: [params.diegoId],
    },
  ];

  for (const page of pages) {
    await db
      .insert(wikiPages)
      .values({
        org_id: params.orgId,
        scope: 'org',
        space_id: params.spaceId,
        type: page.type,
        title: page.title,
        slug: page.slug,
        summary: page.summary,
        content: page.content,
        confidence: 0.98,
        version: 1,
        is_deleted: false,
        tags: page.tags,
        referenced_user_ids: page.referenced_user_ids,
      })
      .onConflictDoUpdate({
        target: [wikiPages.org_id, wikiPages.slug],
        set: {
          scope: 'org',
          space_id: params.spaceId,
          type: page.type,
          title: page.title,
          summary: page.summary,
          content: page.content,
          confidence: 0.98,
          is_deleted: false,
          tags: page.tags,
          referenced_user_ids: page.referenced_user_ids,
          updated_at: new Date(),
        },
      });
  }

  const seededPages = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug })
    .from(wikiPages)
    .where(and(eq(wikiPages.org_id, params.orgId), inArray(wikiPages.slug, pages.map((page) => page.slug))));
  const pageBySlug = new Map(seededPages.map((page) => [page.slug, page.id]));
  const links: Array<[string, string, string]> = [
    ['sun-gold-trial-launch-decision', 'testers-tomatoes-marketing-positioning', 'Decision relies on positioning guidance.'],
    ['sun-gold-trial-launch-decision', 'byoa-employee-operating-model', 'Decision assigns work to BYOA employees.'],
    ['sun-gold-trial-launch-decision', 'buyer-launch-review-loop', 'Decision follows the human review loop.'],
    ['sun-gold-trial-launch-decision', 'tuesday-route-promise-gate', 'Launch decision depends on route confirmation.'],
    ['tuesday-route-promise-gate', 'cold-room-handoff-sop', 'Route promise uses the cold-room handoff practice as evidence.'],
    ['testers-tomatoes-marketing-positioning', 'sun-gold-buyer-personas', 'Positioning should vary by buyer persona.'],
    ['chef-amara-account-brief', 'sun-gold-buyer-personas', 'Chef Amara is the first chef-buyer proof case.'],
    ['buyer-launch-review-loop', 'agent-approval-rails-for-launch-work', 'Review loop defines which agent writes need approval.'],
    ['demo-video-recording-map', 'agent-approval-rails-for-launch-work', 'The demo should show approval rails in action.'],
    ['demo-video-recording-map', 'sun-gold-trial-launch-decision', 'The launch decision is the central demo wiki node.'],
    ['buyer-launch-review-loop', 'company-memory-proof-protocol', 'Review loop is part of the clean memory proof.'],
    ['byoa-employee-operating-model', 'company-memory-proof-protocol', 'BYOA employees must retrieve the same memory humans can see.'],
  ];
  for (const [sourceSlug, targetSlug, context] of links) {
    const sourceId = pageBySlug.get(sourceSlug);
    const targetId = pageBySlug.get(targetSlug);
    if (!sourceId || !targetId) continue;
    await db
      .insert(wikiLinks)
      .values({
        org_id: params.orgId,
        source_page_id: sourceId,
        target_page_id: targetId,
        context,
      })
      .onConflictDoNothing();
  }

  const pageIds = [...pageBySlug.values()];
  if (pageIds.length > 0) {
    await db.delete(wikiCitations).where(inArray(wikiCitations.page_id, pageIds));
    await db.insert(wikiCitations).values([
      {
        page_id: pageBySlug.get('sun-gold-trial-launch-decision')!,
        source_type: 'message',
        source_id: 'pilot-marketing-decision-thread',
        excerpt: `Decision marker ${PROOF_PHRASE}: launch copy waits for route confirmation.`,
      },
      {
        page_id: pageBySlug.get('tuesday-route-promise-gate')!,
        source_type: 'task',
        source_id: 'OPS-1',
        excerpt: 'OPS-1 is the explicit route-capacity gate before buyer-facing Tuesday language ships.',
      },
      {
        page_id: pageBySlug.get('agent-approval-rails-for-launch-work')!,
        source_type: 'agent_action',
        source_id: 'pilot-approval-rail',
        excerpt: 'Customer-facing operational promises require human approval even when an agent drafts them.',
      },
    ].filter((citation) => Boolean(citation.page_id)));
  }

  await db
    .delete(wikiOpsLog)
    .where(and(eq(wikiOpsLog.org_id, params.orgId), sql`${wikiOpsLog.details}->>'seed' = 'pilot-living'`));
  await db.insert(wikiOpsLog).values([
    {
      org_id: params.orgId,
      operation: 'seed_refresh',
      page_id: pageBySlug.get('demo-video-recording-map') ?? null,
      performed_by: params.diegoId,
      details: {
        seed: 'pilot-living',
        summary: 'Refreshed demo wiki graph for dashboard -> chat -> approvals -> tasks -> knowledge walkthrough.',
      },
    },
    {
      org_id: params.orgId,
      operation: 'decision_captured',
      page_id: pageBySlug.get('tuesday-route-promise-gate') ?? null,
      performed_by: params.diegoId,
      details: {
        seed: 'pilot-living',
        proof_phrase: PROOF_PHRASE,
        source: 'marketing blocker thread',
      },
    },
  ]);
}

async function seedMarketingMessage(params: { orgId: string; spaceId: string; diegoId: string }) {
  const content =
    `Decision: for the clean pilot, Tom owns buyer-facing marketing copy and Maya owns weekly communications summaries. ` +
    `Use ${PROOF_PHRASE} as the fresh chat-to-wiki proof marker for this local environment.`;

  const existing = await db
    .select({
      id: messages.id,
      space_id: messages.space_id,
      user_id: messages.user_id,
      created_at: messages.created_at,
    })
    .from(messages)
    .where(and(eq(messages.org_id, params.orgId), eq(messages.space_id, params.spaceId), eq(messages.content, content)))
    .limit(1);

  if (existing.length > 0) {
    return expectOne(existing, 'existing pilot knowledge proof message');
  }

  return expectOne(await db.insert(messages).values({
    org_id: params.orgId,
    space_id: params.spaceId,
    user_id: params.diegoId,
    content,
    metadata: { seed: 'pilot-polish', knowledge_marker: PROOF_PHRASE },
  }).returning({
    id: messages.id,
    space_id: messages.space_id,
    user_id: messages.user_id,
    created_at: messages.created_at,
  }), 'seeded pilot knowledge proof message');
}

async function seedLivedInConversations(params: {
  orgId: string;
  marketingSpaceId: string;
  operationsSpaceId: string;
  buyerSpaceId: string;
  fieldOpsSpaceId: string;
  diegoId: string;
  marigoldId: string;
  cesarId: string;
  linaId: string;
  tomasId: string;
  sageId: string;
  tomId: string;
  mayaId: string;
}) {
  const oldSeedMessages = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.org_id, params.orgId), sql`${messages.metadata}->>'seed' = 'pilot-living'`));
  const oldMessageIds = oldSeedMessages.map((message) => message.id);
  if (oldMessageIds.length > 0) {
    await db.delete(reactions).where(inArray(reactions.message_id, oldMessageIds));
    await db.delete(messageClassifications).where(inArray(messageClassifications.message_id, oldMessageIds));
    await db.delete(threadReads).where(inArray(threadReads.parent_message_id, oldMessageIds));
    await db.update(tasks).set({ source_message_id: null }).where(inArray(tasks.source_message_id, oldMessageIds));
    await db.delete(crossReferences).where(or(
      and(eq(crossReferences.source_type, 'message'), inArray(crossReferences.source_id, oldMessageIds)),
      and(eq(crossReferences.target_type, 'message'), inArray(crossReferences.target_id, oldMessageIds)),
    ));
    await db.delete(messages).where(inArray(messages.id, oldMessageIds));
  }

  async function addMessage(input: {
    spaceId: string;
    userId: string;
    content: string;
    hoursAgo: number;
    parentId?: string;
    pinned?: boolean;
    metadata?: Record<string, unknown>;
  }) {
    const createdAt = hoursAgo(input.hoursAgo);
    return expectOne(await db.insert(messages).values({
      org_id: params.orgId,
      space_id: input.spaceId,
      user_id: input.userId,
      content: input.content,
      parent_id: input.parentId ?? null,
      is_pinned: input.pinned ?? false,
      metadata: {
        seed: 'pilot-living',
        ...input.metadata,
      },
      created_at: createdAt,
      updated_at: createdAt,
    }).returning(), 'seeded lived-in message');
  }

  const marketingDecision = await addMessage({
    spaceId: params.marketingSpaceId,
    userId: params.diegoId,
    hoursAgo: 5.5,
    pinned: true,
    metadata: { demo_scene: 'opening_chat' },
    content:
      `Decision: Sun Gold launch copy can move forward, but delivery language stays gated by route confirmation. Proof marker ${PROOF_PHRASE}.`,
  });
  const blockerMessage = await addMessage({
    spaceId: params.marketingSpaceId,
    userId: params.linaId,
    hoursAgo: 4.8,
    pinned: true,
    metadata: { demo_scene: 'blocker', blocker: true },
    content:
      'Blocked: I do not want Tom or Maya promising Tuesday delivery in buyer copy until Tomas confirms route capacity. Flavor copy is fine; delivery promise is not.',
  });
  await addMessage({
    spaceId: params.marketingSpaceId,
    userId: params.tomId,
    parentId: blockerMessage.id,
    hoursAgo: 4.6,
    metadata: { demo_scene: 'agent_reply' },
    content:
      'I can keep the draft focused on flavor, sample size, and handling notes. I will leave Tuesday delivery out until OPS-1 clears.',
  });
  await addMessage({
    spaceId: params.marketingSpaceId,
    userId: params.mayaId,
    parentId: blockerMessage.id,
    hoursAgo: 4.5,
    metadata: { demo_scene: 'agent_reply' },
    content:
      'I will summarize this as launch blocker: buyer-facing delivery language is waiting on Tomas, while copy and sample prep can continue.',
  });
  await addMessage({
    spaceId: params.marketingSpaceId,
    userId: params.sageId,
    parentId: blockerMessage.id,
    hoursAgo: 4.25,
    metadata: { demo_scene: 'safety_reply' },
    content:
      'Also flagging that cold-chain wording needs the SOP language, not a broad guarantee. I can review the exact sentence once Tom drafts it.',
  });

  const opsUpdate = await addMessage({
    spaceId: params.operationsSpaceId,
    userId: params.tomasId,
    hoursAgo: 3.7,
    pinned: true,
    metadata: { demo_scene: 'ops_update' },
    content:
      'Route board update: northern loop is the constraint. I can probably hold Tuesday, but I need the 11:30 check before Diego promises it.',
  });
  await addMessage({
    spaceId: params.operationsSpaceId,
    userId: params.marigoldId,
    parentId: opsUpdate.id,
    hoursAgo: 3.4,
    content:
      'Sample boxes are easy; the only awkward part is label timing if copy changes after the cold-room handoff.',
  });
  await addMessage({
    spaceId: params.operationsSpaceId,
    userId: params.cesarId,
    hoursAgo: 2.9,
    content:
      'Greenhouse pass says Sun Gold volume is enough for Chef Amara plus Saturday market, but not enough for a broad wholesale send yet.',
  });

  const buyerUpdate = await addMessage({
    spaceId: params.buyerSpaceId,
    userId: params.mayaId,
    hoursAgo: 2.2,
    metadata: { demo_scene: 'buyer_summary' },
    content:
      'Buyer pulse draft: Chef Amara wants practical prep notes, Field Co-op asked about reliable Tuesday delivery, and the grocer pitch should avoid route language for now.',
  });
  await addMessage({
    spaceId: params.buyerSpaceId,
    userId: params.diegoId,
    parentId: buyerUpdate.id,
    hoursAgo: 2,
    content:
      'Good. After the call, turn this into one update for marketing and one follow-up task if Amara wants a larger box.',
  });

  const fieldUpdate = await addMessage({
    spaceId: params.fieldOpsSpaceId,
    userId: params.marigoldId,
    hoursAgo: 1.7,
    metadata: { demo_scene: 'field_ops' },
    content:
      'Field note: the Sun Gold trays look camera-ready, but the honest shot is the harvest bin next to the cold-room door.',
  });
  await addMessage({
    spaceId: params.fieldOpsSpaceId,
    userId: params.linaId,
    parentId: fieldUpdate.id,
    hoursAgo: 1.5,
    content:
      'Use that. It is more credible than a glossy tomato glamour shot, and Tom can write around the actual handoff.',
  });

  await db.insert(reactions).values([
    { message_id: marketingDecision.id, user_id: params.tomId, emoji: 'drafting' },
    { message_id: marketingDecision.id, user_id: params.mayaId, emoji: 'noted' },
    { message_id: blockerMessage.id, user_id: params.diegoId, emoji: 'blocked' },
    { message_id: opsUpdate.id, user_id: params.linaId, emoji: 'watching' },
    { message_id: buyerUpdate.id, user_id: params.diegoId, emoji: 'useful' },
    { message_id: fieldUpdate.id, user_id: params.tomId, emoji: 'use-this' },
  ]).onConflictDoNothing();

  await db.insert(messageClassifications).values([
    {
      org_id: params.orgId,
      message_id: marketingDecision.id,
      intent: 'discussion',
      confidence: 0.96,
      agent_mentioned: false,
      blocked: false,
      task_references: ['MKT-1', 'MKT-2', 'OPS-1'],
      entities: {
        project: 'Sun Gold launch',
        decision_marker: PROOF_PHRASE,
        agents: ['Tom', 'Maya'],
      },
      memorable_facts: [
        'Sun Gold launch copy can move forward while delivery language remains gated by route confirmation.',
      ],
      decision: 'Delivery language stays gated by route confirmation.',
    },
    {
      org_id: params.orgId,
      message_id: blockerMessage.id,
      intent: 'task_create',
      confidence: 0.98,
      agent_mentioned: true,
      blocked: true,
      task_references: ['OPS-1', 'MKT-8'],
      entities: {
        assignee: 'Tomas',
        project: 'Route + Packing Reliability',
        due_date: 'today 12:30',
        agents: ['Tom', 'Maya'],
      },
      memorable_facts: [
        'Buyer-facing Tuesday delivery language is blocked until route capacity is confirmed.',
      ],
      decision: null,
    },
  ]);

  const [mktProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.org_id, params.orgId), eq(projects.prefix, 'MKT')))
    .limit(1);
  const [opsProject] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.org_id, params.orgId), eq(projects.prefix, 'OPS')))
    .limit(1);
  const relatedTasks = await db
    .select({ id: tasks.id, number: tasks.number, project_id: tasks.project_id })
    .from(tasks)
    .where(and(
      eq(tasks.org_id, params.orgId),
      inArray(tasks.project_id, [mktProject?.id, opsProject?.id].filter((id): id is string => Boolean(id))),
      inArray(tasks.number, [1, 8]),
    ));
  const mktBlockerTask = relatedTasks.find((task) => task.project_id === mktProject?.id && task.number === 8);
  const opsRouteTask = relatedTasks.find((task) => task.project_id === opsProject?.id && task.number === 1);

  if (mktBlockerTask) {
    await db.update(tasks).set({ source_message_id: blockerMessage.id }).where(eq(tasks.id, mktBlockerTask.id));
  }

  const crossRefRows = [
    mktBlockerTask
      ? {
          org_id: params.orgId,
          source_type: 'message',
          source_id: blockerMessage.id,
          target_type: 'task',
          target_id: mktBlockerTask.id,
          context: 'Marketing blocker is tracked by the launch route-capacity task.',
          created_by: params.diegoId,
        }
      : null,
    opsRouteTask
      ? {
          org_id: params.orgId,
          source_type: 'message',
          source_id: opsUpdate.id,
          target_type: 'task',
          target_id: opsRouteTask.id,
          context: 'Operations route update is the source of the route-confirmation work.',
          created_by: params.diegoId,
        }
      : null,
  ].filter((row): row is {
    org_id: string;
    source_type: string;
    source_id: string;
    target_type: string;
    target_id: string;
    context: string;
    created_by: string;
  } => Boolean(row));

  if (crossRefRows.length > 0) {
    await db.insert(crossReferences).values(crossRefRows).onConflictDoNothing();
  }

  await db
    .update(spaceMembers)
    .set({ last_read_at: hoursAgo(6), last_read_message_id: null })
    .where(and(
      inArray(spaceMembers.space_id, [
        params.marketingSpaceId,
        params.operationsSpaceId,
        params.buyerSpaceId,
        params.fieldOpsSpaceId,
      ]),
      inArray(spaceMembers.user_id, [params.diegoId, params.tomId, params.mayaId]),
    ));

  return {
    marketingDecision,
    blockerMessage,
    opsUpdate,
    buyerUpdate,
    fieldUpdate,
  };
}

async function seedPilotKnowledgeReceipts(params: {
  orgId: string;
  convertedBy: string;
  pilotProof: {
    id: string;
    space_id: string;
    user_id: string;
    created_at: Date;
  };
  livedIn: Awaited<ReturnType<typeof seedLivedInConversations>>;
}) {
  const receiptSpecs = [
    {
      message: params.pilotProof,
      kind: 'decision_candidate' as const,
      title: 'Company Memory Proof Protocol',
      slug: 'company-memory-proof-protocol',
      action: 'wiki_create',
      summary: 'The clean pilot assigns clear agent ownership and defines the shared-memory proof marker.',
    },
    {
      message: params.livedIn.marketingDecision,
      kind: 'decision_candidate' as const,
      title: 'Sun Gold Trial Launch Decision',
      slug: 'sun-gold-trial-launch-decision',
      action: 'wiki_create',
      summary: 'Launch copy can proceed while delivery language remains gated by route confirmation.',
    },
    {
      message: params.livedIn.blockerMessage,
      kind: 'decision_candidate' as const,
      title: 'Tuesday Route Promise Gate',
      slug: 'tuesday-route-promise-gate',
      action: 'wiki_create',
      summary: 'Buyer-facing Tuesday delivery language remains blocked until route capacity is confirmed.',
    },
    {
      message: params.livedIn.opsUpdate,
      kind: 'resource_candidate' as const,
      title: 'Update knowledge: Tuesday Route Promise Gate',
      slug: 'tuesday-route-promise-gate',
      action: 'wiki_update',
      summary: 'The northern route remains the constraint and requires the 11:30 operating check.',
    },
    {
      message: params.livedIn.buyerUpdate,
      kind: 'resource_candidate' as const,
      title: 'Update knowledge: Chef Amara Account Brief',
      slug: 'chef-amara-account-brief',
      action: 'wiki_update',
      summary: 'Chef Amara values practical prep notes while route promises remain conditional.',
    },
    {
      message: params.livedIn.fieldUpdate,
      kind: 'resource_candidate' as const,
      title: 'Update knowledge: Cold-room Handoff SOP',
      slug: 'cold-room-handoff-sop',
      action: 'wiki_update',
      summary: 'The credible launch image is the harvest bin beside the cold-room handoff.',
    },
  ];

  const seededPages = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, type: wikiPages.type })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, params.orgId),
      inArray(wikiPages.slug, [...new Set(receiptSpecs.map((receipt) => receipt.slug))]),
    ));
  const pageBySlug = new Map(seededPages.map((page) => [page.slug, page]));

  const rows = receiptSpecs.flatMap((receipt) => {
    const page = pageBySlug.get(receipt.slug);
    if (!page) return [];
    const isUpdate = receipt.action === 'wiki_update';
    return [{
      org_id: params.orgId,
      space_id: receipt.message.space_id,
      source_message_id: receipt.message.id,
      source_user_id: receipt.message.user_id,
      kind: receipt.kind,
      status: 'converted' as const,
      title: receipt.title,
      summary: receipt.summary,
      proposed_action: receipt.action,
      proposed_params: {
        source_message_id: receipt.message.id,
        source_space_id: receipt.message.space_id,
        source_user_id: receipt.message.user_id,
        target_wiki_page_id: page.id,
        target_wiki_slug: page.slug,
        target_wiki_title: page.title,
      },
      dedupe_key: `pilot_seed:knowledge_receipt:${receipt.message.id}:${page.slug}`,
      converted_by: params.convertedBy,
      converted_at: receipt.message.created_at,
      metadata: {
        seed: 'pilot-living',
        extraction: 'seeded_episode',
        batch_capture: true,
        episode_capture: true,
        batch_message_ids: [receipt.message.id],
        converted_wiki_slug: page.slug,
        converted_wiki_page_id: page.id,
        converted_wiki_title: page.title,
        converted_wiki_type: page.type,
        ...(isUpdate ? { update_kind: 'wiki_content' } : {}),
      },
      created_at: receipt.message.created_at,
      updated_at: receipt.message.created_at,
    }];
  });

  if (rows.length !== receiptSpecs.length) {
    const missing = receiptSpecs
      .filter((receipt) => !pageBySlug.has(receipt.slug))
      .map((receipt) => receipt.slug);
    throw new Error(`Missing seeded wiki pages for knowledge receipts: ${missing.join(', ')}`);
  }

  await db.insert(workIntents).values(rows).onConflictDoNothing({
    target: [workIntents.org_id, workIntents.dedupe_key],
  });

  await db.delete(wikiCitations).where(and(
    eq(wikiCitations.source_type, 'message'),
    eq(wikiCitations.source_id, 'pilot-marketing-decision-thread'),
    inArray(wikiCitations.page_id, [...pageBySlug.values()].map((page) => page.id)),
  ));
  await db.insert(wikiCitations).values(receiptSpecs.flatMap((receipt) => {
    const page = pageBySlug.get(receipt.slug);
    if (!page) return [];
    return [{
      org_id: params.orgId,
      page_id: page.id,
      source_type: 'message',
      source_id: receipt.message.id,
      source_space_id: receipt.message.space_id,
      source_user_id: receipt.message.user_id,
      excerpt: receipt.summary,
      created_at: receipt.message.created_at,
    }];
  }));
}

async function seedRecordingNotes(params: {
  orgId: string;
  marketingSpaceId: string;
  operationsSpaceId: string;
  buyerSpaceId: string;
  diegoId: string;
}) {
  const noteInputs = [
    {
      title: 'Manual demo notes - Sun Gold launch',
      icon: 'Video',
      isPinned: true,
      visibility: 'space',
      visibilitySpaceId: params.marketingSpaceId,
      content: [
        '<h1>Manual demo notes - Sun Gold launch</h1>',
        '<h2>Manager readout</h2>',
        '<ul>',
        '<li>Buyer wants Tuesday delivery reliability more than big marketing claims.</li>',
        '<li>Use <strong>ruby-sunrise-2026</strong> as the clean proof marker.</li>',
        '<li>Tom drafts launch copy from wiki positioning.</li>',
        '<li>Maya summarizes buyer context for Diego and Lina.</li>',
        '<li>Lina and Sage review claims before Diego approves.</li>',
        '</ul>',
        '<h2>Recording beat</h2>',
        '<p>This note is the bridge between chat and durable company memory. Open it after the chat scene, then jump to the wiki decision page.</p>',
      ].join('\n'),
    },
    {
      title: 'Diego scratchpad - launch blockers',
      icon: 'ClipboardList',
      isPinned: true,
      visibility: 'space',
      visibilitySpaceId: params.operationsSpaceId,
      content: [
        '<h1>Diego scratchpad - launch blockers</h1>',
        '<p><strong>Current blocker:</strong> Tuesday delivery language is frozen until Tomas confirms route capacity.</p>',
        '<ul>',
        '<li>Ask Tomas for a yes/no by 12:30.</li>',
        '<li>If no, Tom keeps copy flavor-first and removes delivery-date language.</li>',
        '<li>Maya posts a launch-readiness update after Chef Amara call.</li>',
        '<li>Sage owns final food-safety caveat.</li>',
        '</ul>',
        '<p>Demo beat: show this note, then show the same logic saved as wiki knowledge.</p>',
      ].join('\n'),
    },
    {
      title: 'Chef Amara call prep',
      icon: 'Phone',
      isPinned: false,
      visibility: 'space',
      visibilitySpaceId: params.buyerSpaceId,
      content: [
        '<h1>Chef Amara call prep</h1>',
        '<h2>Questions</h2>',
        '<ul>',
        '<li>Is the first box for tasting, prep testing, or a small service run?</li>',
        '<li>Does the kitchen need flavor notes, handling notes, or both?</li>',
        '<li>Would a Tuesday window work only if confirmed by noon today?</li>',
        '</ul>',
        '<h2>After call</h2>',
        '<p>Ask Maya to summarize the call in buyer-updates and create any follow-up tasks.</p>',
      ].join('\n'),
    },
    {
      title: 'Agent receipt moments to show',
      icon: 'Receipt',
      isPinned: false,
      visibility: 'org',
      visibilitySpaceId: null,
      content: [
        '<h1>Agent receipt moments to show</h1>',
        '<ol>',
        '<li>Tom proposes a buyer-facing message rather than silently sending it.</li>',
        '<li>Diego approves the action from Dashboard or Inbox.</li>',
        '<li>The task/comment/chat update lands back in the shared work record.</li>',
        '<li>Open Agent Activity to show the audit row and receipt path.</li>',
        '</ol>',
        '<p>This keeps the video honest: agents can do work, but governed writes leave a trail.</p>',
      ].join('\n'),
    },
  ];

  await db
    .delete(notes)
    .where(and(
      eq(notes.org_id, params.orgId),
      eq(notes.user_id, params.diegoId),
      inArray(notes.title, noteInputs.map((note) => note.title)),
    ));

  await db.insert(notes).values(noteInputs.map((note, index) => ({
    org_id: params.orgId,
    user_id: params.diegoId,
    title: note.title,
    icon: note.icon,
    is_pinned: note.isPinned,
    visibility: note.visibility,
    visibility_space_id: note.visibilitySpaceId,
    content: note.content,
    created_at: hoursAgo(7 - index),
    updated_at: hoursAgo(2 - index * 0.25),
  })));
}

async function seedOperatingDay(params: {
  orgId: string;
  diegoId: string;
}) {
  const todayStart = atToday(0, 0);
  const todayEnd = atOffsetDay(1, 0, 0);

  await db
    .delete(standups)
    .where(and(eq(standups.org_id, params.orgId), gte(standups.date, todayStart), lt(standups.date, todayEnd)));

  await db.insert(standups).values({
    org_id: params.orgId,
    date: atToday(9, 0),
    generated_by: params.diegoId,
    summary:
      'Sun Gold launch day is active: Diego is confirming route capacity, Tom is drafting buyer copy, Maya is preparing the communications pulse, and Lina/Sage are guarding claims before anything leaves the farm.',
    raw_data: {
      source: 'pilot-polish',
      highlights: [
        'Two buyer conversations today',
        'Three launch tasks due today',
        'BYOA employees have visible ownership',
      ],
    },
  });

  const seededEvents = [
    {
      source: 'native' as const,
      external_id: 'pilot-field-forecast-pass',
      title: 'Greenhouse yield forecast pass',
      body: 'Marigold and Cesar estimate Sun Gold pick volume before sample-box counts are finalized.',
      start: atToday(8, 30),
      end: atToday(9, 0),
      location: 'Greenhouse 2',
      attendees: ['Marigold', 'Cesar'],
    },
    {
      source: 'native' as const,
      external_id: 'pilot-sun-gold-standup',
      title: 'Sun Gold launch standup',
      body: 'Review route capacity, buyer-readiness, and agent-owned copy tasks.',
      start: atToday(9, 15),
      end: atToday(9, 45),
      location: 'marketing space',
      attendees: ['Diego Vargas', 'Lina Bhattacharya', 'Tom', 'Maya'],
    },
    {
      source: 'native' as const,
      external_id: 'pilot-route-capacity-check',
      title: 'Route capacity check with Tomas',
      body: 'Confirm whether Tuesday delivery can be promised for the Sun Gold buyer trial.',
      start: atToday(11, 30),
      end: atToday(12, 0),
      location: 'Packing shed',
      attendees: ['Diego Vargas', 'Tomas'],
    },
    {
      source: 'native' as const,
      external_id: 'pilot-packhouse-handoff',
      title: 'Packhouse sample-box handoff',
      body: 'Check labels, crate staging, and cold-room handoff before buyer copy review.',
      start: atToday(13, 30),
      end: atToday(14, 0),
      location: 'Packhouse',
      attendees: ['Marigold', 'Tomas', 'Sage'],
    },
    {
      source: 'native' as const,
      external_id: 'pilot-chef-amara-call',
      title: 'Chef Amara sample-box call',
      body: 'Align sample size, delivery timing, and flavor notes for the first Sun Gold box.',
      start: atToday(15, 0),
      end: atToday(15, 30),
      location: 'Phone',
      attendees: ['Diego Vargas', 'Chef Amara'],
    },
    {
      source: 'native' as const,
      external_id: 'pilot-launch-review',
      title: 'Buyer copy review with Lina and Sage',
      body: 'Review Tom draft, cold-chain wording, and food-safety claims before buyer send.',
      start: atToday(16, 15),
      end: atToday(17, 0),
      location: 'Deft task board',
      attendees: ['Diego Vargas', 'Lina Bhattacharya', 'Sage Nakamura', 'Tom'],
    },
    {
      source: 'native' as const,
      external_id: 'pilot-agent-copy-approval',
      title: 'Approve agent-drafted buyer update',
      body: 'Diego reviews Tom/Maya proposed launch update before it lands in marketing.',
      start: atToday(17, 15),
      end: atToday(17, 30),
      location: 'Deft approvals',
      attendees: ['Diego Vargas', 'Tom', 'Maya'],
    },
    {
      source: 'ics' as const,
      external_id: 'pilot-ics-market-cutoff',
      title: 'ICS: farmers market vendor cutoff',
      body: 'External market calendar cutoff for Saturday stall notes and buyer handout changes.',
      start: atOffsetDay(1, 10, 0),
      end: atOffsetDay(1, 10, 30),
      location: 'Market calendar feed',
      attendees: ['Diego Vargas'],
    },
    {
      source: 'native' as const,
      external_id: 'pilot-weekly-buyer-pulse',
      title: 'Weekly buyer pulse draft',
      body: 'Maya drafts the buyer pulse from chat, tasks, and wiki decisions.',
      start: atOffsetDay(1, 14, 0),
      end: atOffsetDay(1, 14, 30),
      location: 'buyer-updates space',
      attendees: ['Maya', 'Diego Vargas'],
    },
    {
      source: 'native' as const,
      external_id: 'pilot-farmers-market-prep',
      title: 'Saturday market booth prep',
      body: 'Check booth signs, sample crates, buyer handout, and launch wording.',
      start: atOffsetDay(2, 10, 0),
      end: atOffsetDay(2, 11, 0),
      location: 'Farmers market stall',
      attendees: ['Diego Vargas', 'Maya', 'Tom'],
    },
  ];

  for (const event of seededEvents) {
    await db
      .insert(events)
      .values({
        org_id: params.orgId,
        source: event.source,
        event_type: 'calendar_event',
        external_id: event.external_id,
        title: event.title,
        body: event.body,
        url: null,
        actor: 'diego@testers-tomatoes.com',
        timestamp: event.start,
        metadata: {
          start: event.start.toISOString(),
          end: event.end.toISOString(),
          location: event.location,
          attendees: event.attendees,
          hangoutLink: null,
          status: 'confirmed',
          allDay: false,
          seed: 'pilot-polish',
          feedLabel: event.source === 'ics' ? 'Regional market ICS' : 'Native Deft calendar',
        },
        user_id: params.diegoId,
        connected_account_id: null,
      })
      .onConflictDoUpdate({
        target: [events.source, events.external_id],
        set: {
          title: event.title,
          body: event.body,
          timestamp: event.start,
          metadata: {
            start: event.start.toISOString(),
            end: event.end.toISOString(),
            location: event.location,
            attendees: event.attendees,
            hangoutLink: null,
            status: 'confirmed',
            allDay: false,
            seed: 'pilot-polish',
            feedLabel: event.source === 'ics' ? 'Regional market ICS' : 'Native Deft calendar',
          },
          user_id: params.diegoId,
          updated_at: new Date(),
        },
      });
  }

  await db
    .delete(reminders)
    .where(and(eq(reminders.org_id, params.orgId), eq(reminders.user_id, params.diegoId), inArray(reminders.message, [
      'Check if Tomas confirmed Tuesday route capacity',
      'Send launch-readiness note before buyer copy review',
      'Ask Codex to summarize unread launch blockers',
      'Open Agent Activity before recording the approval scene',
    ])));

  await db.insert(reminders).values([
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      message: 'Check if Tomas confirmed Tuesday route capacity',
      remind_at: atToday(13, 0),
      is_sent: false,
    },
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      message: 'Send launch-readiness note before buyer copy review',
      remind_at: atToday(15, 45),
      is_sent: false,
    },
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      message: 'Ask Codex to summarize unread launch blockers',
      remind_at: atToday(10, 15),
      is_sent: false,
    },
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      message: 'Open Agent Activity before recording the approval scene',
      remind_at: atToday(17, 5),
      is_sent: false,
    },
  ]);
}

async function seedTeamHealth(params: {
  orgId: string;
  generatedBy: string;
  humans: SeedUser[];
  tom: SeedUser;
  maya: SeedUser;
}) {
  await db.delete(teamHealthSnapshots).where(eq(teamHealthSnapshots.org_id, params.orgId));

  await db.insert(teamHealthSnapshots).values({
    org_id: params.orgId,
    snapshot_date: new Date(),
    generated_by: params.generatedBy,
    team_data: {
      summary:
        'Clean local pilot is ready for chat, tasks, wiki memory, calendar ICS, and BYOA employee testing.',
      healthCards: [
        ...params.humans.map((user) => ({
          userId: user.id,
          name: user.name,
          signal: 'steady',
          note: 'Seeded human teammate with current tasks and workspace context.',
        })),
        {
          userId: params.tom.id,
          name: params.tom.name,
          signal: 'ready',
          note: 'OpenClaw BYOA marketing employee seeded with assigned pilot tasks.',
        },
        {
          userId: params.maya.id,
          name: params.maya.name,
          signal: 'ready',
          note: 'Hermes BYOA communications employee seeded with assigned pilot tasks.',
        },
      ],
      wins: [
        'Workspace reset removes stale audit users and old agent test residue.',
        'BYOA employees have deterministic MCP tokens for local certification.',
        'Wiki includes a known proof phrase for clean retrieval tests.',
      ],
      actionItems: [
        'Run the browser chat-to-wiki proof after reset.',
        'Run MCP memory_recall and wiki_search against Tom and Maya tokens.',
      ],
    },
  });
}

function pilotNotificationPreferences(
  keywords: string[],
  channels: Partial<PilotNotificationChannels> = {},
): {
  keywords: string[];
  channels: PilotNotificationChannels;
  push: {
    enabled: boolean;
    chat: boolean;
    tasks: boolean;
    approvals: boolean;
    calendar: boolean;
    agents: boolean;
    quiet_hours: { enabled: boolean; start: string; end: string };
  };
} {
  return {
    keywords,
    channels: {
      chat: true,
      tasks: true,
      approvals: true,
      calendar: true,
      agents: true,
      ...channels,
    },
    push: {
      enabled: false,
      chat: true,
      tasks: true,
      approvals: true,
      calendar: true,
      agents: true,
      quiet_hours: { enabled: false, start: '22:00', end: '08:00' },
    },
  };
}

async function seedPeopleAndTeamManagement(params: {
  orgId: string;
  createdBy: string;
  diego: SeedUser;
  marigold: SeedUser;
  cesar: SeedUser;
  lina: SeedUser;
  tomas: SeedUser;
  sage: SeedUser;
  tom: SeedUser;
  maya: SeedUser;
}) {
  const expiresAt = plusDays(2);
  const profileSeeds: Array<{
    user: SeedUser;
    avatarUrl: string;
    title: string;
    summary: string;
    tags: string[];
    timezone: string;
    statusEmoji: string;
    statusText: string;
    keywords: string[];
    channels?: Partial<PilotNotificationChannels>;
  }> = [
    {
      user: params.diego,
      avatarUrl: '/avatars/avatar-01-human-purple.png',
      title: 'Founder & Farm Manager',
      summary:
        'Runs the Testers Tomatoes launch room, route decisions, buyer follow-up, and agent approvals.',
      tags: ['operations', 'launch', 'buyers', 'agents'],
      timezone: 'America/Los_Angeles',
      statusEmoji: '🍅',
      statusText: 'Watching launch readiness and buyer promises',
      keywords: ['launch', 'buyer', 'route', 'Defty', 'Tom', 'Maya'],
    },
    {
      user: params.marigold,
      avatarUrl: '/avatars/avatar-02-human-coral.png',
      title: 'Head Grower',
      summary:
        'Owns greenhouse health, harvest quality, seed selection, and field-to-packhouse handoff.',
      tags: ['greenhouse', 'crop-health', 'harvest', 'quality'],
      timezone: 'America/Los_Angeles',
      statusEmoji: '🌱',
      statusText: 'In greenhouse checks before noon',
      keywords: ['greenhouse', 'seed', 'quality', 'harvest'],
    },
    {
      user: params.cesar,
      avatarUrl: '/avatars/avatar-03-elder-cyan.png',
      title: 'Field Supervisor',
      summary:
        'Coordinates crews, field forecasts, irrigation windows, and late-day harvest risk.',
      tags: ['field-ops', 'irrigation', 'crew', 'forecast'],
      timezone: 'America/Los_Angeles',
      statusEmoji: '🌤️',
      statusText: 'Checking irrigation and crew load',
      keywords: ['field', 'crew', 'irrigation', 'forecast'],
    },
    {
      user: params.lina,
      avatarUrl: '/avatars/avatar-04-elder-gold.png',
      title: 'Wholesale Lead',
      summary:
        'Owns buyer messaging, chef samples, wholesale commitments, and launch copy review.',
      tags: ['sales', 'buyers', 'samples', 'messaging'],
      timezone: 'America/Los_Angeles',
      statusEmoji: '📞',
      statusText: 'Buyer calls and launch copy review',
      keywords: ['Chef Amara', 'buyer', 'sample', 'wholesale'],
    },
    {
      user: params.tomas,
      avatarUrl: '/avatars/avatar-05-alien-teal.png',
      title: 'Packhouse & Routes Lead',
      summary:
        'Keeps packing capacity, cold-room handoff, route timing, and box readiness honest.',
      tags: ['packhouse', 'routes', 'cold-room', 'capacity'],
      timezone: 'America/Los_Angeles',
      statusEmoji: '🚚',
      statusText: 'Route capacity check in progress',
      keywords: ['route', 'packhouse', 'cold-room', 'capacity'],
    },
    {
      user: params.sage,
      avatarUrl: '/avatars/avatar-06-mascot-purple.png',
      title: 'Food Safety & Ops Analyst',
      summary:
        'Reviews claims language, SOP changes, launch risks, and operational receipts.',
      tags: ['food-safety', 'sop', 'claims', 'risk'],
      timezone: 'America/Los_Angeles',
      statusEmoji: '🛡️',
      statusText: 'Reviewing launch claims and SOP receipts',
      keywords: ['claims', 'SOP', 'food safety', 'approval'],
    },
    {
      user: params.tom,
      avatarUrl: '/avatars/avatar-07-wizard.png',
      title: 'Marketing Agent',
      summary:
        'OpenClaw BYOA employee for buyer research, launch messaging, and marketing task execution.',
      tags: ['agent', 'openclaw', 'marketing', 'mcp'],
      timezone: 'America/Los_Angeles',
      statusEmoji: '✨',
      statusText: 'Available through MCP for marketing work',
      keywords: ['Tom', 'marketing', 'buyer', 'MCP'],
      channels: { calendar: false },
    },
    {
      user: params.maya,
      avatarUrl: '/avatars/avatar-09-fairy.png',
      title: 'Communications Agent',
      summary:
        'Hermes BYOA employee for internal updates, stakeholder summaries, and launch communications.',
      tags: ['agent', 'hermes', 'communications', 'mcp'],
      timezone: 'America/Los_Angeles',
      statusEmoji: '✨',
      statusText: 'Available through MCP for comms work',
      keywords: ['Maya', 'communications', 'summary', 'MCP'],
      channels: { calendar: false },
    },
  ];

  for (const profile of profileSeeds) {
    await db
      .update(users)
      .set({
        avatar_url: profile.avatarUrl,
        title: profile.title,
        profile_summary: profile.summary,
        expertise_tags: profile.tags,
        timezone: profile.timezone,
        status_emoji: profile.statusEmoji,
        status_text: profile.statusText,
        status_expires_at: expiresAt,
        notification_keywords: profile.keywords,
        notification_preferences: pilotNotificationPreferences(profile.keywords, profile.channels),
        show_read_receipts: true,
        updated_at: new Date(),
      })
      .where(eq(users.id, profile.user.id));
  }

  const groupSeeds = [
    {
      name: 'Leadership',
      handle: 'leadership',
      description: 'Diego, Marigold, and Lina for launch calls and final tradeoffs.',
      memberIds: [params.diego.id, params.marigold.id, params.lina.id],
    },
    {
      name: 'Launch Review',
      handle: 'launch-review',
      description: 'People and agents reviewing buyer copy, route promises, and approval receipts.',
      memberIds: [
        params.diego.id,
        params.lina.id,
        params.sage.id,
        params.tomas.id,
        params.tom.id,
        params.maya.id,
      ],
    },
    {
      name: 'Field Crew',
      handle: 'field-crew',
      description: 'Crop, crew, route, and physical readiness updates.',
      memberIds: [params.marigold.id, params.cesar.id, params.tomas.id, params.sage.id],
    },
    {
      name: 'Agent Coworkers',
      handle: 'agent-coworkers',
      description: 'BYOA employees plus Diego for quick MCP and behavior checks.',
      memberIds: [params.diego.id, params.tom.id, params.maya.id],
    },
  ];

  const upsertedGroups: Array<{ id: string; memberIds: string[] }> = [];
  for (const group of groupSeeds) {
    const row = expectOne(await db
      .insert(userGroups)
      .values({
        org_id: params.orgId,
        name: group.name,
        handle: group.handle,
        description: group.description,
        created_by: params.createdBy,
      })
      .onConflictDoUpdate({
        target: [userGroups.org_id, userGroups.handle],
        set: {
          name: group.name,
          description: group.description,
          updated_at: new Date(),
        },
      })
      .returning(), `group ${group.handle}`);
    upsertedGroups.push({ id: row.id, memberIds: group.memberIds });
  }

  if (upsertedGroups.length > 0) {
    await db
      .delete(userGroupMembers)
      .where(inArray(userGroupMembers.group_id, upsertedGroups.map((group) => group.id)));

    await db
      .insert(userGroupMembers)
      .values(upsertedGroups.flatMap((group) => group.memberIds.map((userId) => ({
        group_id: group.id,
        user_id: userId,
      }))))
      .onConflictDoNothing();
  }

  const spaceRows = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(and(
      eq(spaces.org_id, params.orgId),
      inArray(spaces.name, ['general', 'marketing', 'operations', 'buyer-updates', 'field-ops']),
    ));
  const projectRows = await db
    .select({ id: projects.id, prefix: projects.prefix, name: projects.name })
    .from(projects)
    .where(and(eq(projects.org_id, params.orgId), inArray(projects.prefix, ['MKT', 'OPS', 'BUY', 'SAFE'])));
  const wikiRows = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title })
    .from(wikiPages)
    .where(and(eq(wikiPages.org_id, params.orgId), inArray(wikiPages.slug, [
      'ruby-sunrise-2026-proof-marker',
      'byoa-employee-operating-model',
      'sun-gold-trial-launch-decision',
      'buyer-launch-review-loop',
      'chef-amara-buyer-profile',
      'cold-room-handoff-sop',
      'sun-gold-buyer-personas',
      'agent-approval-rails-for-launch-work',
      'demo-video-recording-map',
    ])));
  const noteRows = await db
    .select({ id: notes.id, title: notes.title })
    .from(notes)
    .where(and(eq(notes.org_id, params.orgId), inArray(notes.title, [
      'Manual demo notes - Sun Gold launch',
      'Diego scratchpad - launch blockers',
      'Chef Amara call prep',
      'Agent receipt moments to show',
    ])));
  const employeeRows = await db
    .select({ id: agentEmployees.id, slug: agentEmployees.slug, name: agentEmployees.name })
    .from(agentEmployees)
    .where(and(eq(agentEmployees.org_id, params.orgId), inArray(agentEmployees.slug, ['tom', 'maya'])));

  const spaceByName = new Map(spaceRows.map((space) => [space.name, space.id]));
  const projectByPrefix = new Map(projectRows.map((project) => [project.prefix, project.id]));
  const wikiBySlug = new Map(wikiRows.map((page) => [page.slug, page.id]));
  const noteByTitle = new Map(noteRows.map((note) => [note.title, note.id]));
  const employeeBySlug = new Map(employeeRows.map((employee) => [employee.slug, employee.id]));

  const resource = (
    resourceType: PilotTeamResourceType,
    resourceId: string | undefined,
    label: string,
  ) => resourceId ? {
    resource_type: resourceType,
    resource_id: resourceId,
    label,
  } : null;

  const teamSeeds: Array<{
    name: string;
    handle: string;
    description: string;
    type: string;
    color: string;
    avatarUrl: string;
    leadUserId: string;
    defaultSpaceId?: string;
    members: Array<{ userId: string; role: PilotTeamRole }>;
    resources: Array<ReturnType<typeof resource>>;
    snapshot: Record<string, unknown>;
  }> = [
    {
      name: 'Farm Operations',
      handle: 'farm-ops',
      description: 'Greenhouse, field, packhouse, route, and food-safety execution for the launch.',
      type: 'functional',
      color: '#10b981',
      avatarUrl: '/avatars/avatar-19-cactus.png',
      leadUserId: params.marigold.id,
      defaultSpaceId: spaceByName.get('field-ops'),
      members: [
        { userId: params.marigold.id, role: 'lead' },
        { userId: params.cesar.id, role: 'member' },
        { userId: params.tomas.id, role: 'member' },
        { userId: params.sage.id, role: 'member' },
        { userId: params.diego.id, role: 'viewer' },
      ],
      resources: [
        resource('space', spaceByName.get('field-ops'), '#field-ops'),
        resource('space', spaceByName.get('operations'), '#operations'),
        resource('project', projectByPrefix.get('OPS'), 'Route + Packing Reliability'),
        resource('project', projectByPrefix.get('SAFE'), 'Food Safety Claims Review'),
        resource('wiki_page', wikiBySlug.get('cold-room-handoff-sop'), 'Cold-room handoff SOP'),
        resource('note', noteByTitle.get('Diego scratchpad - launch blockers'), 'Launch blocker scratchpad'),
      ],
      snapshot: {
        headline: 'Farm Operations is steady, but route and cold-room promises need close review.',
        health: 'watch',
        activeProjects: ['OPS', 'SAFE'],
        risks: [
          'Cold-room handoff language still needs owner confirmation before buyer copy goes final.',
          'Route capacity is tight during the Tuesday sample window.',
        ],
        nextActions: [
          'Confirm route promise with Tomas.',
          'Close the food-safety claims review before the buyer update.',
        ],
      },
    },
    {
      name: 'Go-to-Market',
      handle: 'go-to-market',
      description: 'Buyer messaging, launch tasks, market story, and agent-assisted follow-up.',
      type: 'functional',
      color: '#8b5cf6',
      avatarUrl: '/avatars/avatar-21-mascot-blue.png',
      leadUserId: params.lina.id,
      defaultSpaceId: spaceByName.get('marketing'),
      members: [
        { userId: params.lina.id, role: 'lead' },
        { userId: params.diego.id, role: 'member' },
        { userId: params.sage.id, role: 'member' },
        { userId: params.tom.id, role: 'member' },
        { userId: params.maya.id, role: 'member' },
      ],
      resources: [
        resource('space', spaceByName.get('marketing'), '#marketing'),
        resource('space', spaceByName.get('buyer-updates'), '#buyer-updates'),
        resource('project', projectByPrefix.get('MKT'), 'Pilot Marketing Launch'),
        resource('project', projectByPrefix.get('BUY'), 'Chef Sample Program'),
        resource('wiki_page', wikiBySlug.get('sun-gold-trial-launch-decision'), 'Sun Gold launch decision'),
        resource('wiki_page', wikiBySlug.get('sun-gold-buyer-personas'), 'Buyer personas'),
        resource('note', noteByTitle.get('Chef Amara call prep'), 'Chef Amara call prep'),
        resource('agent_employee', employeeBySlug.get('tom'), 'Tom marketing agent'),
        resource('agent_employee', employeeBySlug.get('maya'), 'Maya communications agent'),
      ],
      snapshot: {
        headline: 'Go-to-Market has the richest demo surface: humans, BYOA agents, tasks, memory, and approvals.',
        health: 'good',
        activeProjects: ['MKT', 'BUY'],
        risks: [
          'Buyer-facing language should avoid over-promising Tuesday delivery windows.',
          'Agent work should keep receipt trails visible for the demo.',
        ],
        nextActions: [
          'Use Codex or Claude over MCP to summarize unread launch blockers.',
          'Have Tom draft buyer-specific talking points from wiki context.',
        ],
      },
    },
    {
      name: 'Leadership',
      handle: 'leadership',
      description: 'Founder, grower, and sales leads tracking readiness, decisions, and escalation points.',
      type: 'leadership',
      color: '#f59e0b',
      avatarUrl: '/avatars/avatar-13-genie.png',
      leadUserId: params.diego.id,
      defaultSpaceId: spaceByName.get('general') ?? spaceByName.get('marketing'),
      members: [
        { userId: params.diego.id, role: 'lead' },
        { userId: params.marigold.id, role: 'member' },
        { userId: params.lina.id, role: 'member' },
        { userId: params.tomas.id, role: 'viewer' },
        { userId: params.maya.id, role: 'viewer' },
      ],
      resources: [
        resource('space', spaceByName.get('general'), '#general'),
        resource('space', spaceByName.get('marketing'), '#marketing'),
        resource('space', spaceByName.get('operations'), '#operations'),
        resource('project', projectByPrefix.get('MKT'), 'Pilot Marketing Launch'),
        resource('project', projectByPrefix.get('OPS'), 'Route + Packing Reliability'),
        resource('wiki_page', wikiBySlug.get('byoa-employee-operating-model'), 'BYOA operating model'),
        resource('wiki_page', wikiBySlug.get('agent-approval-rails-for-launch-work'), 'Agent approval rails'),
        resource('wiki_page', wikiBySlug.get('demo-video-recording-map'), 'Demo recording map'),
        resource('note', noteByTitle.get('Agent receipt moments to show'), 'Agent receipt moments'),
      ],
      snapshot: {
        headline: 'Leadership has one place to see launch narrative, operational risk, and agent governance.',
        health: 'good',
        activeProjects: ['MKT', 'OPS', 'SAFE'],
        risks: [
          'Demo should explain that agents propose and receipt important writes.',
          'Founder should keep the workspace clean before recording.',
        ],
        nextActions: [
          'Open dashboard, teams, chat, tasks, knowledge, calendar, and MCP access in the demo path.',
          'Show a subtle knowledge receipt rather than a noisy approval-card stream.',
        ],
      },
    },
  ];

  const upsertedTeams: Array<{ id: string; spec: (typeof teamSeeds)[number] }> = [];
  for (const team of teamSeeds) {
    const row = expectOne(await db
      .insert(teams)
      .values({
        org_id: params.orgId,
        name: team.name,
        handle: team.handle,
        description: team.description,
        type: team.type,
        visibility: 'org',
        avatar_url: team.avatarUrl,
        color: team.color,
        lead_user_id: team.leadUserId,
        default_space_id: team.defaultSpaceId ?? null,
        is_archived: false,
        created_by: params.createdBy,
      })
      .onConflictDoUpdate({
        target: [teams.org_id, teams.handle],
        set: {
          name: team.name,
          description: team.description,
          type: team.type,
          visibility: 'org',
          avatar_url: team.avatarUrl,
          color: team.color,
          lead_user_id: team.leadUserId,
          default_space_id: team.defaultSpaceId ?? null,
          is_archived: false,
          updated_at: new Date(),
        },
      })
      .returning(), `team ${team.handle}`);
    upsertedTeams.push({ id: row.id, spec: team });
  }

  const teamIds = upsertedTeams.map((team) => team.id);
  if (teamIds.length > 0) {
    await db.delete(teamMembers).where(inArray(teamMembers.team_id, teamIds));
    await db.delete(teamResources).where(inArray(teamResources.team_id, teamIds));
    await db.delete(teamDashboardSnapshots).where(inArray(teamDashboardSnapshots.team_id, teamIds));

    await db.insert(teamMembers).values(upsertedTeams.flatMap((team) => (
      team.spec.members.map((member) => ({
        org_id: params.orgId,
        team_id: team.id,
        user_id: member.userId,
        role: member.role,
      }))
    ))).onConflictDoNothing();

    const resourceValues = upsertedTeams.flatMap((team) => (
      team.spec.resources.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => ({
        org_id: params.orgId,
        team_id: team.id,
        resource_type: item.resource_type,
        resource_id: item.resource_id,
        label: item.label,
        created_by: params.createdBy,
      }))
    ));
    if (resourceValues.length > 0) {
      await db.insert(teamResources).values(resourceValues).onConflictDoNothing();
    }

    await db.insert(teamDashboardSnapshots).values(upsertedTeams.map((team) => ({
      org_id: params.orgId,
      team_id: team.id,
      snapshot_type: 'pilot_seed_v2',
      payload_json: {
        ...team.spec.snapshot,
        generatedFor: 'standard-pilot-seed',
        seededAt: new Date().toISOString(),
      },
      generated_at: new Date(),
    })));
  }
}

async function seedAgentAndInboxActivity(params: {
  orgId: string;
  diegoId: string;
  tomUser: SeedUser;
  mayaUser: SeedUser;
  marketingSpaceId: string;
}) {
  const oldActions = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(and(eq(agentActions.org_id, params.orgId), eq(agentActions.source, 'pilot-living')));
  const oldActionIds = oldActions.map((action) => action.id);
  if (oldActionIds.length > 0) {
    await db.delete(actionReceipts).where(inArray(actionReceipts.action_id, oldActionIds));
    await db.delete(agentActions).where(inArray(agentActions.id, oldActionIds));
  }

  const tomEmployeeId = params.tomUser.agent_employee_id;
  const mayaEmployeeId = params.mayaUser.agent_employee_id;

  const [approvedTaskAction] = await db.insert(agentActions).values({
    org_id: params.orgId,
    user_id: params.diegoId,
    conversation_id: params.marketingSpaceId,
    agent_employee_id: tomEmployeeId,
    source: 'pilot-living',
    action: 'task_update',
    params: {
      task_identifier: 'BUY-3',
      status: 'in_progress',
      note: 'Tom started grocer pitch after reading buyer personas and route promise gate.',
    },
    result: {
      ok: true,
      task_identifier: 'BUY-3',
      changed: ['status', 'comment'],
    },
    approval_tier: 'quick',
    approval_status: 'approved',
    approved_at: hoursAgo(1.05),
    executed_at: hoursAgo(1),
    created_at: hoursAgo(1.2),
    updated_at: hoursAgo(1),
  }).returning();

  if (approvedTaskAction) {
    await generateReceipt({
      actionId: approvedTaskAction.id,
      orgId: params.orgId,
      employeeId: tomEmployeeId,
      proposer: 'employee',
      proposerId: tomEmployeeId,
      approverId: params.diegoId,
      decision: 'approved',
      decisionReason: 'Tom can update internal task state after grounding in wiki and task context.',
      actionName: 'task_update',
      actionParams: approvedTaskAction.params,
      resultJson: approvedTaskAction.result,
    });
  }

  await db.insert(agentActions).values([
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      conversation_id: params.marketingSpaceId,
      agent_employee_id: tomEmployeeId,
      source: 'pilot-living',
      action: 'post_message',
      params: {
        space_name: 'marketing',
        content:
          'Draft launch update: Sun Gold copy is ready for flavor and sample-box story, but Tuesday delivery language is waiting on Tomas route confirmation.',
        rationale:
          'Buyer-facing update should be reviewed because it mentions delivery timing and launch readiness.',
      },
      result: null,
      approval_tier: 'full',
      approval_status: 'pending',
      created_at: hoursAgo(0.65),
      updated_at: hoursAgo(0.65),
    },
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      conversation_id: params.marketingSpaceId,
      agent_employee_id: mayaEmployeeId,
      source: 'pilot-living',
      action: 'add_knowledge',
      params: {
        space_name: 'marketing',
        type: 'decision',
        title: 'Hold Tuesday delivery promise until route capacity clears',
        content:
          'Maya proposes saving the launch blocker as durable company memory before the buyer update goes out.',
      },
      result: null,
      approval_tier: 'quick',
      approval_status: 'pending',
      created_at: hoursAgo(0.5),
      updated_at: hoursAgo(0.5),
    },
  ]);

  await db
    .delete(notifications)
    .where(and(eq(notifications.org_id, params.orgId), sql`${notifications.metadata}->>'seed' = 'pilot-living'`));
  await db.insert(notifications).values([
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      type: 'agent_suggestion',
      title: 'Tom needs approval to post buyer-facing update',
      body: 'The proposed message mentions launch readiness and delivery timing.',
      link: '/inbox?tab=approvals',
      is_read: false,
      metadata: { seed: 'pilot-living', demo_surface: 'approvals' },
      created_at: hoursAgo(0.65),
      updated_at: hoursAgo(0.65),
    },
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      type: 'wiki_update',
      title: 'Route promise decision is ready to save',
      body: 'Maya proposed durable memory for the Tuesday delivery gate.',
      link: '/knowledge?slug=tuesday-route-promise-gate',
      is_read: false,
      metadata: { seed: 'pilot-living', demo_surface: 'knowledge' },
      created_at: hoursAgo(0.5),
      updated_at: hoursAgo(0.5),
    },
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      type: 'task_assigned',
      title: 'BUY-1 is due during the Chef Amara call',
      body: 'Confirm sample-box size and capture the follow-up owner.',
      link: '/tasks?task=BUY-1',
      is_read: false,
      metadata: { seed: 'pilot-living', demo_surface: 'today' },
      created_at: hoursAgo(0.4),
      updated_at: hoursAgo(0.4),
    },
    {
      org_id: params.orgId,
      user_id: params.diegoId,
      type: 'mention',
      title: 'Lina mentioned the delivery-language blocker',
      body: 'Buyer-facing Tuesday copy is blocked until route capacity is confirmed.',
      link: '/chat',
      is_read: false,
      metadata: { seed: 'pilot-living', demo_surface: 'chat' },
      created_at: hoursAgo(0.3),
      updated_at: hoursAgo(0.3),
    },
  ]);
}

async function seedPersonalMcpAccess(params: {
  orgId: string;
  diegoId: string;
}) {
  const tokenName = 'Demo Codex MCP client';
  await db
    .delete(mcpTokens)
    .where(and(
      eq(mcpTokens.org_id, params.orgId),
      eq(mcpTokens.user_id, params.diegoId),
      eq(mcpTokens.principal_kind, 'human'),
      eq(mcpTokens.name, tokenName),
    ));

  await db.insert(mcpTokens).values({
    org_id: params.orgId,
    user_id: params.diegoId,
    principal_kind: 'human',
    name: tokenName,
    token_hash: await bcrypt.hash(DIEGO_MCP_TOKEN, 10),
    token_prefix: DIEGO_MCP_TOKEN.slice(0, 18),
    scopes: [
      'read:workspace',
      'read:wiki',
      'read:tasks',
      'read:messages',
      'read:calendar',
      'write:tasks',
      'write:messages',
      'write:wiki',
    ],
    last_used_at: hoursAgo(0.75),
    created_by: params.diegoId,
    created_at: hoursAgo(30),
    updated_at: hoursAgo(0.75),
  });
}

async function cleanReadState(orgId: string) {
  const orgSpaces = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.org_id, orgId));
  if (orgSpaces.length > 0) {
    await db
      .update(spaceMembers)
      .set({ last_read_at: new Date() })
      .where(inArray(spaceMembers.space_id, orgSpaces.map((space) => space.id)));
  }

  await db.update(notifications).set({ is_read: true }).where(eq(notifications.org_id, orgId));
}

async function cleanPilotActionNoise(orgId: string) {
  const deletedIntents = await db
    .delete(workIntents)
    .where(eq(workIntents.org_id, orgId))
    .returning({ id: workIntents.id });

  const staleActions = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, orgId),
      inArray(agentActions.source, PILOT_ACTION_SOURCES_TO_PRUNE),
  ));
  const staleActionIds = staleActions.map((action) => action.id);
  if (staleActionIds.length === 0) {
    if (deletedIntents.length > 0) {
      console.log(`[seed-pilot-workspace] pruned ${deletedIntents.length} stale work intent rows`);
    }
    return;
  }

  await db
    .update(taskActivity)
    .set({ agent_action_id: null })
    .where(inArray(taskActivity.agent_action_id, staleActionIds));
  await db.delete(actionReceipts).where(inArray(actionReceipts.action_id, staleActionIds));
  await db.delete(agentActions).where(inArray(agentActions.id, staleActionIds));
  console.log(`[seed-pilot-workspace] pruned ${staleActionIds.length} stale pilot/capture action rows`);
  if (deletedIntents.length > 0) {
    console.log(`[seed-pilot-workspace] pruned ${deletedIntents.length} stale work intent rows`);
  }
}

async function cleanDuplicatePilotAgents(orgId: string) {
  const stalePilotAgents = await db
    .select({
      id: agentEmployees.id,
      user_id: agentEmployees.user_id,
      name: agentEmployees.name,
      slug: agentEmployees.slug,
    })
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.org_id, orgId),
      eq(agentEmployees.is_deleted, false),
      or(
        inArray(agentEmployees.slug, ['tom-1', 'maya-1']),
        inArray(agentEmployees.name, ['Tom 1', 'Maya 1']),
      ),
    ));

  if (stalePilotAgents.length === 0) {
    return;
  }

  const now = new Date();
  const staleEmployeeIds = stalePilotAgents.map((employee) => employee.id);
  await db
    .update(agentEmployees)
    .set({ is_active: false, is_deleted: true, deleted_at: now, updated_at: now })
    .where(inArray(agentEmployees.id, staleEmployeeIds));

  const staleUserIds = stalePilotAgents.map((employee) => employee.user_id);
  await db
    .update(orgMembers)
    .set({ is_active: false, updated_at: now })
    .where(and(eq(orgMembers.org_id, orgId), inArray(orgMembers.user_id, staleUserIds)));

  console.log(`[seed-pilot-workspace] archived ${stalePilotAgents.length} stale duplicate pilot agent rows`);
}

export async function seedPilotWorkspace(): Promise<{
  orgId: string;
  tomToken: string;
  mayaToken: string;
  proofPhrase: string;
}> {
  console.log('[seed-pilot-workspace] starting pilot polish seed');

  const org = await mustFindPilotOrg();
  const diego = await findUserByEmail('diego@testers-tomatoes.com');
  const marigold = await findUserByEmail('marigold@testers-tomatoes.com');
  const cesar = await findUserByEmail('cesar@testers-tomatoes.com');
  const lina = await findUserByEmail('lina@testers-tomatoes.com');
  const tomas = await findUserByEmail('tomas@testers-tomatoes.com');
  const sage = await findUserByEmail('sage@testers-tomatoes.com');

  await cleanDuplicatePilotAgents(org.id);

  const tom = await upsertAgentUser({
    orgId: org.id,
    createdBy: diego.id,
    name: 'Tom',
    slug: 'tom',
    title: 'Marketing Agent',
    runtimeKind: 'openclaw',
    jobTitle: 'Marketing Agent',
    wakeMode: 'polling',
    token: TOM_TOKEN,
    expertiseDescription:
      'Marketing strategy, buyer copy, farmers market positioning, and wholesale launch messaging for Testers Tomatoes.',
    systemPrompt:
      'You are Tom, an already-running OpenClaw agent onboarded into Deft as the marketing employee for Testers Tomatoes. Keep your own runtime identity. Use Deft tasks, messages, and wiki memory as workplace context. Do not prefix every reply with your name.',
    triggerSubscriptions: ['task.assigned', 'message.mention', 'wiki.updated'],
  });

  const maya = await upsertAgentUser({
    orgId: org.id,
    createdBy: diego.id,
    name: 'Maya',
    slug: 'maya',
    title: 'Communications Agent',
    runtimeKind: 'hermes',
    jobTitle: 'Communications Agent',
    wakeMode: 'manual',
    token: MAYA_TOKEN,
    expertiseDescription:
      'Internal updates, stakeholder summaries, weekly pulse writing, and customer-facing communication hygiene.',
    systemPrompt:
      'You are Maya, an already-running Hermes agent onboarded into Deft as the communications employee for Testers Tomatoes. Keep your own runtime identity. Use Deft tasks, messages, and wiki memory as workplace context. Do not prefix every reply with your name.',
    triggerSubscriptions: ['task.assigned', 'message.mention', 'wiki.updated'],
  });

  const marketingSpace = await ensureSpace({
    orgId: org.id,
    createdBy: diego.id,
    name: 'marketing',
    description: 'Pilot-safe marketing, buyer messaging, and launch communication work.',
    topic: `Clean pilot workspace. Memory proof phrase: ${PROOF_PHRASE}`,
  });
  const operationsSpace = await ensureSpace({
    orgId: org.id,
    createdBy: diego.id,
    name: 'operations',
    description: 'Route, packhouse, cold-room, and harvest coordination for the launch.',
    topic: 'Tuesday route capacity, cold-room handoff, and sample-box readiness.',
  });
  const buyerSpace = await ensureSpace({
    orgId: org.id,
    createdBy: diego.id,
    name: 'buyer-updates',
    description: 'Chef, grocer, and market buyer updates that become follow-up work.',
    topic: 'Chef Amara sample box, Field Co-op feedback, and buyer-facing launch follow-up.',
  });
  const fieldOpsSpace = await ensureSpace({
    orgId: org.id,
    createdBy: diego.id,
    name: 'field-ops',
    description: 'Harvest forecasts, greenhouse notes, market prep, and physical crop context.',
    topic: 'What is actually happening on the farm today.',
  });

  const publicSpaces = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.org_id, org.id), eq(spaces.type, 'public'), eq(spaces.is_archived, false)));

  await ensureSpaceMembers(
    [...new Set([
      ...publicSpaces.map((space) => space.id),
      marketingSpace.id,
      operationsSpace.id,
      buyerSpace.id,
      fieldOpsSpace.id,
    ])],
    [diego.id, marigold.id, cesar.id, lina.id, tomas.id, sage.id, tom.id, maya.id],
  );

  const marketingProject = await ensureProject({
    orgId: org.id,
    leadId: lina.id,
    name: 'Pilot Marketing Launch',
    description:
      'A clean local project for exercising BYOA task assignment, wiki retrieval, and human review flows.',
    prefix: 'MKT',
    icon: 'Megaphone',
    color: '#0ea5e9',
    taskCounter: 16,
  });

  await db
    .insert(projectSpaces)
    .values({ project_id: marketingProject.id, space_id: marketingSpace.id })
    .onConflictDoNothing();

  await seedTasks({
    orgId: org.id,
    projectId: marketingProject.id,
    createdBy: diego.id,
    diegoId: diego.id,
    linaId: lina.id,
    sageId: sage.id,
    tomId: tom.id,
    mayaId: maya.id,
  });

  await seedSupplementalProjects({
    orgId: org.id,
    createdBy: diego.id,
    diegoId: diego.id,
    marigoldId: marigold.id,
    cesarId: cesar.id,
    linaId: lina.id,
    tomasId: tomas.id,
    sageId: sage.id,
    tomId: tom.id,
    mayaId: maya.id,
    operationsSpaceId: operationsSpace.id,
    buyerSpaceId: buyerSpace.id,
    fieldOpsSpaceId: fieldOpsSpace.id,
  });

  await seedWiki({
    orgId: org.id,
    spaceId: marketingSpace.id,
    diegoId: diego.id,
    linaId: lina.id,
    sageId: sage.id,
    tomasId: tomas.id,
    tomId: tom.id,
    mayaId: maya.id,
  });

  const pilotProofMessage = await seedMarketingMessage({ orgId: org.id, spaceId: marketingSpace.id, diegoId: diego.id });
  await seedRecordingNotes({
    orgId: org.id,
    marketingSpaceId: marketingSpace.id,
    operationsSpaceId: operationsSpace.id,
    buyerSpaceId: buyerSpace.id,
    diegoId: diego.id,
  });
  await seedOperatingDay({
    orgId: org.id,
    diegoId: diego.id,
  });
  await seedTeamHealth({
    orgId: org.id,
    generatedBy: diego.id,
    humans: [diego, marigold, cesar, lina, tomas, sage],
    tom,
    maya,
  });
  await seedPeopleAndTeamManagement({
    orgId: org.id,
    createdBy: diego.id,
    diego,
    marigold,
    cesar,
    lina,
    tomas,
    sage,
    tom,
    maya,
  });
  await cleanPilotActionNoise(org.id);
  await cleanReadState(org.id);
  const livedInConversations = await seedLivedInConversations({
    orgId: org.id,
    marketingSpaceId: marketingSpace.id,
    operationsSpaceId: operationsSpace.id,
    buyerSpaceId: buyerSpace.id,
    fieldOpsSpaceId: fieldOpsSpace.id,
    diegoId: diego.id,
    marigoldId: marigold.id,
    cesarId: cesar.id,
    linaId: lina.id,
    tomasId: tomas.id,
    sageId: sage.id,
    tomId: tom.id,
    mayaId: maya.id,
  });
  await seedPilotKnowledgeReceipts({
    orgId: org.id,
    convertedBy: diego.id,
    pilotProof: pilotProofMessage,
    livedIn: livedInConversations,
  });
  await seedAgentAndInboxActivity({
    orgId: org.id,
    diegoId: diego.id,
    tomUser: tom,
    mayaUser: maya,
    marketingSpaceId: marketingSpace.id,
  });
  await seedPersonalMcpAccess({
    orgId: org.id,
    diegoId: diego.id,
  });
  const reconciledCounters = await reconcileProjectTaskCountersForOrg(org.id);
  if (reconciledCounters.length > 0) {
    console.log(`[seed-pilot-workspace] reconciled ${reconciledCounters.length} project task counters`);
  }

  console.log('[seed-pilot-workspace] done');
  console.log(`[seed-pilot-workspace] proof phrase: ${PROOF_PHRASE}`);
  console.log(`[seed-pilot-workspace] Tom MCP token: ${TOM_TOKEN}`);
  console.log(`[seed-pilot-workspace] Maya MCP token: ${MAYA_TOKEN}`);
  console.log(`[seed-pilot-workspace] Diego MCP token: ${DIEGO_MCP_TOKEN}`);

  return {
    orgId: org.id,
    tomToken: TOM_TOKEN,
    mayaToken: MAYA_TOKEN,
    proofPhrase: PROOF_PHRASE,
  };
}

const entryPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] === entryPath ||
  process.argv[1]?.replace(/\\/g, '/') === entryPath.replace(/\\/g, '/');

if (invokedDirectly) {
  seedPilotWorkspace()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed-pilot-workspace] FAILED:', err);
      process.exit(1);
    });
}
