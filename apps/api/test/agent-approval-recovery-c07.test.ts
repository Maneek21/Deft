/**
 * Lane W2 approval recovery — C07.
 *
 * An approval whose request stopped after the claim must not stay
 * "executing" forever. A request is only treated as gone when nobody holds
 * the action's execution lease (a session advisory lock); a time threshold
 * alone never recovers an approval. Every later write by the executing
 * request is fenced on the claim it made, so a request that lost its claim
 * can neither clear a recovery nor reopen a terminal action.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-approval-recovery-c07.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';

import { createTaskBundle } from '../src/lib/task-bundle.js';
import {
  claimPendingApproval,
  executeClaimedApproval,
  finalizeApprovalOutcome,
  recoverInterruptedApproval,
  recoverInterruptedApprovals,
  settleInterruptedApproval,
} from '../src/lib/agent-action-execution-lease.js';
import { APPROVAL_RESOLVER_ACTION_NAMES, isApprovalResolverAction } from '../src/lib/agent-approval-resolver.js';
import { syncApprovalToAttention } from '../src/lib/attention.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('RC');
});

after(async () => {
  if (f) await f.teardown();
});

const leaseKey = (actionId: string) => `agent-approval:${actionId}`;

async function holdLease(actionId: string): Promise<pg.Client> {
  const holder = new pg.Client({ connectionString: durabilityDatabaseUrl });
  await holder.connect();
  await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [leaseKey(actionId)]);
  return holder;
}

async function leaseHolderPid(actionId: string): Promise<number | null> {
  const rows = await f.client.query(
    `SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [leaseKey(actionId)],
  );
  return rows.rows[0]?.pid ?? null;
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function projectName(): Promise<string> {
  const row = await f.client.query('SELECT name FROM projects WHERE id = $1', [f.projectId]);
  return row.rows[0].name as string;
}

async function tasksTitled(title: string): Promise<number> {
  const rows = await f.client.query('SELECT count(*)::int AS n FROM tasks WHERE org_id = $1 AND title = $2', [f.orgId, title]);
  return rows.rows[0].n as number;
}

type ActionRow = {
  approval_status: string;
  result: any;
  error: string | null;
  executed_at: Date | null;
  approved_by_user_id: string | null;
  token: string | null;
};

async function actionRow(id: string): Promise<ActionRow> {
  const rows = await f.client.query(
    `SELECT approval_status, result, error, executed_at, approved_by_user_id, approved_at::text AS token
       FROM agent_actions WHERE id = $1`,
    [id],
  );
  return rows.rows[0] as ActionRow;
}

/** A row exactly as the approve route leaves it after its claim. */
async function interruptedAction(values: { action: string; params: Record<string, unknown>; approvedAgo?: string }): Promise<string> {
  const id = await f.insertAction({
    action: values.action,
    params: values.params,
    status: 'approved',
    executed: false,
    result: { lifecycle_state: 'executing', started_at: new Date().toISOString() },
  });
  await f.client.query(
    `UPDATE agent_actions
        SET approved_by_user_id = $2,
            approved_at = clock_timestamp() - $3::interval
      WHERE id = $1`,
    [id, f.requesterId, values.approvedAgo ?? '10 minutes'],
  );
  return id;
}

async function insertTask(title: string): Promise<string> {
  const id = randomUUID();
  await f.client.query(
    `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by)
     VALUES ($1, $2, $3, (SELECT COALESCE(max(number), 0) + 1 FROM tasks WHERE project_id = $3), $4, 'todo', 'p2', $5)`,
    [id, f.orgId, f.projectId, title, f.requesterId],
  );
  return id;
}

async function taskStatus(taskId: string): Promise<string> {
  const rows = await f.client.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  return rows.rows[0].status as string;
}

async function taskIdentifier(taskId: string): Promise<string> {
  const rows = await f.client.query('SELECT number FROM tasks WHERE id = $1', [taskId]);
  return `${f.prefix}-${rows.rows[0].number}`;
}

const approve = (actionId: string, userId = f.requesterId) =>
  f.as(userId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });

// ─── C07 ─────────────────────────────────────────────────────────────────────

test('C07-a: an approval whose executor still holds its lease is not recovered', { skip: !canRun }, async () => {
  const taskId = await insertTask(`c07a ${randomUUID()}`);
  const actionId = await interruptedAction({
    action: 'update_task_status',
    params: { task_identifier: await taskIdentifier(taskId), new_status: 'done' },
  });
  const before = await actionRow(actionId);
  const holder = await holdLease(actionId);
  try {
    const response = await approve(actionId);
    assert.equal(response.status, 202, await response.clone().text());
    assert.deepEqual(await actionRow(actionId), before);
  } finally {
    await holder.end();
  }
  // The executor is gone once its connection closes: the next attempt settles it.
  const settled = await approve(actionId);
  assert.equal(settled.status, 200, await settled.clone().text());
  assert.equal((await actionRow(actionId)).approval_status, 'approved');
  assert.notEqual((await actionRow(actionId)).executed_at, null);
});

test('C07-b: an interrupted approval of a non-repeatable action becomes failed and is never re-run', { skip: !canRun }, async () => {
  const taskId = await insertTask(`c07b ${randomUUID()}`);
  const actionId = await interruptedAction({
    action: 'update_task_status',
    params: { task_identifier: await taskIdentifier(taskId), new_status: 'done' },
  });
  const original = await actionRow(actionId);

  const response = await approve(actionId);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { status: string; error?: string };
  assert.equal(body.status, 'failed');
  assert.match(body.error ?? '', /interrupted/i);

  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.match(row.error ?? '', /interrupted/i);
  assert.notEqual(row.executed_at, null);
  assert.equal(row.approved_by_user_id, original.approved_by_user_id);
  assert.equal(await taskStatus(taskId), 'todo');

  const again = await approve(actionId);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await again.json() as { status: string }).status, 'failed');
  assert.equal(await taskStatus(taskId), 'todo');
});

test('C07-c: an interrupted task creation is re-executed exactly once: one bundle, one dispatch', { skip: !canRun }, async () => {
  const employeeId = randomUUID();
  const shadowId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, 'agent', true, true)`,
    [shadowId, `c07-agent-${shadowId}@example.test`, `C07 agent ${shadowId.slice(0, 4)}`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, shadowId, 'member']);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'C07 agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, `c07-agent-${employeeId.slice(0, 8)}`, f.requesterId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadowId, employeeId]);

  const title = `c07c ${randomUUID()}`;
  const actionId = await interruptedAction({
    action: 'create_task',
    params: { title, project_name: await projectName() },
  });
  // The request stopped after the bundle committed and before anything else.
  const committed = await createTaskBundle({
    orgId: f.orgId,
    projectId: f.projectId,
    projectPrefix: f.prefix,
    createdBy: f.requesterId,
    title,
    assigneeId: shadowId,
    actionId,
  });
  const dispatches = async () => (await f.client.query(
    `SELECT count(*)::int AS n FROM job_queue
      WHERE org_id = $1 AND name = 'agent-employee-task' AND data->>'employeeId' = $2`,
    [f.orgId, employeeId],
  )).rows[0].n as number;

  const response = await approve(actionId);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { result?: { task_id?: string }; status?: string };
  assert.equal(body.result?.task_id, committed.parent.id);
  assert.equal(await tasksTitled(title), 1);
  assert.equal(await dispatches(), 1);
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.error, null);
  assert.notEqual(row.executed_at, null);

  const again = await approve(actionId);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(await tasksTitled(title), 1);
  assert.equal(await dispatches(), 1);
});

test('C07-d: a request that lost its claim cannot overwrite the recovery', { skip: !canRun }, async () => {
  const taskId = await insertTask(`c07d ${randomUUID()}`);
  const actionId = await f.insertAction({
    action: 'update_task_status',
    params: { task_identifier: await taskIdentifier(taskId), new_status: 'done' },
    status: 'pending',
    executed: false,
  });

  // Hold the task row so the first request's executor waits mid-execution.
  const locker = new pg.Client({ connectionString: durabilityDatabaseUrl });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
  let first: Promise<Response> | null = null;
  try {
    first = Promise.resolve(approve(actionId));
    const pid = await waitFor(() => leaseHolderPid(actionId), 'the first request to hold the execution lease');
    await waitFor(async () => (await actionRow(actionId)).approval_status === 'approved', 'the claim');
    const claimed = await actionRow(actionId);

    // The first request's lease connection dies while the request itself lives on.
    await f.client.query('SELECT pg_terminate_backend($1)', [pid]);
    await waitFor(async () => (await leaseHolderPid(actionId)) === null, 'the lease to be released');

    const recovery = await approve(actionId);
    assert.equal(recovery.status, 200, await recovery.clone().text());
    assert.equal((await recovery.json() as { status: string }).status, 'failed');
    const recovered = await actionRow(actionId);
    assert.match(recovered.error ?? '', /interrupted/i);
    assert.notEqual(recovered.token, claimed.token);
  } finally {
    await locker.query('COMMIT');
    await locker.end();
  }

  // The first request now finishes its execution. Its own outcome write is
  // rejected: the action stays failed, approved, and on the recovery's claim.
  const late = await first!;
  // Its lease dropped, so it writes nothing (202); had it kept the lease, the
  // claim fence would still refuse the write (409).
  assert.ok([202, 409].includes(late.status), await late.clone().text());
  // The lost request's executor did run; only its outcome write was refused.
  assert.equal(await taskStatus(taskId), 'done');
  const final = await actionRow(actionId);
  assert.equal(final.approval_status, 'approved');
  assert.match(final.error ?? '', /interrupted/i);
});

test('C07-e: a retry repairs the approver decision left pending by a crash, without crediting the retrying user', { skip: !canRun }, async () => {
  const title = `c07e ${randomUUID()}`;
  const actionId = await f.insertAction({
    action: 'create_task',
    params: { title, project_name: await projectName() },
    status: 'approved',
    executed: true,
    result: { task_id: randomUUID() },
  });
  await f.client.query(
    `UPDATE agent_actions SET approved_by_user_id = $2, approved_at = TIMESTAMP '2026-11-01 09:30:00.123456'
      WHERE id = $1`,
    [actionId, f.adminId],
  );
  for (const userId of [f.requesterId, f.adminId]) {
    await f.client.query(
      `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
      [randomUUID(), f.orgId, actionId, userId],
    );
  }
  const approvers = async () => (await f.client.query(
    `SELECT user_id, decision, decided_at::text AS decided_at, updated_at::text AS updated_at
       FROM agent_action_approvers WHERE action_id = $1 ORDER BY user_id`,
    [actionId],
  )).rows as Array<{ user_id: string; decision: string; decided_at: string | null; updated_at: string }>;

  // An admin approved it; the requester, its assigned reviewer, retries the card.
  const response = await approve(actionId, f.requesterId);
  assert.equal(response.status, 200, await response.clone().text());
  const repaired = await approvers();
  const byUser = new Map(repaired.map((row) => [row.user_id, row]));
  assert.equal(byUser.get(f.adminId)?.decision, 'approved');
  assert.equal(byUser.get(f.adminId)?.decided_at, '2026-11-01 09:30:00.123456');
  assert.equal(byUser.get(f.requesterId)?.decision, 'superseded');

  const second = await approve(actionId, f.requesterId);
  assert.equal(second.status, 200, await second.clone().text());
  assert.deepEqual(await approvers(), repaired);
});

test('C07-f: two recoveries racing do the work once', { skip: !canRun }, async () => {
  const title = `c07f ${randomUUID()}`;
  const actionId = await interruptedAction({
    action: 'create_task',
    params: { title, project_name: await projectName() },
  });
  const responses = await Promise.all([approve(actionId), approve(actionId), approve(actionId)]);
  for (const response of responses) {
    assert.ok([200, 202].includes(response.status), await response.clone().text());
  }
  assert.ok(responses.some((response) => response.status === 200));
  assert.equal(await tasksTitled(title), 1);
  const receipts = await f.client.query('SELECT count(*)::int AS n FROM action_receipts WHERE action_id = $1', [actionId]);
  assert.equal(receipts.rows[0].n, 1);
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.error, null);
});

test('C07-g: a stale claim cannot reopen a recovered action as pending', { skip: !canRun }, async () => {
  const actionId = await f.insertAction({
    action: 'update_task_status',
    // The executor reports a retryable failure, which normally reopens the card.
    params: { task_identifier: `${f.prefix}-999999`, new_status: 'done' },
    status: 'pending',
    executed: false,
  });
  const pending = (await f.client.query('SELECT * FROM agent_actions WHERE id = $1', [actionId])).rows[0];
  const staleToken = await claimPendingApproval(pending, f.requesterId);
  assert.ok(staleToken);
  const claimedRow = (await f.client.query('SELECT * FROM agent_actions WHERE id = $1', [actionId])).rows[0];
  assert.equal(await settleInterruptedApproval(claimedRow, staleToken!), true);

  const late = await executeClaimedApproval({ ...claimedRow }, staleToken!, {});
  assert.equal(late.kind, 'superseded');
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.match(row.error ?? '', /interrupted/i);
  assert.notEqual(row.executed_at, null);
  // A second settle with the old claim is refused as well.
  assert.equal(await settleInterruptedApproval(claimedRow, staleToken!), false);
});

test('C07-h: the finaliser is idempotent', { skip: !canRun }, async () => {
  const actionId = await interruptedAction({
    action: 'create_task',
    params: { title: `c07h ${randomUUID()}`, project_name: await projectName() },
  });
  await f.client.query(
    `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), f.orgId, actionId, f.adminId],
  );
  await f.client.query(
    `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), f.orgId, actionId, f.requesterId],
  );
  const response = await approve(actionId);
  assert.equal(response.status, 200, await response.clone().text());

  const snapshot = async () => ({
    approvers: (await f.client.query(
      `SELECT user_id, decision, decided_at::text, updated_at::text FROM agent_action_approvers
        WHERE action_id = $1 ORDER BY user_id`, [actionId])).rows,
    receipts: (await f.client.query(
      'SELECT id, decision, signature_hmac FROM action_receipts WHERE action_id = $1 ORDER BY id', [actionId])).rows,
    action: (await f.client.query(
      'SELECT approval_status, error, result, executed_at::text, approved_at::text, updated_at::text FROM agent_actions WHERE id = $1',
      [actionId])).rows,
  });
  const first = await snapshot();
  assert.equal(first.receipts.length, 1);
  assert.equal(first.approvers.find((row) => row.user_id === f.requesterId)?.decision, 'approved');
  assert.equal(first.approvers.find((row) => row.user_id === f.adminId)?.decision, 'superseded');

  assert.equal(await finalizeApprovalOutcome({ actionId, orgId: f.orgId, receipt: 'legacy' }), true);
  assert.equal(await finalizeApprovalOutcome({ actionId, orgId: f.orgId, receipt: 'legacy' }), true);
  assert.deepEqual(await snapshot(), first);
});

test('C07-i: the maintenance sweep recovers only approvals whose executor is gone', { skip: !canRun }, async () => {
  const params = { task_identifier: `${f.prefix}-1`, new_status: 'done' };
  const live = await interruptedAction({ action: 'update_task_status', params });
  const dead = await interruptedAction({ action: 'update_task_status', params });
  const recent = await interruptedAction({ action: 'update_task_status', params, approvedAgo: '0 seconds' });
  // An action approved by an automatic path that is still running: no claim.
  const automatic = await f.insertAction({ action: 'update_task_status', params, status: 'approved', executed: false });
  await f.client.query("UPDATE agent_actions SET approved_at = now() - interval '1 hour' WHERE id = $1", [automatic]);
  // An employee write queued through the resolver whose request stopped after its claim.
  const resolverOwned = await interruptedAction({ action: 'task_create', params: { title: `c07i ${randomUUID()}` } });
  // An interrupted approval in another workspace is settled within that workspace.
  const otherOrg = randomUUID();
  const foreign = await interruptedAction({ action: 'update_task_status', params: { task_identifier: 'X-1', new_status: 'done' } });
  await f.client.query('UPDATE agent_actions SET org_id = $2 WHERE id = $1', [foreign, otherOrg]);

  const holder = await holdLease(live);
  try {
    const before = await actionRow(live);
    const result = await recoverInterruptedApprovals({ isResolverAction: isApprovalResolverAction, resolverActionNames: APPROVAL_RESOLVER_ACTION_NAMES, batchSize: 100 });
    assert.ok(result.live >= 1);
    assert.deepEqual(await actionRow(live), before);
  } finally {
    await holder.end();
  }

  for (const id of [dead, resolverOwned, foreign]) {
    const row = await actionRow(id);
    assert.equal(row.approval_status, 'approved', id);
    assert.match(row.error ?? '', /interrupted/i, id);
    assert.notEqual(row.executed_at, null, id);
  }
  assert.equal((await f.client.query('SELECT org_id FROM agent_actions WHERE id = $1', [foreign])).rows[0].org_id, otherOrg);
  assert.equal((await actionRow(recent)).executed_at, null);
  assert.equal((await actionRow(automatic)).executed_at, null);
  assert.equal((await actionRow(automatic)).error, null);
  const resolverReceipts = await f.client.query(
    'SELECT decision, decision_reason, approver_id FROM action_receipts WHERE action_id = $1', [resolverOwned]);
  assert.equal(resolverReceipts.rows.length, 1);
  assert.equal(resolverReceipts.rows[0].approver_id, f.requesterId);
  assert.match(resolverReceipts.rows[0].decision_reason, /interrupted/i);
  await f.client.query('DELETE FROM action_receipts WHERE action_id = $1', [foreign]);
  await f.client.query('DELETE FROM agent_action_approvers WHERE action_id = $1', [foreign]);
  await f.client.query('DELETE FROM agent_actions WHERE id = $1', [foreign]);
});

test('C07-j: an interrupted resolver-owned approval is settled as failed on the next approve, not re-run', { skip: !canRun }, async () => {
  const title = `c07j ${randomUUID()}`;
  const actionId = await interruptedAction({ action: 'task_create', params: { title } });
  await f.client.query(
    `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), f.orgId, actionId, f.requesterId],
  );
  const response = await approve(actionId);
  assert.equal(response.status, 500, await response.clone().text());
  const body = await response.json() as { code: string; error: string };
  assert.equal(body.code, 'EXECUTE_FAILED');
  assert.match(body.error, /interrupted/i);
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.notEqual(row.executed_at, null);
  assert.equal(await tasksTitled(title), 0);
  const decision = await f.client.query(
    'SELECT decision FROM agent_action_approvers WHERE action_id = $1 AND user_id = $2', [actionId, f.requesterId]);
  assert.equal(decision.rows[0].decision, 'approved');
});

test('C07-k: a retry of a settled resolver approval resolves Attention as the stored approver, not the retrying user', { skip: !canRun }, async () => {
  const actionId = await f.insertAction({
    action: 'task_create',
    params: { title: `c07k ${randomUUID()}` },
    status: 'pending',
    executed: false,
  });
  for (const userId of [f.requesterId, f.adminId]) {
    await f.client.query(
      `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
      [randomUUID(), f.orgId, actionId, userId],
    );
  }
  const [pending] = (await f.client.query('SELECT * FROM agent_actions WHERE id = $1', [actionId])).rows;
  await syncApprovalToAttention(pending, { deliver: false });
  // Approved and executed by an admin; the request stopped before its bookkeeping.
  await f.client.query(
    `UPDATE agent_actions SET approval_status = 'approved', approved_by_user_id = $2, approved_at = now(),
            executed_at = now(), result = '{"ok":true}'::jsonb WHERE id = $1`,
    [actionId, f.adminId],
  );
  const response = await approve(actionId, f.requesterId);
  assert.equal(response.status, 200, await response.clone().text());
  const events = await f.client.query(
    `SELECT DISTINCT e.actor_user_id FROM attention_events e
       JOIN attention_items i ON i.id = e.attention_item_id
      WHERE i.source_type = 'agent_action' AND i.source_id = $1 AND e.event_type = 'resolved'`,
    [actionId],
  );
  assert.ok(events.rows.length > 0);
  assert.deepEqual(events.rows.map((row) => row.actor_user_id), [f.adminId]);
});

test('C07-l: a request whose lease dropped records no outcome and leaves the action for recovery', { skip: !canRun }, async () => {
  const taskId = await insertTask(`c07l ${randomUUID()}`);
  const actionId = await f.insertAction({
    action: 'update_task_status',
    params: { task_identifier: await taskIdentifier(taskId), new_status: 'done' },
    status: 'pending',
    executed: false,
  });
  const receipts = async () => (await f.client.query(
    'SELECT count(*)::int AS n FROM action_receipts WHERE action_id = $1', [actionId])).rows[0].n as number;
  const decisions = async () => (await f.client.query(
    "SELECT count(*)::int AS n FROM agent_action_approvers WHERE action_id = $1 AND decision = 'approved'", [actionId])).rows[0].n as number;

  const locker = new pg.Client({ connectionString: durabilityDatabaseUrl });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
  let first: Promise<Response> | null = null;
  try {
    first = Promise.resolve(approve(actionId));
    const pid = await waitFor(() => leaseHolderPid(actionId), 'the request to hold the execution lease');
    await waitFor(async () => (await actionRow(actionId)).approval_status === 'approved', 'the claim');
    // The lease connection dies; no recovery runs before the request finishes.
    await f.client.query('SELECT pg_terminate_backend($1)', [pid]);
    await waitFor(async () => (await leaseHolderPid(actionId)) === null, 'the lease to be released');
  } finally {
    await locker.query('COMMIT');
    await locker.end();
  }
  const late = await first!;
  assert.equal(late.status, 202, await late.clone().text());
  assert.equal(await receipts(), 0);
  assert.equal(await decisions(), 0);
  assert.equal((await actionRow(actionId)).approval_status, 'approved');

  // The next approval attempt holds the lease and settles the action once.
  const settled = await approve(actionId);
  assert.equal(settled.status, 200, await settled.clone().text());
  assert.equal(await receipts(), 1);
  assert.equal(await decisions(), 1);
});

test('C07-m: a resolver approval whose lease dropped answers 202 and leaves the action for recovery', { skip: !canRun }, async () => {
  const employeeId = randomUUID();
  const shadowId = randomUUID();
  await f.client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, 'agent', true, true)`,
    [shadowId, `c07m-agent-${shadowId}@example.test`, `C07m agent ${shadowId.slice(0, 4)}`],
  );
  await f.client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)',
    [randomUUID(), f.orgId, shadowId, 'member']);
  await f.client.query(
    `INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
     VALUES ($1, $2, $3, 'C07m agent', $4, 'project_manager', 'Fixture', 'conservative', true, true, $5)`,
    [employeeId, f.orgId, shadowId, `c07m-agent-${employeeId.slice(0, 8)}`, f.requesterId],
  );
  await f.client.query('UPDATE users SET agent_employee_id = $2 WHERE id = $1', [shadowId, employeeId]);
  const actionId = randomUUID();
  await f.client.query(
    `INSERT INTO agent_actions (id, org_id, user_id, agent_employee_id, source, action, params, approval_tier, approval_status)
     VALUES ($1, $2, $3, $4, 'mcp', 'task_create', $5::jsonb, 'full', 'pending')`,
    [actionId, f.orgId, shadowId, employeeId, JSON.stringify({ title: `c07m ${randomUUID()}`, project_id: f.projectId })],
  );
  await f.client.query(
    `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), f.orgId, actionId, f.adminId],
  );

  // Block task inserts so the executor waits mid-execution.
  const locker = new pg.Client({ connectionString: durabilityDatabaseUrl });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('LOCK TABLE tasks IN SHARE MODE');
  let first: Promise<Response> | null = null;
  try {
    first = Promise.resolve(approve(actionId, f.adminId));
    const pid = await waitFor(() => leaseHolderPid(actionId), 'the resolver to hold the execution lease');
    await waitFor(async () => (await actionRow(actionId)).approval_status === 'approved', 'the claim');
    await f.client.query('SELECT pg_terminate_backend($1)', [pid]);
    await waitFor(async () => (await leaseHolderPid(actionId)) === null, 'the lease to be released');
  } finally {
    await locker.query('COMMIT');
    await locker.end();
  }
  const late = await first!;
  assert.equal(late.status, 202, await late.clone().text());
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.executed_at, null);
  // Approval surfaces show an approved row as executing while
  // result.lifecycle_state is 'executing' (web agent-action-presentation.ts).
  assert.equal(row.error, null);
  assert.equal(row.result?.lifecycle_state, 'executing');
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM action_receipts WHERE action_id = $1', [actionId])).rows[0].n, 0);
});

test('C07-n: recovery that finds its lease lost reports it and changes nothing', { skip: !canRun }, async () => {
  const actionId = await interruptedAction({
    action: 'update_task_status',
    params: { task_identifier: `${f.prefix}-1`, new_status: 'done' },
  });
  const before = await actionRow(actionId);
  const [row] = (await f.client.query('SELECT * FROM agent_actions WHERE id = $1', [actionId])).rows;
  const recovery = await recoverInterruptedApproval(row, {}, 'legacy', { lost: true });
  assert.equal(recovery.kind, 'lease_lost');
  assert.deepEqual(await actionRow(actionId), before);
});

const sweepOnce = () => recoverInterruptedApprovals({
  isResolverAction: isApprovalResolverAction,
  resolverActionNames: APPROVAL_RESOLVER_ACTION_NAMES,
  batchSize: 100,
  minimumAgeMs: 0,
});

test('C07-o: maintenance finishes the bookkeeping of a write whose request lost its lease, once', { skip: !canRun }, async () => {
  const taskId = await insertTask(`c07o ${randomUUID()}`);
  const actionId = await f.insertAction({
    action: 'update_task_status',
    params: { task_identifier: await taskIdentifier(taskId), new_status: 'done' },
    status: 'pending',
    executed: false,
  });
  const [pending] = (await f.client.query('SELECT * FROM agent_actions WHERE id = $1', [actionId])).rows;
  await syncApprovalToAttention(pending, { deliver: false });

  const locker = new pg.Client({ connectionString: durabilityDatabaseUrl });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
  let first: Promise<Response> | null = null;
  try {
    first = Promise.resolve(approve(actionId));
    const pid = await waitFor(() => leaseHolderPid(actionId), 'the request to hold the execution lease');
    await waitFor(async () => (await actionRow(actionId)).approval_status === 'approved', 'the claim');
    await f.client.query('SELECT pg_terminate_backend($1)', [pid]);
    await waitFor(async () => (await leaseHolderPid(actionId)) === null, 'the lease to be released');
  } finally {
    await locker.query('COMMIT');
    await locker.end();
  }
  assert.equal((await first!).status, 202);
  // The executor stored its own outcome; the request recorded no bookkeeping.
  assert.notEqual((await actionRow(actionId)).executed_at, null);

  const state = async () => ({
    receipts: (await f.client.query(
      "SELECT approver_id FROM action_receipts WHERE action_id = $1 AND decision = 'approved'", [actionId])).rows,
    decisions: (await f.client.query(
      'SELECT user_id, decision FROM agent_action_approvers WHERE action_id = $1', [actionId])).rows,
    attention: (await f.client.query(
      `SELECT i.state, e.actor_user_id FROM attention_items i
         LEFT JOIN attention_events e ON e.attention_item_id = i.id AND e.event_type = 'resolved'
        WHERE i.source_type = 'agent_action' AND i.source_id = $1`, [actionId])).rows,
    action: (await f.client.query(
      'SELECT approval_status, error, result, executed_at::text, approved_at::text FROM agent_actions WHERE id = $1',
      [actionId])).rows[0],
  });
  const before = await state();
  assert.equal(before.receipts.length, 0);

  const first_ = await sweepOnce();
  assert.ok(first_.finalised >= 1);
  const after = await state();
  assert.deepEqual(after.receipts, [{ approver_id: f.requesterId }]);
  assert.deepEqual(after.decisions, [{ user_id: f.requesterId, decision: 'approved' }]);
  assert.ok(after.attention.length > 0);
  for (const item of after.attention) {
    assert.equal(item.state, 'resolved');
    assert.equal(item.actor_user_id, f.requesterId);
  }
  // Status and outcome are untouched.
  assert.deepEqual(after.action, before.action);

  // The row no longer matches: a second pass changes nothing.
  const second = await sweepOnce();
  assert.equal(second.finalised, 0);
  assert.deepEqual(await state(), after);
});

test('C07-p: maintenance leaves automatic executions and fully settled resolver approvals alone', { skip: !canRun }, async () => {
  // Automatic execution: no stored approver, a pending approver row and no receipt.
  const automatic = await f.insertAction({
    action: 'update_task_status',
    params: { task_identifier: `${f.prefix}-1`, new_status: 'done' },
    status: 'approved',
    executed: true,
    result: { ok: true },
  });
  await f.client.query(
    `INSERT INTO agent_action_approvers (id, org_id, action_id, user_id, decision) VALUES ($1, $2, $3, $4, 'pending')`,
    [randomUUID(), f.orgId, automatic, f.requesterId],
  );
  // Resolver-owned approval that succeeded: the resolver signs its own
  // outcome, so no receipt is due here even though none exists.
  const resolverOwned = await f.insertAction({
    action: 'task_create',
    params: { title: `c07p ${randomUUID()}` },
    status: 'approved',
    executed: true,
    result: { ok: true },
  });
  await f.client.query('UPDATE agent_actions SET approved_by_user_id = $2 WHERE id = $1', [resolverOwned, f.requesterId]);

  await sweepOnce();
  await sweepOnce();
  for (const id of [automatic, resolverOwned]) {
    const receipts = await f.client.query('SELECT count(*)::int AS n FROM action_receipts WHERE action_id = $1', [id]);
    assert.equal(receipts.rows[0].n, 0, id);
  }
  const pending = await f.client.query(
    "SELECT decision FROM agent_action_approvers WHERE action_id = $1", [automatic]);
  assert.deepEqual(pending.rows, [{ decision: 'pending' }]);
});
