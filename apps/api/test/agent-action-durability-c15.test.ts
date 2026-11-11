/**
 * Lane W2-a2 — C15: when an approve and a reject race, the route records the
 * decision, resolves Attention and answers with what the resolver actually
 * did (the winner), never the losing request's own decision.
 *
 * The race is made deterministic: the test holds the lock the losing request
 * needs, settles the row the other way, then releases it.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-c15.test.ts
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';
import { eq } from 'drizzle-orm';
import pg from 'pg';

import { agentActions } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { syncApprovalToAttention } from '../src/lib/attention.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;
let blocker: pg.Client;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('RC');
  blocker = new pg.Client({ connectionString: durabilityDatabaseUrl });
  await blocker.connect();
});

after(async () => {
  if (blocker) await blocker.end();
  if (f) await f.teardown();
});

async function pendingResolverAction(): Promise<string> {
  const actionId = await f.insertAction({
    action: 'task_create',
    params: { title: 'c15 race', project_id: f.projectId },
    status: 'pending',
    executed: false,
  });
  const [row] = await db.select().from(agentActions).where(eq(agentActions.id, actionId)).limit(1);
  await syncApprovalToAttention(row!, { deliver: false });
  return actionId;
}

async function waitForBlockedBackend(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await f.client.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    if (rows.rows[0].n > 0) return;
    await delay(20);
  }
  throw new Error('the request never waited on the held lock');
}

async function decisions(actionId: string) {
  const rows = await f.client.query(
    'SELECT user_id, decision FROM agent_action_approvers WHERE action_id = $1',
    [actionId],
  );
  return new Map(rows.rows.map((row) => [row.user_id as string, row.decision as string]));
}

async function attentionResolutions(actionId: string): Promise<string[]> {
  const rows = await f.client.query(
    "SELECT state, resolution FROM attention_items WHERE source_type = 'agent_action' AND source_id = $1",
    [actionId],
  );
  return rows.rows.map((row) => `${row.state}:${row.resolution}`);
}

test('C15: an approve that loses to a reject records no approval and resolves Attention as rejected', { skip: !canRun }, async () => {
  const actionId = await pendingResolverAction();
  assert.ok((await attentionResolutions(actionId)).length > 0, 'fixture needs an open Attention item');

  await blocker.query("SELECT pg_advisory_lock(hashtextextended('agent-approval:' || $1, 0))", [actionId]);
  const approving = f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  await waitForBlockedBackend();
  await blocker.query("UPDATE agent_actions SET approval_status = 'rejected' WHERE id = $1", [actionId]);
  await blocker.query("SELECT pg_advisory_unlock(hashtextextended('agent-approval:' || $1, 0))", [actionId]);
  const response = await approving;

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(((await response.json()) as { status: string }).status, 'rejected');
  assert.notEqual((await decisions(actionId)).get(f.requesterId), 'approved');
  for (const resolution of await attentionResolutions(actionId)) {
    assert.equal(resolution, 'resolved:rejected');
  }
});

test('C15: a reject that loses to an approve records no rejection and resolves Attention as approved', { skip: !canRun }, async () => {
  const actionId = await pendingResolverAction();

  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM agent_actions WHERE id = $1 FOR UPDATE', [actionId]);
  const rejecting = f.as(f.requesterId, `/api/agent/actions/${actionId}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'no' }),
  });
  await waitForBlockedBackend();
  await blocker.query("UPDATE agent_actions SET approval_status = 'approved', approved_at = now() WHERE id = $1", [actionId]);
  await blocker.query('COMMIT');
  const response = await rejecting;

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(((await response.json()) as { status: string }).status, 'approved');
  assert.notEqual((await decisions(actionId)).get(f.requesterId), 'rejected');
  for (const resolution of await attentionResolutions(actionId)) {
    assert.equal(resolution, 'resolved:approved');
  }
});
