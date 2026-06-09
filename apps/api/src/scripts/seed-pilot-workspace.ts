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
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  agentEmployees,
  messages,
  notifications,
  orgMembers,
  orgs,
  projectSpaces,
  projects,
  spaceMembers,
  spaces,
  tasks,
  teamHealthSnapshots,
  users,
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
    task_counter: 4,
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
      task_counter: 4,
    })
    .returning(), `created project ${params.prefix}`);
  return created;
}

async function seedTasks(params: {
  orgId: string;
  projectId: string;
  createdBy: string;
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
