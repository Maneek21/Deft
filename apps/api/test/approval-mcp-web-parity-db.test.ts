/**
 * The personal MCP approval and attention tools behave as the web: approve and
 * reject run the web's own decision functions (same rows, messages and
 * refusals), a decision needs the action's source, a stored result answers
 * only the same action or attention item, and the attention digest lists the
 * approvals the web shows the user.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/approval-mcp-web-parity-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import type { ToolResult } from '../src/lib/mcp-tools/types.js';

const url = safeTestDatabaseUrl();
const s = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const [bob, carol, mallory, gina, dave, agentUser] = Array.from({ length: 6 }, () => randomUUID());
const roles: Record<string, string> = { [bob]: 'owner', [carol]: 'admin', [mallory]: 'member', [gina]: 'guest', [dave]: 'admin' };
const employeeId = randomUUID();
const [roomId, hiddenRoomId, sideRoomId] = [randomUUID(), randomUUID(), randomUUID()];
const sourceMessageId = randomUUID();
const fileId = randomUUID();
const projectId = randomUUID();
let client: pg.Client;
let app: Hono;
let human: typeof import('../src/lib/mcp-tools/human.js');
let documentSend: typeof import('../src/lib/mcp-tools/document-send.js').documentSend;
let workspacePlanImport: typeof import('../src/lib/mcp-tools/workspace-plan-import.js').workspacePlanImport;
let defty: { userId: string; employeeId: string };
let webUser = bob;

const employeeCtx = () => ({ org_id: orgId, employee_id: employeeId, employee_slug: `parity-${s}`, trust_level: 'autonomous' as const });
const ctx = (userId: string, org = orgId) => ({
  org_id: org, user_id: userId, role: roles[userId] as 'owner', scopes: ['read:workspace', 'write:workspace'], token_id: `parity-${s}`,
});
const text = (r: ToolResult) => (r.content ?? []).map((p) => p.text ?? '').join('');
const json = (r: ToolResult) => JSON.parse(text(r));
const q = (sqlText: string, params: unknown[] = []) => client.query(sqlText, params);
const row = async (id: string) => (await q('SELECT * FROM agent_actions WHERE id = $1', [id])).rows[0];
const decisions = async (id: string) => (await q(
  'SELECT user_id, decision FROM agent_action_approvers WHERE action_id = $1 AND decision <> $2 ORDER BY user_id', [id, 'superseded'],
)).rows;
const web = (userId: string, id: string, decision: 'approve' | 'reject') => {
  webUser = userId;
  return app.request(`/api/agent/actions/${id}/${decision}`, { method: 'POST' });
};

before(async () => {
  if (!url) return;
  human = await import('../src/lib/mcp-tools/human.js');
  ({ documentSend } = await import('../src/lib/mcp-tools/document-send.js'));
  ({ workspacePlanImport } = await import('../src/lib/mcp-tools/workspace-plan-import.js'));
  const { agentRoutes } = await import('../src/routes/agent.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: webUser, org_id: orgId, role: roles[webUser], email: `${webUser}@t.local`, sid: 'parity-sid' } as any);
    await next();
  });
  app.route('/api/agent', agentRoutes);
  client = new pg.Client({ connectionString: url });
  await client.connect();
  const csv = 'Project,Project Prefix,Task,Priority\nParity Launch,PRL,Prepare launch,high';
  for (const [id, name] of [[orgId, 'parity-a'], [otherOrgId, 'parity-b']]) {
    await q('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [id, name, `${name}-${s}`]);
  }
  for (const id of [bob, carol, mallory, gina, dave, agentUser]) {
    const agent = id === agentUser;
    await q(`INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $1 || '@t.local', $1, $2, $3, true)`,
      [id, agent ? 'agent' : 'human', agent]);
    await q('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
      [randomUUID(), id === dave ? otherOrgId : orgId, id, agent ? 'member' : roles[id]]);
  }
  for (const id of [roomId, hiddenRoomId, sideRoomId]) {
    await q(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $1, 'private', $3)`, [id, orgId, bob]);
  }
  for (const [space, user] of [[roomId, bob], [roomId, mallory], [roomId, gina], [roomId, agentUser], [hiddenRoomId, bob], [sideRoomId, bob]]) {
    await q('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), space, user]);
  }
  await q(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, 'Share the report and import the plan')`,
    [sourceMessageId, orgId, roomId, bob]);
  await q('INSERT INTO projects (id, org_id, name, prefix, lead_id) VALUES ($1, $2, $3, $4, $5)', [projectId, orgId, `Parity ${s}`, `P${s.slice(0, 3)}`.toUpperCase().replace(/[^A-Z]/g, 'Q'), bob]);
  await q(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, project_ids, trust_level, max_daily_actions, created_by, is_active, is_byoa)
     VALUES ($1, $2, $3, 'Parity Agent', $4, 'project_manager', 'test', ARRAY[]::text[], 'autonomous', 50, $5, true, true)`,
  [employeeId, orgId, agentUser, `parity-${s}`, bob]);
  await q('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [agentUser, employeeId]);
  await q(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, detected_mime_type, size_bytes, storage_key, attachment_kind, processing_status, content_sha256, processed_at)
     VALUES ($1, $2, $3, 'plan.csv', 'text/csv', 'text/csv', $4, $5, 'spreadsheet', 'ready', $6, now())`,
  [fileId, orgId, bob, Buffer.byteLength(csv), `${randomUUID()}-plan.csv`, `sha256:${'e'.repeat(64)}`]);
  await q('INSERT INTO message_attachments (org_id, message_id, file_id, position) VALUES ($1, $2, $3, 0)', [orgId, sourceMessageId, fileId]);
  await q(`INSERT INTO attachment_derivatives (org_id, file_id, kind, mime_type, content, size_bytes) VALUES ($1, $2, 'text', 'text/plain', $3, $4)`,
    [orgId, fileId, csv, Buffer.byteLength(csv)]);
  const { ensureDeftyEmployee } = await import('../src/lib/ensure-defty-membership.js');
  defty = await ensureDeftyEmployee(orgId);
});

after(async () => {
  if (!client) return;
  for (const org of [orgId, otherOrgId]) {
    for (const table of ['agent_channel_events', 'oauth_audit_events', 'action_receipts', 'agent_action_approvers', 'attention_items', 'notifications', 'audit_log',
      'task_activity', 'tasks', 'agent_actions', 'attachment_derivatives', 'message_attachments', 'files', 'messages']) {
      await q(`DELETE FROM ${table} WHERE org_id = $1`, [org]).catch(() => undefined);
    }
    await q('DELETE FROM projects WHERE org_id = $1', [org]).catch(() => undefined);
    await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)', [org]).catch(() => undefined);
    await q('DELETE FROM spaces WHERE org_id = $1', [org]).catch(() => undefined);
    await q('UPDATE users SET agent_employee_id = NULL WHERE id IN (SELECT user_id FROM org_members WHERE org_id = $1)', [org]).catch(() => undefined);
    await q('DELETE FROM agent_employees WHERE org_id = $1', [org]).catch(() => undefined);
    await q('DELETE FROM org_members WHERE org_id = $1', [org]).catch(() => undefined);
    await q('DELETE FROM orgs WHERE id = $1', [org]).catch(() => undefined);
  }
  await q('DELETE FROM users WHERE id = ANY($1::text[])', [[bob, carol, mallory, gina, dave, agentUser]]).catch(() => undefined);
  await client.end();
  const { closeDb } = await import('../src/lib/db.js');
  await closeDb();
});

async function proposeDocument(key: string): Promise<string> {
  const r = await documentSend({ caller_employee_slug: `parity-${s}`, source_message_id: sourceMessageId, filename: `${key}.md`,
    mime_type: 'text/markdown', content: `# ${key}\n\nPARITY-BODY`, idempotency_key: `${key}-${s}` }, employeeCtx());
  assert.equal(r.isError, false, text(r));
  return json(r).action_id;
}

async function proposePlan(): Promise<string> {
  const r = await workspacePlanImport({ caller_employee_slug: `parity-${s}`, message_id: sourceMessageId, attachment_id: fileId }, employeeCtx());
  assert.equal(r.isError, false, text(r));
  return json(r).action_id;
}

/** A pending Defty `create_task` (an ordinary, non-resolver kind) requested by bob. */
async function deftyTask(): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, 'mention', 'create_task', $4::jsonb, 'quick', 'pending')`,
  [id, orgId, bob, JSON.stringify({ title: `Parity task ${id.slice(0, 6)}`, resolved_project_id: projectId })]);
  return id;
}

/** A pending employee `task_create` (a resolver kind) from bob's message. */
async function employeeTask(requester = bob, messageId: string | null = sourceMessageId): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status, message_id)
     VALUES ($1, $2, $3, $4, 'mcp', 'task_create', $5::jsonb, 'full', 'pending', $6)`,
  [id, orgId, requester, employeeId, JSON.stringify({ title: `Parity employee ${id.slice(0, 6)}`, project_id: projectId }), messageId]);
  return id;
}

test('P1: a plan import is approved over MCP as on the web, with the approver decision recorded', { skip: !url }, async () => {
  const planId = await proposePlan();
  const r = await human.humanApprovalApprove({ action_id: planId }, ctx(bob));
  assert.notEqual(r.isError, true, text(r));
  assert.equal((await row(planId)).approval_status, 'approved');
  assert.ok((await row(planId)).executed_at);
  assert.deepEqual(await decisions(planId), [{ user_id: bob, decision: 'approved' }]);
});

test('P2: a document-send rejected over MCP leaves the same row, decision and receipt as a web rejection', { skip: !url }, async () => {
  const viaWeb = await proposeDocument('web-reject');
  const viaMcp = await proposeDocument('mcp-reject');
  assert.equal((await web(bob, viaWeb, 'reject')).status, 200);
  const r = await human.humanApprovalReject({ action_id: viaMcp }, ctx(bob));
  assert.notEqual(r.isError, true, text(r));
  assert.equal(json(r).status, 'rejected');
  const [w, m] = [await row(viaWeb), await row(viaMcp)];
  assert.equal(m.approval_status, 'rejected');
  assert.deepEqual(Object.keys(m.params).sort(), Object.keys(w.params).sort());
  assert.equal('content' in m.params, false);
  assert.deepEqual(await decisions(viaMcp), [{ user_id: bob, decision: 'rejected' }]);
  const receipts = async (id: string) => (await q('SELECT decision FROM action_receipts WHERE action_id = $1', [id])).rows;
  assert.deepEqual(await receipts(viaMcp), await receipts(viaWeb));
  // A document send reports through its own message, never an employee event, on either surface.
  for (const id of [viaWeb, viaMcp]) {
    const events = await q(`SELECT 1 FROM agent_channel_events WHERE org_id = $1 AND kind = 'approval.resolved' AND payload->>'action_id' = $2`, [orgId, id]);
    assert.equal(events.rowCount, 0);
  }
});

test('P2b: a bulk create rejected over MCP leaves the same row, decision and receipt as a web rejection', { skip: !url }, async () => {
  const bulk = async () => {
    const id = randomUUID();
    await q(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
       VALUES ($1, $2, $3, 'mcp', 'module_record_bulk_create', $4::jsonb, 'full', 'pending')`, [id, orgId, bob, JSON.stringify({
      module_id: 'test.parity-equipment', collection_key: 'assets', expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
      rows: [{ data: { serial: `PARITY-${id.slice(0, 6)}` } }], idempotency_key: `parity-bulk-${id}`,
      __deft_human_mcp_principal: { kind: 'human_mcp_v1', client_id: `parity-${s}` },
    })]);
    return id;
  };
  const viaWeb = await bulk();
  const viaMcp = await bulk();
  assert.equal((await web(bob, viaWeb, 'reject')).status, 200);
  const r = await human.humanApprovalReject({ action_id: viaMcp },
    { ...ctx(bob), scopes: ['read:workspace', 'write:workspace', 'read:modules', 'write:modules'] });
  assert.notEqual(r.isError, true, text(r));
  const [w, m] = [await row(viaWeb), await row(viaMcp)];
  assert.equal(w.approval_status, 'rejected');
  assert.equal(m.approval_status, 'rejected');
  assert.deepEqual(Object.keys(m.params).sort(), Object.keys(w.params).sort());
  assert.equal(Boolean(m.executed_at), Boolean(w.executed_at));
  assert.deepEqual(await decisions(viaMcp), [{ user_id: bob, decision: 'rejected' }]);
  assert.deepEqual(await decisions(viaWeb), [{ user_id: bob, decision: 'rejected' }]);
  const receipt = async (id: string) =>
    (await q('SELECT proposer, decision FROM action_receipts WHERE action_id = $1', [id])).rows;
  assert.deepEqual(await receipt(viaMcp), await receipt(viaWeb));
});

test('P3: a resolver-owned employee action approved over MCP records the decision and the confirmation as on the web', { skip: !url }, async () => {
  const actionId = await employeeTask();
  const r = await human.humanApprovalApprove({ action_id: actionId }, ctx(bob));
  assert.notEqual(r.isError, true, text(r));
  assert.equal(json(r).status, 'approved');
  assert.deepEqual(await decisions(actionId), [{ user_id: bob, decision: 'approved' }]);
  const confirmations = await q(`SELECT id FROM messages WHERE org_id = $1 AND metadata->>'approval_confirmation_for_message_id' = $2`,
    [orgId, sourceMessageId]);
  assert.ok(confirmations.rowCount! >= 1);
});

test('P4: only the active requester decides an ordinary action over MCP; everyone else is refused as on the web', { skip: !url }, async () => {
  for (const decide of ['approve', 'reject'] as const) {
    const tool = decide === 'approve' ? human.humanApprovalApprove : human.humanApprovalReject;
    const actionId = await deftyTask();
    for (const other of [carol, mallory, gina]) {
      assert.equal((await tool({ action_id: actionId }, ctx(other))).isError, true);
      assert.equal((await web(other, actionId, decide)).status, 404);
    }
    assert.equal((await tool({ action_id: actionId }, ctx(dave, otherOrgId))).isError, true);
    assert.equal((await row(actionId)).approval_status, 'pending');
    const r = await tool({ action_id: actionId }, ctx(bob));
    assert.notEqual(r.isError, true, text(r));
    const expected = decide === 'approve' ? 'approved' : 'rejected';
    assert.equal((await row(actionId)).approval_status, expected);
    assert.deepEqual(await decisions(actionId), [{ user_id: bob, decision: expected }]);
  }
});

test('P5: a reviewer who cannot see the source is refused on web and MCP, and a replay does not skip the check', { skip: !url }, async () => {
  // Document sends are an ordinary (non-resolver) kind proposed by an employee.
  const replayed = await proposeDocument('replayed');
  const key = `parity-replay-${randomUUID()}`;
  const first = await human.humanApprovalApprove({ action_id: replayed, idempotency_key: key }, ctx(bob));
  assert.notEqual(first.isError, true, text(first));
  const pendingWeb = await proposeDocument('source-web');
  const pendingMcp = await proposeDocument('source-mcp');
  await q('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [roomId, bob]);
  try {
    assert.equal((await web(bob, pendingWeb, 'approve')).status, 404);
    assert.equal((await web(bob, pendingWeb, 'reject')).status, 404);
    for (const tool of [human.humanApprovalApprove, human.humanApprovalReject]) {
      assert.equal((await tool({ action_id: pendingMcp }, ctx(bob))).isError, true);
    }
    assert.equal((await row(pendingWeb)).approval_status, 'pending');
    assert.equal((await row(pendingMcp)).approval_status, 'pending');
    const replay = await human.humanApprovalApprove({ action_id: replayed, idempotency_key: key }, ctx(bob));
    assert.equal(replay.isError, true);
    assert.equal(text(replay).includes('replayed'), false);
  } finally {
    await q('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), roomId, bob]);
  }
});

test('P5b: an answer stored before the shared decision functions is not replayed', { skip: !url }, async () => {
  const actionId = await deftyTask();
  const key = `parity-legacy-${randomUUID()}`;
  await q(`INSERT INTO oauth_audit_events (id, org_id, user_id, client_id, event, metadata) VALUES ($1, $2, $3, $4, 'mcp_idempotency_result', $5::jsonb)`,
    [randomUUID(), orgId, bob, `personal-token:parity-${s}`, JSON.stringify({ tool_name: 'approval_approve', idempotency_key: key, bind: actionId,
      result: { content: [{ type: 'text', text: '{"status":"approved","legacy":"PARITY-LEGACY"}' }] } })]);
  const r = await human.humanApprovalApprove({ action_id: actionId, idempotency_key: key }, ctx(bob));
  assert.notEqual(r.isError, true, text(r));
  assert.equal(text(r).includes('PARITY-LEGACY'), false);
  assert.equal((await row(actionId)).approval_status, 'approved');
});

test('P6: a record-mirror nomination cannot be approved over MCP', { skip: !url }, async () => {
  const id = randomUUID();
  const params = { connection_session_id: randomUUID(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: randomUUID(),
    request_id: randomUUID(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1,
    account_ref: 'account_1', installation_id: randomUUID(), policy_digest: `sha256:${'b'.repeat(64)}` };
  await q(`INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, 'app_record_mirror', 'app_record_mirror_nominate', $4::jsonb, 'full', 'pending')`, [id, orgId, bob, JSON.stringify(params)]);
  const r = await human.humanApprovalApprove({ action_id: id }, ctx(bob));
  assert.equal(r.isError, true);
  // Refused for want of a web session, before anything else is checked.
  assert.match(text(r), /FORBIDDEN: Approve this request in Deft/);
  assert.equal((await row(id)).approval_status, 'pending');
});

test('P7: a failing decision returns no internal detail, and a still-running answer is never stored', { skip: !url }, async () => {
  // A NUL byte makes every database statement fail.
  for (const tool of [human.humanApprovalApprove, human.humanApprovalReject]) {
    const r = await tool({ action_id: `bad\u0000id` }, ctx(bob));
    assert.equal(r.isError, true);
    assert.equal(text(r), 'INTERNAL_ERROR: The approval request failed');
  }
  const answer = (body: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] });
  assert.equal(human.isExecutingAnswer(answer({ status: 'executing', message: 'execution is already in progress' })), true);
  assert.equal(human.isExecutingAnswer(answer({ status: 'approved', result: {} })), false);
});

/** A pending Defty capture of `authorId`'s message in `spaceId`, stored under `storedUserId`. */
async function capture(storedUserId: string, authorId: string, spaceId: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'defty_capture', 'wiki_create', $5::jsonb, 'quick', 'pending')`,
  [id, orgId, storedUserId, storedUserId === defty.userId ? defty.employeeId : null, JSON.stringify({
    title: `Parity capture ${id.slice(0, 6)}`, content: 'Decision: parity.', type: 'decision', scope: 'org',
    space_id: spaceId, source_space_id: spaceId, source_user_id: authorId, capture_kind: 'decision_candidate', proposed_by: 'defty',
  })]);
  return id;
}

const digestIds = async (userId: string) =>
  (json(await human.humanAttentionDigest({}, ctx(userId))).pending_approvals as Array<{ id: string }>).map((a) => a.id);

test('D1: the attention digest lists the approvals the web shows the user, and no others', { skip: !url }, async () => {
  const hidden = await capture(mallory, bob, hiddenRoomId);
  const stored = await capture(defty.userId, bob, roomId);
  const fallback = await employeeTask(agentUser, null);
  const queued = randomUUID();
  await q(`INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'heartbeat', 'heartbeat_tick', '{}'::jsonb, 'auto', 'pending')`, [queued, orgId, agentUser, employeeId]);
  const pendingList = text(await human.humanApprovalList({ status: 'pending', limit: 100 }, ctx(carol)));
  assert.equal(pendingList.includes(fallback), true);
  assert.equal(pendingList.includes(queued), false);
  assert.equal((await digestIds(carol)).includes(queued), false);
  assert.equal((await digestIds(mallory)).includes(hidden), false);
  assert.equal((await digestIds(bob)).includes(stored), true);
  assert.equal((await digestIds(carol)).includes(fallback), true);
  assert.equal((await digestIds(mallory)).includes(fallback), false);
  const otherOrg = json(await human.humanAttentionDigest({}, ctx(dave, otherOrgId))).pending_approvals as Array<{ id: string }>;
  assert.equal(otherOrg.some((a) => [hidden, stored, fallback].includes(a.id)), false);
});

async function attentionItem(spaceId: string, title: string): Promise<string> {
  const id = randomUUID();
  const messageId = randomUUID();
  await q(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)`, [messageId, orgId, spaceId, carol, title]);
  await q(`INSERT INTO attention_items (id, org_id, user_id, lane, kind, dedupe_key, source_type, source_id, title, state, last_event_at)
     VALUES ($1, $2, $3, 'needs_you', 'mention', $4, 'message', $5, $6, 'open_unseen', now())`, [id, orgId, bob, `parity:${id}`, messageId, title]);
  return id;
}

test('D2: an attention idempotency key reused on another item returns nothing from the first', { skip: !url }, async () => {
  const first = await attentionItem(sideRoomId, 'PARITY-FIRST-ITEM');
  const second = await attentionItem(roomId, 'parity second item');
  const key = `parity-attention-${randomUUID()}`;
  const a = await human.humanAttentionAcknowledge({ attention_id: first, idempotency_key: key }, ctx(bob));
  assert.notEqual(a.isError, true, text(a));
  await q('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [sideRoomId, bob]);
  const b = await human.humanAttentionAcknowledge({ attention_id: second, idempotency_key: key }, ctx(bob));
  assert.notEqual(b.isError, true, text(b));
  assert.equal(text(b).includes('PARITY-FIRST-ITEM'), false);
  assert.equal(json(b).item.id, second);
  const again = await human.humanAttentionAcknowledge({ attention_id: first, idempotency_key: key }, ctx(bob));
  assert.equal(again.isError, true);
  assert.equal(text(again).includes('PARITY-FIRST-ITEM'), false);
  // Resolving without a resolution records the web's default.
  const resolved = await human.humanAttentionResolve({ attention_id: second }, ctx(bob));
  assert.notEqual(resolved.isError, true, text(resolved));
  assert.equal((await q('SELECT resolution FROM attention_items WHERE id = $1', [second])).rows[0].resolution, 'dismissed');
});

test('P4b: with no active human requester, an admin decides over MCP and a member cannot', { skip: !url }, async () => {
  const fallback = await employeeTask(agentUser, null);
  assert.equal((await human.humanApprovalApprove({ action_id: fallback }, ctx(mallory))).isError, true);
  const r = await human.humanApprovalApprove({ action_id: fallback }, ctx(carol));
  assert.notEqual(r.isError, true, text(r));
  assert.deepEqual(await decisions(fallback), [{ user_id: carol, decision: 'approved' }]);
});
