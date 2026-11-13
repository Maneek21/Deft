/**
 * Personal MCP approve and reject check the caller again before returning:
 * a caller who loses the right while the decision runs gets nothing about the
 * action back. The resolver is replaced by a stub that removes the caller's
 * access mid-call.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/approval-mcp-decision-recheck-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import pg from 'pg';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const userId = randomUUID();
const spaceId = randomUUID();
let client: pg.Client | undefined;
let duringDecision: (actionId: string) => Promise<void> = async () => {};
let human: typeof import('../src/lib/mcp-tools/human.js');

before(async () => {
  if (!url) return;
  const actual = await import('../src/lib/agent-approval-resolver.js');
  mock.module(new URL('../src/lib/agent-approval-resolver.ts', import.meta.url).href, {
    namedExports: {
      ...actual,
      approveAction: async (actionId: string) => {
        await duringDecision(actionId);
        return { status: 'approved', result: { canary: 'AL1-DECIDED-CANARY' } };
      },
      rejectAction: async (actionId: string) => {
        await duringDecision(actionId);
        return { status: 'rejected', message: 'AL1-DECIDED-CANARY' };
      },
    },
  });
  human = await import('../src/lib/mcp-tools/human.js');
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [orgId, 'AL1 recheck', `al1-recheck-${orgId.slice(0, 8)}`]);
  await client.query(`INSERT INTO users (id, email, name, kind, is_agent) VALUES ($1, $2, 'AL1 requester', 'human', false)`,
    [userId, `${userId}@example.test`]);
  await client.query(`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')`, [randomUUID(), orgId, userId]);
  await client.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'al1-recheck', 'private', $3)`,
    [spaceId, orgId, userId]);
});

after(async () => {
  mock.restoreAll();
  if (!client) return;
  for (const table of ['oauth_audit_events', 'agent_actions', 'org_members']) {
    await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]).catch(() => undefined);
  }
  await client.query('DELETE FROM space_members WHERE space_id = $1', [spaceId]).catch(() => undefined);
  await client.query('DELETE FROM spaces WHERE id = $1', [spaceId]).catch(() => undefined);
  await client.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => undefined);
  await client.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => undefined);
  await client.end();
  const { closeDb } = await import('../src/lib/db.js');
  await closeDb();
});

/** A pending capture of the requester's message in the room, with the requester in the room. */
async function capture(): Promise<string> {
  const id = randomUUID();
  await client!.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [randomUUID(), spaceId, userId]);
  await client!.query(
    `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, 'defty_capture', 'wiki_create', $4::jsonb, 'quick', 'pending')`,
    [id, orgId, userId, JSON.stringify({ title: 'AL1 recheck', source_space_id: spaceId, source_user_id: userId })],
  );
  return id;
}

const ctx = () => ({ org_id: orgId, user_id: userId, role: 'member' as const, scopes: ['read:workspace', 'write:workspace'] });
const text = (result: { content?: Array<{ text?: string }> }) => (result.content ?? []).map((part) => part.text ?? '').join('');

test('AL1-R1: a caller who leaves the room while approving or rejecting gets nothing back', { skip: !url }, async () => {
  duringDecision = async () => { await client!.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, userId]); };
  for (const decide of [human.humanApprovalApprove, human.humanApprovalReject]) {
    for (const idempotency of [{ idempotency_key: `al1-${randomUUID()}` }, {}]) {
      const actionId = await capture();
      const result = await decide({ action_id: actionId, ...idempotency }, ctx());
      assert.equal(result.isError, true);
      assert.equal(text(result).includes('AL1-DECIDED-CANARY'), false);
    }
  }
});

test('AL1-R2: a caller who keeps the right gets the decision', { skip: !url }, async () => {
  duringDecision = async () => {};
  const actionId = await capture();
  // Approval returns the decision's result (rejection answers with its status only, as on the web).
  const result = await human.humanApprovalApprove({ action_id: actionId }, ctx());
  assert.notEqual(result.isError, true, text(result));
  assert.equal(text(result).includes('AL1-DECIDED-CANARY'), true);
});
