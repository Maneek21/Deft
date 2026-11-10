/**
 * W1h — a BYOA agent employee's own chat messages post without approval at
 * every trust level (owner decision 2026-11-10). Everything else the
 * employee writes stays on its own trust level, and every existing guard
 * rail on the message path (space visibility, reply-storm detector, daily
 * action cap, active/healthy employee, Defty exclusion) still applies.
 *
 * Drives the real MCP v1 route (`/api/mcp/v1/tools/call`) so the daily
 * action cap in `dispatchTool` is exercised, plus direct handler calls where
 * the route is not the subject.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  actionReceipts,
  agentActions,
  agentEmployees,
  messages,
  orgMembers,
  orgs,
  projects,
  spaceMembers,
  spaces,
  tasks,
  users,
  wikiPages,
} from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { issueEmployeeToken } from '../src/lib/mcp-token.js';
import { mcpServerV1Routes } from '../src/routes/mcp-server-v1.js';
import { messagePost, sendMessage } from '../src/lib/mcp-tools/writes.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';
import { DEFTY_SYSTEM_EMPLOYEE_SLUG, DEFTY_SYSTEM_RUNTIME_KIND } from '../src/lib/defty-identity.js';

type Trust = 'conservative' | 'standard' | 'autonomous';

const run = randomUUID().slice(0, 8);
const orgId = `w1h-org-${run}`;
const ownerId = `w1h-owner-${run}`;
const peerId = `w1h-peer-${run}`;
const outsiderId = `w1h-outsider-${run}`;
const publicSpaceId = `w1h-public-${run}`;
const hiddenSpaceId = `w1h-hidden-${run}`;
const projectId = `w1h-project-${run}`;
const deftyUserId = `w1h-defty-user-${run}`;
const deftyEmployeeId = `w1h-defty-emp-${run}`;

const employees: Record<Trust, { id: string; userId: string; slug: string; token: string }> = {
  conservative: { id: `w1h-emp-cons-${run}`, userId: `w1h-u-cons-${run}`, slug: `w1h-cons-${run}`, token: '' },
  standard: { id: `w1h-emp-std-${run}`, userId: `w1h-u-std-${run}`, slug: `w1h-std-${run}`, token: '' },
  autonomous: { id: `w1h-emp-auto-${run}`, userId: `w1h-u-auto-${run}`, slug: `w1h-auto-${run}`, token: '' },
};
const TRUSTS: Trust[] = ['conservative', 'standard', 'autonomous'];
const employeeIds = () => TRUSTS.map((t) => employees[t].id);
const employeeUserIds = () => TRUSTS.map((t) => employees[t].userId);

const app = new Hono();
app.route('/api/mcp/v1', mcpServerV1Routes);

before(async () => {
  await db.insert(orgs).values({ id: orgId, name: 'W1h org', slug: `w1h-${run}` });
  await db.insert(users).values([
    { id: ownerId, email: `w1h-owner-${run}@test.local`, name: 'W1h Owner', kind: 'human', email_verified: true },
    { id: peerId, email: `w1h-peer-${run}@test.local`, name: 'W1h Peer', kind: 'human', email_verified: true },
    { id: outsiderId, email: `w1h-outsider-${run}@test.local`, name: 'W1h Outsider', kind: 'human', email_verified: true },
    ...TRUSTS.map((t) => ({ id: employees[t].userId, name: `W1h ${t}`, kind: 'agent' as const, is_agent: true, email_verified: true })),
    { id: deftyUserId, name: 'W1h Defty', kind: 'agent' as const, is_agent: true, email_verified: true },
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: ownerId, role: 'owner' },
    { org_id: orgId, user_id: peerId, role: 'member' },
    ...TRUSTS.map((t) => ({ org_id: orgId, user_id: employees[t].userId, role: 'member' as const })),
  ]);
  for (const t of TRUSTS) {
    await db.insert(agentEmployees).values({
      id: employees[t].id,
      org_id: orgId,
      user_id: employees[t].userId,
      name: `W1h ${t}`,
      slug: employees[t].slug,
      role: 'project_manager',
      system_prompt: 'W1h test employee',
      trust_level: t,
      is_byoa: true,
      is_active: true,
      max_daily_actions: 500,
      created_by: ownerId,
    });
    employees[t].token = await issueEmployeeToken(orgId, employees[t].id);
  }
  // A canonical Defty system employee row in this org (the shape the
  // in-process Defty principal uses). It must never inherit the exemption.
  await db.insert(agentEmployees).values({
    id: deftyEmployeeId,
    org_id: orgId,
    user_id: deftyUserId,
    name: 'Defty',
    slug: DEFTY_SYSTEM_EMPLOYEE_SLUG,
    role: 'superintendent',
    system_prompt: 'W1h Defty system employee',
    trust_level: 'conservative',
    is_byoa: false,
    runtime_kind: DEFTY_SYSTEM_RUNTIME_KIND,
    is_active: true,
    created_by: ownerId,
  });
  await db.insert(spaces).values([
    { id: publicSpaceId, org_id: orgId, name: 'w1h-general', type: 'public', created_by: ownerId },
    { id: hiddenSpaceId, org_id: orgId, name: 'w1h-hidden', type: 'private', created_by: ownerId },
  ]);
  await db.insert(spaceMembers).values([
    { space_id: publicSpaceId, user_id: ownerId },
    { space_id: hiddenSpaceId, user_id: ownerId },
  ]);
  await db.insert(projects).values({ id: projectId, org_id: orgId, name: 'W1h project', prefix: `W1H${run.slice(0, 3).toUpperCase()}`, lead_id: ownerId });
});

after(async () => {
  try {
    const allEmployeeIds = [...employeeIds(), deftyEmployeeId];
    const allAgentUserIds = [...employeeUserIds(), deftyUserId];
    await db.delete(actionReceipts).where(inArray(actionReceipts.employee_id, allEmployeeIds));
    await db.delete(agentActions).where(eq(agentActions.org_id, orgId));
    await db.delete(messages).where(eq(messages.org_id, orgId));
    await db.delete(wikiPages).where(eq(wikiPages.org_id, orgId));
    await db.delete(tasks).where(eq(tasks.org_id, orgId));
    await db.delete(projects).where(eq(projects.org_id, orgId));
    const orgSpaces = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.org_id, orgId));
    if (orgSpaces.length > 0) {
      await db.delete(spaceMembers).where(inArray(spaceMembers.space_id, orgSpaces.map((s) => s.id)));
    }
    await db.delete(spaces).where(eq(spaces.org_id, orgId));
    await db.execute(sql`DELETE FROM mcp_tokens WHERE org_id = ${orgId}`);
    await db.delete(agentEmployees).where(inArray(agentEmployees.id, allEmployeeIds));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(inArray(users.id, [ownerId, peerId, outsiderId, ...allAgentUserIds]));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  } catch (err) {
    console.error('[W1h] cleanup error', err);
  }
});

async function mcpCall(trust: Trust, tool: string, args: Record<string, unknown>) {
  const res = await app.request('/api/mcp/v1/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${employees[trust].token}` },
    body: JSON.stringify({ name: tool, arguments: { caller_employee_slug: employees[trust].slug, ...args } }),
  });
  const body = (await res.json()) as any;
  let parsed: any = null;
  const text = body?.content?.[0]?.text;
  if (typeof text === 'string') {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body, parsed, text: typeof text === 'string' ? text : '' };
}

function ctxFor(trust: Trust): ToolContext {
  return { org_id: orgId, employee_id: employees[trust].id, employee_slug: employees[trust].slug, trust_level: trust };
}

async function messagesWithContent(content: string) {
  return db.select().from(messages).where(and(eq(messages.org_id, orgId), eq(messages.content, content)));
}

async function pendingActionsWithContent(employeeId: string, content: string) {
  const rows = await db.select().from(agentActions).where(and(
    eq(agentActions.agent_employee_id, employeeId),
    eq(agentActions.approval_status, 'pending'),
  ));
  return rows.filter((row) => (row.params as Record<string, unknown> | null)?.content === content);
}

/** The post is a real message row by the employee's shadow user, with no
 * pending approval, and the same auto-executed action-log row + receipt an
 * Autonomous post produces. */
async function assertPostedWithoutApproval(trust: Trust, toolName: 'send_message' | 'message_post', content: string, result: any) {
  assert.notEqual(result?.status, 'queued_for_approval', `${trust} ${toolName} must not queue: ${JSON.stringify(result)}`);
  const rows = await messagesWithContent(content);
  assert.equal(rows.length, 1, `${trust} ${toolName} must create exactly one message row`);
  assert.equal(rows[0]!.user_id, employees[trust].userId, 'message is authored by the employee shadow user');
  assert.equal((await pendingActionsWithContent(employees[trust].id, content)).length, 0, 'no pending approval row');
  const logged = (await db.select().from(agentActions).where(and(
    eq(agentActions.agent_employee_id, employees[trust].id),
    eq(agentActions.action, toolName),
    eq(agentActions.approval_status, 'approved'),
  ))).filter((row) => (row.params as Record<string, unknown> | null)?.content === content);
  assert.equal(logged.length, 1, 'one auto-executed action-log row');
  assert.ok(logged[0]!.executed_at, 'action-log row is marked executed');
  const receipts = await db.select().from(actionReceipts).where(eq(actionReceipts.action_id, logged[0]!.id));
  assert.equal(receipts.length, 1, 'one receipt for the auto-executed post');
  assert.equal(receipts[0]!.decision, 'auto_executed');
  return rows[0]!;
}

// ─── Posting at every trust level ─────────────────────────────────────────

for (const trust of TRUSTS) {
  const label = trust[0]!.toUpperCase() + trust.slice(1);
  test(`W1h: a ${label} employee's send_message to a space posts without approval`, async () => {
    const content = `w1h space ${trust} ${randomUUID()}`;
    const { status, parsed } = await mcpCall(trust, 'send_message', { target: { space_id: publicSpaceId }, content });
    assert.equal(status, 200);
    await assertPostedWithoutApproval(trust, 'send_message', content, parsed);
  });
}

for (const trust of ['conservative', 'standard'] as const) {
  const label = trust[0]!.toUpperCase() + trust.slice(1);

  test(`W1h: a ${label} employee's send_message thread reply posts without approval`, async () => {
    const [root] = await db.insert(messages).values({
      org_id: orgId, space_id: publicSpaceId, user_id: ownerId, content: `w1h root ${randomUUID()}`,
    }).returning();
    const content = `w1h thread ${trust} ${randomUUID()}`;
    const { parsed } = await mcpCall(trust, 'send_message', { target: { thread_id: root!.id }, content });
    const row = await assertPostedWithoutApproval(trust, 'send_message', content, parsed);
    assert.equal(row.parent_id, root!.id);
    assert.equal(row.space_id, publicSpaceId);
  });

  test(`W1h: a ${label} employee's send_message DM posts without approval`, async () => {
    const content = `w1h dm ${trust} ${randomUUID()}`;
    const { parsed } = await mcpCall(trust, 'send_message', { target: { user_id: peerId }, content });
    const row = await assertPostedWithoutApproval(trust, 'send_message', content, parsed);
    const [space] = await db.select().from(spaces).where(eq(spaces.id, row.space_id));
    assert.equal(space?.type, 'dm');
    const members = (await db.select().from(spaceMembers).where(eq(spaceMembers.space_id, row.space_id)))
      .map((m) => m.user_id).sort();
    assert.deepEqual(members, [employees[trust].userId, peerId].sort(), 'DM has exactly the employee and the target');
    // Existing DM rule: a second DM to the same person reuses the space.
    const again = `w1h dm again ${trust} ${randomUUID()}`;
    const second = await mcpCall(trust, 'send_message', { target: { user_id: peerId }, content: again });
    assert.equal(second.parsed?.space_id, row.space_id);
  });

  test(`W1h: a ${label} employee's message_post posts without approval`, async () => {
    const content = `w1h message_post ${trust} ${randomUUID()}`;
    const { parsed } = await mcpCall(trust, 'message_post', { space_id: publicSpaceId, content });
    await assertPostedWithoutApproval(trust, 'message_post', content, parsed);
  });

  test(`W1h: a ${label} employee's message_post thread reply posts without approval`, async () => {
    const [root] = await db.insert(messages).values({
      org_id: orgId, space_id: publicSpaceId, user_id: ownerId, content: `w1h mp root ${randomUUID()}`,
    }).returning();
    const content = `w1h message_post thread ${trust} ${randomUUID()}`;
    const { parsed } = await mcpCall(trust, 'message_post', { space_id: publicSpaceId, parent_id: root!.id, content });
    const row = await assertPostedWithoutApproval(trust, 'message_post', content, parsed);
    assert.equal(row.parent_id, root!.id);
  });
}

// ─── Nothing else widened ─────────────────────────────────────────────────

test('W1h: task_create by a Conservative employee still queues for approval', async () => {
  const title = `w1h task ${randomUUID()}`;
  const { parsed } = await mcpCall('conservative', 'task_create', { title, project_id: projectId });
  assert.equal(parsed?.status, 'queued_for_approval');
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, parsed.approval_id));
  assert.equal(row?.approval_status, 'pending');
  assert.equal(row?.action, 'task_create');
  assert.equal((await db.select().from(tasks).where(and(eq(tasks.org_id, orgId), eq(tasks.title, title)))).length, 0);
});

test('W1h: wiki_create by a Conservative employee still queues for approval', async () => {
  const title = `w1h wiki ${randomUUID()}`;
  const { parsed } = await mcpCall('conservative', 'wiki_create', { title, content: 'w1h wiki body' });
  assert.equal(parsed?.status, 'queued_for_approval');
  assert.equal((await db.select().from(wikiPages).where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.title, title)))).length, 0);
});

test('W1h: the Defty system employee does not inherit the exemption (Defty chat stays approval-only)', async () => {
  const deftyCtx: ToolContext = {
    org_id: orgId, employee_id: deftyEmployeeId, employee_slug: DEFTY_SYSTEM_EMPLOYEE_SLUG, trust_level: 'conservative',
  };
  const content = `w1h defty ${randomUUID()}`;
  const result = await sendMessage({ caller_employee_slug: DEFTY_SYSTEM_EMPLOYEE_SLUG, target: { space_id: publicSpaceId }, content }, deftyCtx);
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.status, 'queued_for_approval');
  assert.equal((await messagesWithContent(content)).length, 0);
  const posted = await messagePost({ caller_employee_slug: DEFTY_SYSTEM_EMPLOYEE_SLUG, space_id: publicSpaceId, content: `${content} mp` }, deftyCtx);
  assert.equal(JSON.parse(posted.content[0]!.text).status, 'queued_for_approval');
});

test('W1h: unexpected message parameters keep the existing trust gate', async () => {
  const content = `w1h mode ${randomUUID()}`;
  const { parsed } = await mcpCall('conservative', 'send_message', { target: { space_id: publicSpaceId }, content, mode: 'delete' });
  assert.equal(parsed?.status, 'queued_for_approval');
  assert.equal((await messagesWithContent(content)).length, 0);
});

// ─── Guard rails still apply ──────────────────────────────────────────────

test('W1h: a Conservative employee still cannot post into a private space it has not joined', async () => {
  const content = `w1h hidden ${randomUUID()}`;
  const viaSend = await mcpCall('conservative', 'send_message', { target: { space_id: hiddenSpaceId }, content });
  assert.equal(viaSend.body.isError, true);
  assert.match(viaSend.text, /not accessible/);
  const viaPost = await mcpCall('conservative', 'message_post', { space_id: hiddenSpaceId, content });
  assert.equal(viaPost.body.isError, true);
  assert.equal((await messagesWithContent(content)).length, 0);
  assert.equal((await pendingActionsWithContent(employees.conservative.id, content)).length, 0);
});

test('W1h: a Conservative employee cannot reply into a thread in a private space it has not joined', async () => {
  const [root] = await db.insert(messages).values({
    org_id: orgId, space_id: hiddenSpaceId, user_id: ownerId, content: `w1h hidden root ${randomUUID()}`,
  }).returning();
  const content = `w1h hidden reply ${randomUUID()}`;
  const { body } = await mcpCall('conservative', 'send_message', { target: { thread_id: root!.id }, content });
  assert.equal(body.isError, true);
  assert.equal((await messagesWithContent(content)).length, 0);
});

test('W1h: the reply-storm detector still returns STORM_DETECTED for a Conservative employee', async () => {
  const [root] = await db.insert(messages).values({
    org_id: orgId, space_id: publicSpaceId, user_id: ownerId, content: `w1h storm root ${randomUUID()}`,
  }).returning();
  for (let i = 0; i < 5; i++) {
    await db.insert(messages).values({
      org_id: orgId, space_id: publicSpaceId, user_id: employees.conservative.userId,
      content: `w1h storm seed ${i}`, parent_id: root!.id,
    });
  }
  const content = `w1h storm ${randomUUID()}`;
  const viaSend = await mcpCall('conservative', 'send_message', { target: { thread_id: root!.id }, content });
  assert.equal(viaSend.body.isError, true);
  assert.match(viaSend.text, /STORM_DETECTED/);
  // message_post thread replies now pass through the same detector.
  const viaPost = await mcpCall('conservative', 'message_post', { space_id: publicSpaceId, parent_id: root!.id, content });
  assert.equal(viaPost.body.isError, true);
  assert.match(viaPost.text, /STORM_DETECTED/);
  assert.equal((await messagesWithContent(content)).length, 0);
});

test('W1h: the daily action cap still applies to and counts a Conservative employee message', async () => {
  const id = employees.conservative.id;
  const [beforeRow] = await db.select({ count: agentEmployees.daily_action_count }).from(agentEmployees).where(eq(agentEmployees.id, id));
  const content = `w1h cap counted ${randomUUID()}`;
  const ok = await mcpCall('conservative', 'send_message', { target: { space_id: publicSpaceId }, content });
  assert.notEqual(ok.body.isError, true, ok.text);
  const [afterRow] = await db.select({ count: agentEmployees.daily_action_count }).from(agentEmployees).where(eq(agentEmployees.id, id));
  assert.equal(afterRow!.count, beforeRow!.count + 1, 'the message consumed one daily action slot');

  await db.update(agentEmployees).set({ max_daily_actions: afterRow!.count }).where(eq(agentEmployees.id, id));
  try {
    const blocked = `w1h cap blocked ${randomUUID()}`;
    const res = await mcpCall('conservative', 'send_message', { target: { space_id: publicSpaceId }, content: blocked });
    assert.equal(res.body.isError, true);
    assert.match(res.text, /Daily action limit reached/);
    assert.equal((await messagesWithContent(blocked)).length, 0);
    const res2 = await mcpCall('conservative', 'message_post', { space_id: publicSpaceId, content: blocked });
    assert.equal(res2.body.isError, true);
    assert.equal((await messagesWithContent(blocked)).length, 0);
  } finally {
    await db.update(agentEmployees).set({ max_daily_actions: 500 }).where(eq(agentEmployees.id, id));
  }
});

test('W1h: an unhealthy (circuit-broken) Conservative employee cannot post without approval', async () => {
  const id = employees.conservative.id;
  await db.update(agentEmployees).set({ unhealthy: true, unhealthy_reason: 'w1h test' }).where(eq(agentEmployees.id, id));
  try {
    const content = `w1h unhealthy ${randomUUID()}`;
    const viaSend = await mcpCall('conservative', 'send_message', { target: { space_id: publicSpaceId }, content });
    assert.equal(viaSend.parsed?.status, 'queued_for_approval');
    const viaPost = await mcpCall('conservative', 'message_post', { space_id: publicSpaceId, content });
    assert.equal(viaPost.parsed?.status, 'queued_for_approval');
    assert.equal((await messagesWithContent(content)).length, 0, 'nothing was posted');
  } finally {
    await db.update(agentEmployees).set({ unhealthy: false, unhealthy_reason: null }).where(eq(agentEmployees.id, id));
  }
});

test('W1h: a deactivated employee cannot post', async () => {
  const id = employees.conservative.id;
  await db.update(agentEmployees).set({ is_active: false }).where(eq(agentEmployees.id, id));
  try {
    const content = `w1h inactive ${randomUUID()}`;
    const res = await mcpCall('conservative', 'send_message', { target: { space_id: publicSpaceId }, content });
    assert.notEqual(res.status, 200);
    // A stale in-process context (deactivated after auth) does not post either.
    const direct = await sendMessage({ caller_employee_slug: employees.conservative.slug, target: { space_id: publicSpaceId }, content }, ctxFor('conservative'));
    const directParsed = direct.isError ? null : JSON.parse(direct.content[0]!.text);
    assert.ok(direct.isError || directParsed?.status === 'queued_for_approval', JSON.stringify(direct));
    assert.equal((await messagesWithContent(content)).length, 0);
  } finally {
    await db.update(agentEmployees).set({ is_active: true }).where(eq(agentEmployees.id, id));
  }
});

test('W1h: a Conservative employee cannot open a DM with someone outside the workspace', async () => {
  const content = `w1h outsider ${randomUUID()}`;
  const res = await mcpCall('conservative', 'send_message', { target: { user_id: outsiderId }, content });
  assert.equal(res.body.isError, true);
  assert.equal((await messagesWithContent(content)).length, 0);
  const dmWithOutsider = await db.execute(sql`SELECT s.id FROM spaces s JOIN space_members m ON m.space_id = s.id
    WHERE s.org_id = ${orgId} AND m.user_id = ${outsiderId}`);
  assert.equal(dmWithOutsider.rows.length, 0, 'no DM space was created with a non-member');
});
