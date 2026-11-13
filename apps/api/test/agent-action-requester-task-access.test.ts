// Approved agent actions reach a task, wiki page or source message only when the
// action's requester (a capture's message author) can see it; hidden answers like missing.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';

import { closeDb } from '../src/lib/db.js';
import { executeAction, executeActionDirect } from '../src/lib/agent-actions.js';
import { approveAction } from '../src/lib/agent-approval-resolver.js';
import { queueDeftyCreateTaskCapture, queueDeftyKnowledgeCapture } from '../src/lib/defty-capture.js';
import { ensureDeftyEmployee } from '../src/lib/ensure-defty-membership.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);
const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const ownerId = randomUUID();
const memberId = randomUUID();
const projectId = randomUUID();
const otherProjectId = randomUUID();
const publicSpaceId = randomUUID();
const privateSpaceId = randomUUID();
const prefix = `RQ${suffix.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase() || 'Q'}`;
const otherPrefix = `RX${suffix.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase() || 'Q'}`;

let client: pg.Client;
let deftyUserId: string;
let taskNumber = 101;

async function insertTask(values: {
  title: string;
  restricted?: boolean;
  createdBy?: string;
  org?: string;
  project?: string;
}): Promise<{ id: string; ref: string }> {
  const id = randomUUID();
  const number = taskNumber++;
  const org = values.org ?? orgId;
  await client.query(
    `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by, assignee_id, metadata)
     VALUES ($1, $2, $3, $4, $5, 'in_progress', 'p2', $6, $6, $7::jsonb)`,
    [id, org, values.project ?? projectId, number, values.title, values.createdBy ?? ownerId,
      JSON.stringify(values.restricted ? { visibility: 'restricted' } : {})],
  );
  return { id, ref: `${org === orgId ? prefix : otherPrefix}-${number}` };
}

async function insertAction(userId: string, action: string, params: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, 'mention', $4, $5::jsonb, 'full', 'approved')`,
    [id, orgId, userId, action, JSON.stringify(params)],
  );
  return id;
}

async function run(userId: string, action: string, params: Record<string, unknown>) {
  const actionId = await insertAction(userId, action, params);
  return executeAction(actionId, action, { ...params }, orgId, userId);
}

async function insertMessage(spaceId: string, userId: string, content: string): Promise<string> {
  const id = randomUUID();
  await client.query('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)',
    [id, orgId, spaceId, userId, content]);
  return id;
}

async function taskRow(id: string) {
  return (await client.query('SELECT status, priority, due_date, assignee_id FROM tasks WHERE id = $1', [id])).rows[0];
}

before(async () => {
  if (!canRun) return;
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  for (const [id, name] of [[orgId, 'main'], [otherOrgId, 'other']] as const) {
    await client.query("INSERT INTO orgs (id, name, slug, trust_level) VALUES ($1, $2, $3, 'standard')",
      [id, `W2e ${name}`, `w2e-${name}-${suffix}`]);
  }
  for (const [id, role] of [[ownerId, 'owner'], [memberId, 'member']] as const) {
    await client.query(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES ($1, $2, $3, 'human', false, true)`,
      [id, `w2e-${id}@example.test`, `W2e ${role} ${id.slice(0, 4)}`],
    );
    await client.query(
      'INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
      [randomUUID(), orgId, id, role],
    );
  }
  await client.query(
    'INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, $3, $4, $5, 900), ($6, $7, $8, $9, NULL, 900)',
    [projectId, orgId, `W2e project ${suffix}`, prefix, ownerId, otherProjectId, otherOrgId, `W2e other ${suffix}`, otherPrefix],
  );
  await client.query(
    `INSERT INTO spaces (id, org_id, name, type, created_by)
     VALUES ($1, $3, $4, 'public', $5), ($2, $3, $6, 'private', $5)`,
    [publicSpaceId, privateSpaceId, orgId, `w2e-public-${suffix}`, ownerId, `w2e-private-${suffix}`],
  );
  deftyUserId = (await ensureDeftyEmployee(orgId)).userId;
  for (const [spaceId, userId] of [
    [publicSpaceId, ownerId], [publicSpaceId, memberId], [publicSpaceId, deftyUserId],
    [privateSpaceId, ownerId], [privateSpaceId, memberId], [privateSpaceId, deftyUserId],
  ]) {
    await client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)',
      [randomUUID(), spaceId, userId]);
  }
});

after(async () => {
  if (!client) {
    await closeDb();
    return;
  }
  try {
    for (const table of ['action_receipts', 'notifications', 'attention_items', 'job_queue', 'work_intents',
      'agent_actions', 'audit_log', 'task_activity', 'task_comments', 'wiki_ops_log', 'wiki_citations',
      'cross_references', 'labels']) {
      await client.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [[orgId, otherOrgId]]).catch(() => undefined);
    }
    await client.query('DELETE FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)', [orgId]).catch(() => undefined);
    await client.query(
      'DELETE FROM task_relationships WHERE source_task_id IN (SELECT id FROM tasks WHERE org_id = ANY($1::text[]))',
      [[orgId, otherOrgId]],
    );
    await client.query('DELETE FROM wiki_page_versions WHERE page_id IN (SELECT id FROM wiki_pages WHERE org_id = $1)', [orgId]);
    await client.query('DELETE FROM wiki_pages WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM tasks WHERE org_id = ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM messages WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM projects WHERE org_id = ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = $1)', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM agent_employees WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id = ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [[orgId, otherOrgId]]);
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, memberId]]);
  } finally {
    await client.end();
    await closeDb();
  }
});

// ─── Native task kinds ───────────────────────────────────────────────────────

test('a member cannot remove a dependency on a task they cannot see; the answer matches a missing task', { skip: !canRun }, async () => {
  const hidden = await insertTask({ title: 'Hidden dependency source', restricted: true });
  const open = await insertTask({ title: 'Open dependency target' });
  const foreign = await insertTask({ title: 'Other org task', org: otherOrgId, project: otherProjectId });
  await client.query(
    "INSERT INTO task_relationships (id, source_task_id, target_task_id, type) VALUES ($1, $2, $3, 'blocks')",
    [randomUUID(), hidden.id, open.id],
  );

  const refusals = [];
  for (const source of [hidden.id, hidden.ref, randomUUID(), `${prefix}-99999`, foreign.id]) {
    const result = await run(memberId, 'remove_dependency', {
      source_task_identifier: source, target_task_identifier: open.id, type: 'blocks',
    });
    assert.equal(result.success, false);
    refusals.push({ result: result.result, error: result.error });
  }
  for (const refusal of refusals) assert.deepEqual(refusal, { result: null, error: 'Task not found' });

  const { rows } = await client.query(
    'SELECT id FROM task_relationships WHERE source_task_id = $1 AND target_task_id = $2', [hidden.id, open.id]);
  assert.equal(rows.length, 1, 'the dependency is kept');

  const ownerResult = await run(ownerId, 'remove_dependency', {
    source_task_identifier: hidden.id, target_task_identifier: open.id, type: 'blocks',
  });
  assert.equal(ownerResult.success, true, ownerResult.error);
});

test('a member who can see both tasks can add and remove a dependency', { skip: !canRun }, async () => {
  const a = await insertTask({ title: 'Visible A' });
  const b = await insertTask({ title: 'Visible B' });
  const added = await run(memberId, 'add_dependency', {
    source_task_identifier: a.ref, target_task_identifier: b.ref, type: 'blocks',
  });
  assert.equal(added.success, true, added.error);
  const removed = await run(memberId, 'remove_dependency', {
    source_task_identifier: a.ref, target_task_identifier: b.ref, type: 'blocks',
  });
  assert.equal(removed.success, true, removed.error);
});

test('every native task kind refuses a hidden task exactly as a missing one, and leaves it unchanged', { skip: !canRun }, async () => {
  const hidden = await insertTask({ title: 'Hidden sibling target', restricted: true });
  const open = await insertTask({ title: 'Open sibling peer' });
  const [decision] = (await client.query(
    `INSERT INTO wiki_pages (id, org_id, user_id, title, slug, content, type, scope)
     VALUES ($1, $2, $3, 'Decision', $4, 'We decided.', 'decision', 'org') RETURNING id`,
    [randomUUID(), orgId, ownerId, `w2e-decision-${suffix}`],
  )).rows;
  const before = await taskRow(hidden.id);

  const kinds: Array<[string, (task: string) => Record<string, unknown>]> = [
    ['add_dependency', (task) => ({ source_task_identifier: task, target_task_identifier: open.id, type: 'relates_to' })],
    ['update_task_status', (task) => ({ task_identifier: task, new_status: 'done' })],
    ['close_task', (task) => ({ task_identifier: task })],
    ['reopen_task', (task) => ({ task_identifier: task })],
    ['assign_task', (task) => ({ task_identifier: task, assignee_name: `W2e member ${memberId.slice(0, 4)}` })],
    ['comment_on_task', (task) => ({ task_identifier: task, content: 'hello' })],
    ['set_due_date', (task) => ({ task_identifier: task, due_date: '2027-01-01' })],
    ['set_priority', (task) => ({ task_identifier: task, priority: 'p0' })],
    ['add_label', (task) => ({ task_identifier: task, label_name: `w2e-${suffix}` })],
    ['bulk_update_tasks', (task) => ({ task_identifiers: [open.id, task], updates: { priority: 'p0' } })],
  ];
  for (const [kind, params] of kinds) {
    const hiddenResult = await run(memberId, kind, params(kind === 'update_task_status' || kind === 'close_task' ? hidden.ref : hidden.id));
    const missingResult = await run(memberId, kind, params(randomUUID()));
    assert.equal(hiddenResult.success, false, `${kind} on a hidden task`);
    assert.deepEqual(
      { result: hiddenResult.result, error: hiddenResult.error },
      { result: missingResult.result, error: missingResult.error },
      `${kind}: hidden and missing answer alike`,
    );
    assert.equal(hiddenResult.error, 'Task not found', kind);
  }
  assert.deepEqual(await taskRow(hidden.id), before, 'the hidden task is unchanged');
  const comments = await client.query('SELECT 1 FROM task_comments WHERE task_id = $1', [hidden.id]);
  assert.equal(comments.rows.length, 0);
  const links = await client.query('SELECT 1 FROM cross_references WHERE org_id = $1 AND target_id = $2', [orgId, hidden.id]).catch(() => ({ rows: [] }));
  assert.equal(links.rows.length, 0);

  const hiddenLink = await run(memberId, 'link_decision_to_tasks', { decision_id: decision.id, task_ids: [open.id, hidden.id] });
  const missingId = randomUUID();
  const missingLink = await run(memberId, 'link_decision_to_tasks', { decision_id: decision.id, task_ids: [open.id, missingId] });
  assert.equal(hiddenLink.success, true, hiddenLink.error);
  assert.deepEqual(hiddenLink.result.skipped, [hidden.id], 'a hidden task is skipped like an unknown one');
  assert.deepEqual(missingLink.result.skipped, [missingId]);
  assert.deepEqual(hiddenLink.result.linked_task_ids, [open.id]);

  assert.equal((await taskRow(open.id)).priority, 'p2', 'a refused batch changes no task');
  const direct = await executeActionDirect('set_priority', { task_identifier: hidden.id, priority: 'p0' }, orgId, memberId, null, 'auto');
  assert.deepEqual({ success: direct.success, error: direct.error }, { success: false, error: 'Task not found' });
  const stored = await client.query('SELECT error FROM agent_actions WHERE id = $1', [direct.actionId]);
  assert.equal(stored.rows[0].error, 'Task not found', 'the refusal is recorded on the action');

  const ok = await run(memberId, 'set_priority', { task_identifier: open.ref, priority: 'p1' });
  assert.equal(ok.success, true, ok.error);
});

test('decision kinds refuse a decision page the member cannot see exactly as a missing one', { skip: !canRun }, async () => {
  const ownerSpaceId = randomUUID();
  await client.query(
    "INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)",
    [ownerSpaceId, orgId, `w2e-owner-only-${suffix}`, ownerId],
  );
  await client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), ownerSpaceId, ownerId]);
  const hiddenDecision = randomUUID();
  await client.query(
    `INSERT INTO wiki_pages (id, org_id, user_id, title, slug, content, type, scope, space_id)
     VALUES ($1, $2, $3, 'Private decision', $4, 'Owner only.', 'decision', 'space', $5)`,
    [hiddenDecision, orgId, ownerId, `w2e-hidden-decision-${suffix}`, ownerSpaceId],
  );
  const open = await insertTask({ title: 'Decision link target' });
  for (const [kind, params] of [
    ['mark_decision_implemented', (id: string) => ({ decision_id: id })],
    ['link_decision_to_tasks', (id: string) => ({ decision_id: id, task_ids: [open.id] })],
  ] as const) {
    const hidden = await run(memberId, kind, params(hiddenDecision));
    const missing = await run(memberId, kind, params(randomUUID()));
    assert.deepEqual({ result: hidden.result, error: hidden.error }, { result: null, error: 'Decision not found' }, kind);
    assert.deepEqual({ result: missing.result, error: missing.error }, { result: null, error: 'Decision not found' }, kind);
  }
  const { rows } = await client.query('SELECT tags FROM wiki_pages WHERE id = $1', [hiddenDecision]);
  assert.ok(!(rows[0].tags ?? []).includes('implemented'), 'the hidden decision is unchanged');
  const ownerResult = await run(ownerId, 'mark_decision_implemented', { decision_id: hiddenDecision });
  assert.equal(ownerResult.success, true, ownerResult.error);
});

// ─── Defty capture ───────────────────────────────────────────────────────────

test('a capture from a member never proposes an update to a task the member cannot see', { skip: !canRun }, async () => {
  const hidden = await insertTask({ title: 'Defty-made hidden task', restricted: true, createdBy: deftyUserId });
  const content = `${hidden.ref} is done now; please close it out.`;
  const messageId = await insertMessage(publicSpaceId, memberId, content);
  await queueDeftyCreateTaskCapture({
    orgId, sourceUserId: memberId, spaceId: publicSpaceId, messageId, content,
    captureKind: 'task_candidate', captureReason: 'status update', extraction: 'deterministic',
  });
  const { rows } = await client.query(
    "SELECT action, params FROM agent_actions WHERE org_id = $1 AND message_id = $2 AND action = 'task_update'",
    [orgId, messageId],
  );
  assert.equal(rows.length, 0, 'no update card names the hidden task');
});

test('an approved capture task update runs only while the author can see the task', { skip: !canRun }, async () => {
  for (const authorKeepsAccess of [true, false]) {
    const task = await insertTask({ title: `Capture update ${authorKeepsAccess}`, createdBy: deftyUserId });
    const content = `${task.ref} is done now; please close it out.`;
    const messageId = await insertMessage(publicSpaceId, memberId, content);
    await queueDeftyCreateTaskCapture({
      orgId, sourceUserId: memberId, spaceId: publicSpaceId, messageId, content,
      captureKind: 'task_candidate', captureReason: 'status update', extraction: 'deterministic',
    });
    const { rows } = await client.query(
      "SELECT id FROM agent_actions WHERE org_id = $1 AND message_id = $2 AND action = 'task_update'",
      [orgId, messageId],
    );
    assert.equal(rows.length, 1, 'the capture proposes the update');
    if (!authorKeepsAccess) {
      await client.query(
        `UPDATE tasks SET metadata = '{"visibility":"restricted"}'::jsonb, assignee_id = $2 WHERE id = $1`,
        [task.id, ownerId],
      );
    }
    const result = await approveAction(rows[0]!.id, memberId);
    const after = await taskRow(task.id);
    if (authorKeepsAccess) {
      assert.equal(result.status, 'approved', JSON.stringify(result));
      assert.equal(after.status, 'done');
    } else {
      assert.equal(result.status, 'error');
      assert.equal((result as any).message, `task_update: task ${task.id} not found`);
      assert.equal(after.status, 'in_progress', 'the task is unchanged');
    }
  }
});

test('an approved capture wiki update runs only while the author can still see the page', { skip: !canRun }, async () => {
  for (const authorKeepsAccess of [true, false]) {
    const pageId = randomUUID();
    const title = `Crate schedule ${authorKeepsAccess} ${suffix}`;
    await client.query(
      `INSERT INTO wiki_pages (id, org_id, user_id, title, slug, content, summary, type, scope, space_id)
       VALUES ($1, $2, $3, $4, $5, '# Schedule\n\nOriginal.', 'Schedule.', 'decision', 'space', $6)`,
      [pageId, orgId, ownerId, title, `w2e-${pageId}`, privateSpaceId],
    );
    const update = 'The crate demo moves to Friday at 3pm.';
    const messageId = await insertMessage(privateSpaceId, memberId, update);
    const queued = await queueDeftyKnowledgeCapture({
      orgId, sourceUserId: memberId, spaceId: privateSpaceId, messageId,
      title, content: update, wikiType: 'decision', captureKind: 'decision_candidate',
      preferUpdate: true, autoApprove: false,
    });
    assert.equal(queued.queued, true, JSON.stringify(queued));
    if (!authorKeepsAccess) {
      await client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [privateSpaceId, memberId]);
    }
    try {
      const result = await approveAction(queued.actionId!, deftyUserId, { internal: true });
      const { rows } = await client.query('SELECT content FROM wiki_pages WHERE id = $1', [pageId]);
      if (authorKeepsAccess) {
        assert.equal(result.status, 'approved', JSON.stringify(result));
        assert.ok(rows[0].content.includes(update));
      } else {
        assert.equal(result.status, 'error');
        assert.ok(!rows[0].content.includes(update), 'the page is unchanged');
      }
    } finally {
      if (!authorKeepsAccess) {
        await client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)',
          [randomUUID(), privateSpaceId, memberId]);
      }
    }
  }
});

test('an approved capture task create reads its source message only as the author', { skip: !canRun }, async () => {
  const content = `Create a task to order spare crate labels ${suffix}`;
  const messageId = await insertMessage(privateSpaceId, memberId, content);
  const queued = await queueDeftyCreateTaskCapture({
    orgId, sourceUserId: memberId, spaceId: privateSpaceId, messageId, content,
    title: `Order spare crate labels ${suffix}`, projectName: `W2e project ${suffix}`, captureKind: 'task_candidate',
    captureReason: 'request', extraction: 'deterministic',
  });
  assert.ok(queued.actionId, JSON.stringify(queued));
  await client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [privateSpaceId, memberId]);
  try {
    const result = await approveAction(queued.actionId!, deftyUserId, { internal: true });
    assert.equal(result.status, 'error', JSON.stringify(result));
    const { rows } = await client.query('SELECT 1 FROM tasks WHERE org_id = $1 AND title = $2', [orgId, `Order spare crate labels ${suffix}`]);
    assert.equal(rows.length, 0, 'no task is created');
  } finally {
    await client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)',
      [randomUUID(), privateSpaceId, memberId]);
  }
});

test('an approved capture task update stops when its author can no longer read the source message', { skip: !canRun }, async () => {
  const task = await insertTask({ title: 'Capture update source room', createdBy: deftyUserId });
  const content = `${task.ref} is done now; please close it out.`;
  const messageId = await insertMessage(privateSpaceId, memberId, content);
  await queueDeftyCreateTaskCapture({
    orgId, sourceUserId: memberId, spaceId: privateSpaceId, messageId, content,
    captureKind: 'task_candidate', captureReason: 'status update', extraction: 'deterministic',
  });
  const { rows } = await client.query(
    "SELECT id FROM agent_actions WHERE org_id = $1 AND message_id = $2 AND action = 'task_update'",
    [orgId, messageId],
  );
  assert.equal(rows.length, 1, 'the capture proposes the update');
  await client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [privateSpaceId, memberId]);
  try {
    const result = await approveAction(rows[0]!.id, deftyUserId, { internal: true });
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal((await taskRow(task.id)).status, 'in_progress', 'the task is unchanged');
  } finally {
    await client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)',
      [randomUUID(), privateSpaceId, memberId]);
  }
});
