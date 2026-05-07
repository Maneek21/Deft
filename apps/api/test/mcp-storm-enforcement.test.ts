// apps/api/test/mcp-storm-enforcement.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import {
  users, orgs, orgMembers, spaces, spaceMembers, messages, agentEmployees, actionReceipts, agentActions,
} from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { sendMessage } from '../src/lib/mcp-tools/writes.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

let testOrgId: string;
let agentUserId: string;
let humanUserId: string;
let employeeId: string;
let spaceId: string;
let threadRootId: string;
const createdMessageIds: string[] = [];

before(async () => {
  const ts = Date.now();
  const [org] = await db.insert(orgs).values({ name: `mcpstorm-${ts}`, slug: `mcpstorm-${ts}` }).returning();
  testOrgId = org.id;

  const [agentUser] = await db.insert(users).values({
    email: `mcpstorm-${ts}@test.com`, name: 'MCP Storm Agent', org_id: testOrgId, kind: 'agent',
  }).returning();
  agentUserId = agentUser.id;

  const [human] = await db.insert(users).values({
    email: `mcpstorm-h-${ts}@test.com`, name: 'Human', org_id: testOrgId, kind: 'human',
  }).returning();
  humanUserId = human.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: agentUserId, role: 'member' },
    { org_id: testOrgId, user_id: humanUserId, role: 'owner' },
  ]);

  const [emp] = await db.insert(agentEmployees).values({
    org_id: testOrgId, user_id: agentUserId, name: 'MCP Storm Agent', slug: `mcp-storm-${ts}`,
    role: 'engineering_lead', system_prompt: 'Test agent', created_by: humanUserId, is_active: true, trust_level: 'autonomous', is_byoa: true,
  }).returning();
  employeeId = emp.id;

  const [space] = await db.insert(spaces).values({
    name: 'mcp-storm-space', type: 'public', org_id: testOrgId, created_by: humanUserId,
  }).returning();
  spaceId = space.id;
  await db.insert(spaceMembers).values([
    { space_id: spaceId, user_id: humanUserId },
    { space_id: spaceId, user_id: agentUserId },
  ]);

  const [root] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'thread root',
  }).returning();
  threadRootId = root.id;
  createdMessageIds.push(root.id);
});

after(async () => {
  if (createdMessageIds.length) {
    await db.delete(messages).where(inArray(messages.id, createdMessageIds));
  }
  await db.delete(messages).where(eq(messages.space_id, spaceId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(actionReceipts).where(eq(actionReceipts.employee_id, employeeId));
  await db.delete(agentActions).where(eq(agentActions.agent_employee_id, employeeId));
  await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
  await db.delete(users).where(inArray(users.id, [agentUserId, humanUserId]));
  await db.delete(orgs).where(eq(orgs.id, testOrgId));
});

const ctx = (): ToolContext => ({
  org_id: testOrgId,
  employee_id: employeeId,
  employee_slug: `mcp-storm-test`,
  trust_level: 'autonomous',
});

test('sendMessage thread branch with 5 prior agent replies → STORM_DETECTED', async () => {
  for (let i = 0; i < 5; i++) {
    const [m] = await db.insert(messages).values({
      org_id: testOrgId, space_id: spaceId, user_id: agentUserId,
      content: `seed reply ${i}`, parent_id: threadRootId,
    }).returning();
    createdMessageIds.push(m.id);
  }

  const r = await sendMessage(
    { caller_employee_slug: 'mcp-storm-test', target: { thread_id: threadRootId }, content: 'one more' },
    ctx(),
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /STORM_DETECTED/);
});

test('sendMessage space_id branch is NOT throttled even after 5 replies', async () => {
  const r = await sendMessage(
    { caller_employee_slug: 'mcp-storm-test', target: { space_id: spaceId }, content: 'top-level' },
    ctx(),
  );
  if (r.isError) {
    assert.doesNotMatch(r.content[0]!.text, /STORM_DETECTED/);
  }
});

test('sendMessage thread branch with 4 prior agent replies → succeeds (or queued)', async () => {
  const [root] = await db.insert(messages).values({
    org_id: testOrgId, space_id: spaceId, user_id: humanUserId, content: 'fresh thread',
  }).returning();
  createdMessageIds.push(root.id);

  for (let i = 0; i < 4; i++) {
    const [m] = await db.insert(messages).values({
      org_id: testOrgId, space_id: spaceId, user_id: agentUserId,
      content: `seed ${i}`, parent_id: root.id,
    }).returning();
    createdMessageIds.push(m.id);
  }

  const r = await sendMessage(
    { caller_employee_slug: 'mcp-storm-test', target: { thread_id: root.id }, content: 'fifth' },
    ctx(),
  );
  if (r.isError) {
    assert.doesNotMatch(r.content[0]!.text, /STORM_DETECTED/);
  }
});
