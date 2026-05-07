/**
 * MCP send_message tool — covers all three target shapes and approval tier.
 * Phase 3 of agent-chat unification.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/mcp-send-message.test.ts
 *
 * Key implementation details verified here:
 *   - send_message is 'full' tier → queues on conservative/standard, auto-execs on autonomous
 *   - queued result shape: { status: 'queued_for_approval', approval_id, message }
 *   - auto-exec result shape: { message_id, space_id, user_id, content, parent_id, created_at }
 *   - empty target {} → isError: true (error path, not a structured code)
 *   - DM idempotency: second call to same user_id reuses the same space
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import {
  users,
  orgs,
  orgMembers,
  spaces,
  spaceMembers,
  messages,
  agentEmployees,
} from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { sendMessage } from '../src/lib/mcp-tools/writes.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

let orgId: string;
let humanUserId: string;
let agentUserId: string;
let agentEmployeeId: string;
let publicSpaceId: string;
const empSlug = `test-byoa-sendmsg-${Date.now()}`;

before(async () => {
  const [org] = await db
    .insert(orgs)
    .values({ name: 'sendmsg test', slug: `sm-${Date.now()}` })
    .returning();
  orgId = org!.id;

  const [human] = await db
    .insert(users)
    .values({
      email: `sm-h-${Date.now()}@test.local`,
      name: 'Human SM',
      kind: 'human',
      email_verified: true,
    })
    .returning();
  humanUserId = human!.id;

  const [agent] = await db
    .insert(users)
    .values({
      // agent shadow users have no email (nullable in schema)
      name: 'Test BYOA SM',
      kind: 'agent',
      is_agent: true,
      email_verified: true,
    })
    .returning();
  agentUserId = agent!.id;

  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: humanUserId, role: 'owner' },
    { org_id: orgId, user_id: agentUserId, role: 'member' },
  ]);

  const [employee] = await db
    .insert(agentEmployees)
    .values({
      org_id: orgId,
      user_id: agentUserId,
      name: 'Test BYOA SM',
      slug: empSlug,
      role: 'engineering_lead',
      system_prompt: 'test agent for send_message tests',
      trust_level: 'autonomous',
      is_byoa: true,
      created_by: agentUserId,
    })
    .returning();
  agentEmployeeId = employee!.id;

  const [space] = await db
    .insert(spaces)
    .values({
      org_id: orgId,
      name: 'general-sm',
      type: 'public',
      created_by: humanUserId,
    })
    .returning();
  publicSpaceId = space!.id;

  await db.insert(spaceMembers).values([
    { space_id: publicSpaceId, user_id: humanUserId },
    { space_id: publicSpaceId, user_id: agentUserId },
  ]);
});

after(async () => {
  try {
    // Delete messages in the public test space
    await db.delete(messages).where(eq(messages.space_id, publicSpaceId));
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, publicSpaceId));
    await db.delete(spaces).where(eq(spaces.id, publicSpaceId));

    // Clean DM spaces created during the test
    const dms = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.org_id, orgId), eq(spaces.type, 'dm')));
    for (const dm of dms) {
      await db.delete(messages).where(eq(messages.space_id, dm.id));
      await db.delete(spaceMembers).where(eq(spaceMembers.space_id, dm.id));
      await db.delete(spaces).where(eq(spaces.id, dm.id));
    }

    // agent_actions + action_receipts for this employee
    // action_receipts references agent_actions via FK so clear receipts first
    const { agentActions, actionReceipts } = await import('@deft/db/schema');
    await db.delete(actionReceipts).where(eq(actionReceipts.employee_id, agentEmployeeId));
    await db
      .delete(agentActions)
      .where(eq(agentActions.agent_employee_id, agentEmployeeId));

    await db.delete(agentEmployees).where(eq(agentEmployees.id, agentEmployeeId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(users).where(eq(users.id, humanUserId));
    await db.delete(users).where(eq(users.id, agentUserId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  } catch (err) {
    console.error('cleanup error', err);
  }
});

function mkCtx(trust: ToolContext['trust_level'] = 'autonomous'): ToolContext {
  return {
    org_id: orgId,
    employee_id: agentEmployeeId,
    employee_slug: empSlug,
    trust_level: trust,
  };
}

/**
 * Parse the textResult-wrapped JSON body.
 * ToolResult shape: { content: [{ type: 'text', text: string }], isError?: boolean }
 */
function parseResult(r: { content?: Array<{ type: string; text: string }>; isError?: boolean }): any {
  if (r?.content?.[0]?.text) {
    try {
      return JSON.parse(r.content[0].text);
    } catch {
      return r.content[0].text;
    }
  }
  return r;
}

// ─── Test 1: space_id target ──────────────────────────────────────────────

test('send_message with space_id target inserts a message in the space', async () => {
  const r = await sendMessage(
    { caller_employee_slug: empSlug, target: { space_id: publicSpaceId }, content: 'hello space' },
    mkCtx('autonomous'),
  );
  // Must not be an error
  assert.ok(!r.isError, `expected success, got error: ${r.content?.[0]?.text}`);

  const result = parseResult(r);
  // Must not be queued — autonomous trust unlocks full tier
  assert.notEqual(
    result.status,
    'queued_for_approval',
    `expected auto-execute on autonomous, got queued: ${JSON.stringify(result)}`,
  );

  assert.equal(result.space_id, publicSpaceId, 'space_id should match');
  assert.ok(result.message_id, 'should have message_id');

  const [row] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, result.message_id))
    .limit(1);
  assert.ok(row, 'message row should exist in DB');
  assert.equal(row?.content, 'hello space');
  assert.equal(row?.parent_id, null, 'top-level message should have no parent');
});

// ─── Test 2: thread_id target ────────────────────────────────────────────

test('send_message with thread_id target replies under the parent', async () => {
  // First, create a parent message
  const parentResp = await sendMessage(
    { caller_employee_slug: empSlug, target: { space_id: publicSpaceId }, content: 'parent msg' },
    mkCtx('autonomous'),
  );
  assert.ok(!parentResp.isError, `parent creation failed: ${parentResp.content?.[0]?.text}`);
  const parent = parseResult(parentResp);
  assert.ok(parent.message_id, 'parent should have message_id');

  // Now reply to the parent via thread_id
  const replyResp = await sendMessage(
    { caller_employee_slug: empSlug, target: { thread_id: parent.message_id }, content: 'thread reply' },
    mkCtx('autonomous'),
  );
  assert.ok(!replyResp.isError, `reply failed: ${replyResp.content?.[0]?.text}`);
  const reply = parseResult(replyResp);
  assert.ok(reply.message_id, 'reply should have message_id');

  const [row] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, reply.message_id))
    .limit(1);
  assert.ok(row, 'reply row should exist in DB');
  assert.equal(row?.parent_id, parent.message_id, 'reply parent_id should point to parent');
  assert.equal(row?.space_id, publicSpaceId, 'reply should be in the same space as the parent');
});

// ─── Test 3: user_id target creates DM ───────────────────────────────────

test('send_message with user_id target creates a DM space and posts there', async () => {
  const r = await sendMessage(
    { caller_employee_slug: empSlug, target: { user_id: humanUserId }, content: 'dm hello' },
    mkCtx('autonomous'),
  );
  assert.ok(!r.isError, `DM creation failed: ${r.content?.[0]?.text}`);
  const result = parseResult(r);
  assert.ok(result.space_id, 'result should have space_id');
  assert.ok(result.message_id, 'result should have message_id');

  const [space] = await db
    .select()
    .from(spaces)
    .where(eq(spaces.id, result.space_id))
    .limit(1);
  assert.ok(space, 'DM space should exist in DB');
  assert.equal(space?.type, 'dm', 'DM space type should be dm');

  const members = await db
    .select()
    .from(spaceMembers)
    .where(eq(spaceMembers.space_id, result.space_id));
  const memberIds = members.map((m) => m.user_id).sort();
  assert.deepEqual(memberIds, [agentUserId, humanUserId].sort(), 'DM space should have both users as members');
});

// ─── Test 4: DM idempotency ──────────────────────────────────────────────

test('send_message with user_id target reuses the same DM space on a second call', async () => {
  const r1 = parseResult(
    await sendMessage(
      { caller_employee_slug: empSlug, target: { user_id: humanUserId }, content: 'dm first' },
      mkCtx('autonomous'),
    ),
  );
  const r2 = parseResult(
    await sendMessage(
      { caller_employee_slug: empSlug, target: { user_id: humanUserId }, content: 'dm second' },
      mkCtx('autonomous'),
    ),
  );
  assert.ok(r1.space_id, 'first DM call should have space_id');
  assert.ok(r2.space_id, 'second DM call should have space_id');
  assert.equal(r1.space_id, r2.space_id, 'both calls should reuse the same DM space');
});

// ─── Test 5: unknown target shape → error ───────────────────────────────

test('send_message rejects an empty target shape with isError', async () => {
  const r = await sendMessage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { caller_employee_slug: empSlug, target: {} as any, content: 'oops' },
    mkCtx('autonomous'),
  );
  assert.ok(r.isError, 'empty target should produce isError: true');
  const text = r.content?.[0]?.text ?? '';
  assert.ok(
    text.includes('target must include') || text.includes('send_message'),
    `error message should mention target validation: "${text}"`,
  );
});

// ─── Test 6: approval tier — conservative queues ─────────────────────────

test('send_message queues for approval when trust is conservative', async () => {
  const r = await sendMessage(
    { caller_employee_slug: empSlug, target: { space_id: publicSpaceId }, content: 'needs approval' },
    mkCtx('conservative'),
  );
  // Must not be an isError
  assert.ok(!r.isError, `unexpected error on conservative: ${r.content?.[0]?.text}`);

  const result = parseResult(r);
  assert.equal(
    result.status,
    'queued_for_approval',
    `conservative trust must queue send_message (full-tier): got ${JSON.stringify(result)}`,
  );
  assert.ok(result.approval_id, 'queued result should have approval_id');
});
