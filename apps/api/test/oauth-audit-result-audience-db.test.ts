import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

// Stored MCP idempotency results can hold whole message and notification rows
// from before those were deleted. Audit receipts (activity_query, /tokens,
// /history, OAuth grants) must not hand that stored text back.
const url = safeTestDatabaseUrl();
const unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const orgId = randomUUID();
const userId = randomUUID();
const spaceId = randomUUID();
const liveMessage = randomUUID();
const deletedMessage = randomUUID();
let client: pg.Client | undefined;
let seeded = false;

function toolResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  await client.query('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Audit result audience', 'audit-result-' + orgId]);
  await client.query("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Poster','human',false)", [userId, userId + '@example.test']);
  await client.query("INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')", [randomUUID(), orgId, userId]);
  await client.query("INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'audit-room','private',$3)", [spaceId, orgId, userId]);
  await client.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, userId]);
  await client.query("INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'Current live text')", [liveMessage, orgId, spaceId, userId]);
  await client.query("INSERT INTO messages(id,org_id,space_id,user_id,content,is_deleted) VALUES($1,$2,$3,$4,'CANARY-DELETED-POST',true)", [deletedMessage, orgId, spaceId, userId]);
  const rows: Array<[string, unknown]> = [
    ['message_post', { id: liveMessage, space_id: spaceId, content: 'CANARY-STORED-LIVE-COPY' }],
    ['send_message', { id: deletedMessage, space_id: spaceId, content: 'CANARY-DELETED-POST' }],
    ['inbox_mark_read', { id: randomUUID(), body: 'CANARY-OTHER-PERSON-REPLY' }],
  ];
  for (const [tool, result] of rows) {
    await client.query(`INSERT INTO oauth_audit_events(id,org_id,user_id,client_id,event,metadata)
      VALUES($1,$2,$3,'personal-token:audit','mcp_idempotency_result',$4::jsonb)`,
    [randomUUID(), orgId, userId, JSON.stringify({ tool_name: tool, fallback_signature: 'sig-' + tool, result: toolResult(result) })]);
  }
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await client.query('DELETE FROM oauth_audit_events WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id=$1', [spaceId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=$1', [userId]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

test('audit receipts never return stored result bodies; message previews come from the current readable row', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { humanActivityQuery } = await import('../src/lib/mcp-tools/human.js');
  const response = await humanActivityQuery({ limit: 10 }, {
    org_id: orgId, user_id: userId, role: 'member', client_id: 'personal-token:audit', scopes: ['read:workspace'],
  });
  assert.equal(response.isError ?? false, false, JSON.stringify(response));
  const text = response.content.map((part: any) => part.text).join('\n');
  for (const canary of ['CANARY-DELETED-POST', 'CANARY-OTHER-PERSON-REPLY', 'CANARY-STORED-LIVE-COPY']) {
    assert.ok(!text.includes(canary), canary + ' must not be returned');
  }
  const actions = JSON.parse(response.content[0].text) as Array<{ metadata: Record<string, unknown>; receipt: { target_id?: string; preview?: string } }>;
  assert.ok(actions.every((action) => !('result' in (action.metadata ?? {}))), 'raw metadata.result is dropped');
  assert.equal(actions.find((action) => action.receipt.target_id === liveMessage)?.receipt.preview, 'Current live text');
  assert.equal(actions.find((action) => action.receipt.target_id === deletedMessage)?.receipt.preview, undefined);

  // A poster who later leaves the private room loses the preview too.
  await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, userId]);
  const { enrichOAuthAuditActions } = await import('../src/lib/oauth-audit-receipts.js');
  const { rows } = await client!.query('SELECT id,event,metadata,created_at FROM oauth_audit_events WHERE org_id=$1', [orgId]);
  const enriched = await enrichOAuthAuditActions(orgId, userId, rows);
  assert.ok(!JSON.stringify(enriched).includes('Current live text'));
});
