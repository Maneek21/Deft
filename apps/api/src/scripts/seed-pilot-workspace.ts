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
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  agentEmployees,
  events,
  messages,
  notes,
  notifications,
  orgMembers,
  orgs,
  projectSpaces,
  projects,
  reminders,
  spaceMembers,
  spaces,
  standups,
  taskComments,
  tasks,
  teamHealthSnapshots,
  users,
  wikiLinks,
  wikiPages,
} from '@deft/db/schema';

const TOM_TOKEN = process.env.SEED_TOM_MCP_TOKEN ?? 'tom-pilot-mcp-token-2026';
const MAYA_TOKEN = process.env.SEED_MAYA_MCP_TOKEN ?? 'maya-pilot-mcp-token-2026';
const PROOF_PHRASE = 'ruby-sunrise-2026';

type SeedUser = typeof users.$inferSelect;
type SeedSpace = typeof spaces.$inferSelect;
type SeedProject = typeof projects.$inferSelect;

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
    task_counter: 16,
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
      icon: 'Megaphone',
      color: '#0ea5e9',
      lead_id: params.leadId,
      task_counter: 16,
    })
    .returning(), `created project ${params.prefix}`);
  return created;
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
  const seededTasks = [
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
}

async function seedWiki(params: { orgId: string; spaceId: string; diegoId: string; tomId: string; mayaId: string }) {
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
}

async function seedMarketingMessage(params: { orgId: string; spaceId: string; diegoId: string }) {
  const content =
    `Decision: for the clean pilot, Tom owns buyer-facing marketing copy and Maya owns weekly communications summaries. ` +
    `Use ${PROOF_PHRASE} as the fresh chat-to-wiki proof marker for this local environment.`;

  const existing = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.org_id, params.orgId), eq(messages.space_id, params.spaceId), eq(messages.content, content)))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(messages).values({
      org_id: params.orgId,
      space_id: params.spaceId,
      user_id: params.diegoId,
      content,
      metadata: { seed: 'pilot-polish', knowledge_marker: PROOF_PHRASE },
    });
  }
}

async function seedRecordingNote(params: { orgId: string; spaceId: string; diegoId: string }) {
  const title = 'Manual demo notes - Sun Gold launch';
  await db
    .delete(notes)
    .where(and(eq(notes.org_id, params.orgId), eq(notes.user_id, params.diegoId), eq(notes.title, title)));

  await db.insert(notes).values({
    org_id: params.orgId,
    user_id: params.diegoId,
    title,
    icon: 'Video',
    is_pinned: true,
    visibility: 'space',
    visibility_space_id: params.spaceId,
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
  });
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
      external_id: 'pilot-sun-gold-standup',
      title: 'Sun Gold launch standup',
      body: 'Review route capacity, buyer-readiness, and agent-owned copy tasks.',
      start: atToday(9, 15),
      end: atToday(9, 45),
      location: 'marketing space',
      attendees: ['Diego Vargas', 'Lina Bhattacharya', 'Tom', 'Maya'],
    },
    {
      external_id: 'pilot-route-capacity-check',
      title: 'Route capacity check with Tomas',
      body: 'Confirm whether Tuesday delivery can be promised for the Sun Gold buyer trial.',
      start: atToday(11, 30),
      end: atToday(12, 0),
      location: 'Packing shed',
      attendees: ['Diego Vargas', 'Tomas'],
    },
    {
      external_id: 'pilot-chef-amara-call',
      title: 'Chef Amara sample-box call',
      body: 'Align sample size, delivery timing, and flavor notes for the first Sun Gold box.',
      start: atToday(15, 0),
      end: atToday(15, 30),
      location: 'Phone',
      attendees: ['Diego Vargas', 'Chef Amara'],
    },
    {
      external_id: 'pilot-launch-review',
      title: 'Buyer copy review with Lina and Sage',
      body: 'Review Tom draft, cold-chain wording, and food-safety claims before buyer send.',
      start: atToday(16, 15),
      end: atToday(17, 0),
      location: 'Deft task board',
      attendees: ['Diego Vargas', 'Lina Bhattacharya', 'Sage Nakamura', 'Tom'],
    },
    {
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
        source: 'native',
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

  const publicSpaces = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.org_id, org.id), eq(spaces.type, 'public'), eq(spaces.is_archived, false)));

  await ensureSpaceMembers(
    [...new Set([...publicSpaces.map((space) => space.id), marketingSpace.id])],
    [diego.id, marigold.id, cesar.id, lina.id, tomas.id, sage.id, tom.id, maya.id],
  );

  const marketingProject = await ensureProject({
    orgId: org.id,
    leadId: lina.id,
    name: 'Pilot Marketing Launch',
    description:
      'A clean local project for exercising BYOA task assignment, wiki retrieval, and human review flows.',
    prefix: 'MKT',
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

  await seedWiki({
    orgId: org.id,
    spaceId: marketingSpace.id,
    diegoId: diego.id,
    tomId: tom.id,
    mayaId: maya.id,
  });

  await seedMarketingMessage({ orgId: org.id, spaceId: marketingSpace.id, diegoId: diego.id });
  await seedRecordingNote({ orgId: org.id, spaceId: marketingSpace.id, diegoId: diego.id });
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
  await cleanReadState(org.id);

  console.log('[seed-pilot-workspace] done');
  console.log(`[seed-pilot-workspace] proof phrase: ${PROOF_PHRASE}`);
  console.log(`[seed-pilot-workspace] Tom MCP token: ${TOM_TOKEN}`);
  console.log(`[seed-pilot-workspace] Maya MCP token: ${MAYA_TOKEN}`);

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
