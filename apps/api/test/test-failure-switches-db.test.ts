/**
 * Test failure switches (launch check 13, cases 13.9 and 13.10): an
 * operator-only setting that makes an approved action fail, finally or once
 * retryably, and an assistant reply hang. Off by default; a wrong value
 * stops the API at startup.
 *
 * The approval cases need a disposable DB:
 *   pnpm --filter @deft/api test test/test-failure-switches-db.test.ts
 */
import assert from 'node:assert/strict';
import test, { after, afterEach, before } from 'node:test';

import {
  FAIL_APPROVAL_FINAL_MARKER,
  FAIL_APPROVAL_RETRYABLE_MARKER,
  FORCED_FINAL_FAILURE_ERROR,
  FORCED_RETRYABLE_FAILURE_ERROR,
  HANG_REPLY_MARKER,
  TEST_FAILURE_SWITCHES_SETTING,
  forcedApprovalFailure,
  hangReplyForTestSwitch,
  testFailureSwitchesEnabled,
  validateTestFailureSwitchesEnvironment,
} from '../src/lib/test-failure-switches.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('FS');
});

after(async () => {
  if (f) await f.teardown();
});

afterEach(() => {
  delete process.env[TEST_FAILURE_SWITCHES_SETTING];
});

const CELL = { DEFT_CELL_ID: 'cell-7f3a9c' };

test('the switch is off unless set, and only an exact value turns it on', () => {
  assert.equal(testFailureSwitchesEnabled(false, {}), false);
  assert.equal(testFailureSwitchesEnabled(true, { ...CELL }), false);
  assert.equal(testFailureSwitchesEnabled(false, { DEFT_TEST_FAILURE_SWITCHES: 'on' }), true);
  assert.equal(testFailureSwitchesEnabled(true, { ...CELL, DEFT_TEST_FAILURE_SWITCHES: 'cell:cell-7f3a9c' }), true);
  // Hosted mode needs the cell's own id; "on" alone or another cell's id is refused.
  assert.equal(testFailureSwitchesEnabled(true, { ...CELL, DEFT_TEST_FAILURE_SWITCHES: 'on' }), false);
  assert.equal(testFailureSwitchesEnabled(true, { ...CELL, DEFT_TEST_FAILURE_SWITCHES: 'cell:cell-other' }), false);
  assert.equal(testFailureSwitchesEnabled(true, { DEFT_TEST_FAILURE_SWITCHES: 'cell:' }), false);
});

test('a set but wrong value stops the API at startup', () => {
  assert.doesNotThrow(() => validateTestFailureSwitchesEnvironment(false, {}));
  assert.doesNotThrow(() => validateTestFailureSwitchesEnvironment(true, { ...CELL }));
  assert.doesNotThrow(() => validateTestFailureSwitchesEnvironment(false, { DEFT_TEST_FAILURE_SWITCHES: 'on' }));
  assert.doesNotThrow(() => validateTestFailureSwitchesEnvironment(true, { ...CELL, DEFT_TEST_FAILURE_SWITCHES: 'cell:cell-7f3a9c' }));
  for (const value of ['', 'true', 'ON', 'on ', 'off', '1', 'cell:cell-7f3a9c']) {
    assert.throws(() => validateTestFailureSwitchesEnvironment(false, { DEFT_TEST_FAILURE_SWITCHES: value }),
      /must be exactly "on"/, JSON.stringify(value));
  }
  for (const value of ['', 'on', 'true', 'cell:cell-other', 'cell:cell-7f3a9c ']) {
    assert.throws(() => validateTestFailureSwitchesEnvironment(true, { ...CELL, DEFT_TEST_FAILURE_SWITCHES: value }),
      /does not name this cell/, JSON.stringify(value));
  }
  assert.throws(() => validateTestFailureSwitchesEnvironment(true, { DEFT_TEST_FAILURE_SWITCHES: 'cell:' }),
    /does not name this cell/);
});

test('markers do nothing while the switch is off', async () => {
  const params = { content: `${FAIL_APPROVAL_FINAL_MARKER} ${FAIL_APPROVAL_RETRYABLE_MARKER}` };
  assert.equal(forcedApprovalFailure({ params, result: null }), null);
  const controller = new AbortController();
  await hangReplyForTestSwitch(`hello ${HANG_REPLY_MARKER}`, controller.signal);
});

test('the retryable switch fires once; the final switch every time', () => {
  process.env[TEST_FAILURE_SWITCHES_SETTING] = 'on';
  const retry = forcedApprovalFailure({ params: { content: FAIL_APPROVAL_RETRYABLE_MARKER }, result: null });
  assert.equal(retry?.error, FORCED_RETRYABLE_FAILURE_ERROR);
  assert.equal(forcedApprovalFailure({
    params: { content: FAIL_APPROVAL_RETRYABLE_MARKER },
    result: { ...retry!.result, lifecycle_state: 'failed', retryable: true },
  }), null);
  // An ordinary earlier retryable failure does not count as the switch's one shot.
  assert.equal(forcedApprovalFailure({
    params: { content: FAIL_APPROVAL_RETRYABLE_MARKER },
    result: { lifecycle_state: 'failed', retryable: true },
  })?.error, FORCED_RETRYABLE_FAILURE_ERROR);
  assert.equal(forcedApprovalFailure({ params: { content: FAIL_APPROVAL_FINAL_MARKER }, result: null })?.error,
    FORCED_FINAL_FAILURE_ERROR);
  assert.equal(forcedApprovalFailure({ params: { content: 'plain' }, result: null }), null);
});

test('a reply carrying the hang marker waits until the job is aborted', async () => {
  process.env[TEST_FAILURE_SWITCHES_SETTING] = 'on';
  await hangReplyForTestSwitch('an ordinary question', new AbortController().signal);
  const controller = new AbortController();
  let settled = false;
  const hang = hangReplyForTestSwitch(`question ${HANG_REPLY_MARKER}`, controller.signal)
    .finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  controller.abort(new Error('job timed out'));
  await assert.rejects(hang, /job timed out/);
});

async function postedCount(content: string): Promise<number> {
  const rows = await f.client.query(
    'SELECT count(*)::int AS n FROM messages WHERE org_id = $1 AND space_id = $2 AND content LIKE $3',
    [f.orgId, f.spaceId, `%${content}%`],
  );
  return rows.rows[0].n as number;
}

async function actionRow(id: string) {
  const rows = await f.client.query('SELECT approval_status, error, executed_at FROM agent_actions WHERE id = $1', [id]);
  return rows.rows[0];
}

test('with the switch on, an approved action marked to fail finally answers "failed" and does not run', { skip: !canRun }, async () => {
  process.env[TEST_FAILURE_SWITCHES_SETTING] = 'on';
  const content = `fs final ${FAIL_APPROVAL_FINAL_MARKER}`;
  const id = await f.insertAction({
    action: 'post_message', params: { space_id: f.spaceId, content }, status: 'pending', executed: false,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await f.as(f.requesterId, `/api/agent/actions/${id}/approve`, { method: 'POST' });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.status, 'failed');
    assert.equal(body.error, FORCED_FINAL_FAILURE_ERROR);
  }
  const row = await actionRow(id);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.error, FORCED_FINAL_FAILURE_ERROR);
  assert.equal(await postedCount(content), 0);
});

test('with the switch on, a retryable-marked action stays pending once, then runs exactly once', { skip: !canRun }, async () => {
  process.env[TEST_FAILURE_SWITCHES_SETTING] = 'on';
  const content = `fs retry ${FAIL_APPROVAL_RETRYABLE_MARKER}`;
  const id = await f.insertAction({
    action: 'post_message', params: { space_id: f.spaceId, content }, status: 'pending', executed: false,
  });
  const first = await f.as(f.requesterId, `/api/agent/actions/${id}/approve`, { method: 'POST' });
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = await first.json() as Record<string, unknown>;
  assert.equal(firstBody.status, 'pending');
  assert.equal(firstBody.retryable, true);
  assert.equal(firstBody.error, FORCED_RETRYABLE_FAILURE_ERROR);
  assert.equal((await actionRow(id)).approval_status, 'pending');
  assert.equal(await postedCount(content), 0);

  const retry = await f.as(f.requesterId, `/api/agent/actions/${id}/approve`, { method: 'POST' });
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal(((await retry.json()) as Record<string, unknown>).success, true);
  const again = await f.as(f.requesterId, `/api/agent/actions/${id}/approve`, { method: 'POST' });
  assert.equal(((await again.json()) as Record<string, unknown>).status, 'approved');
  const row = await actionRow(id);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.error, null);
  assert.equal(await postedCount(content), 1);
});

test('with the switch off, a marked action runs normally', { skip: !canRun }, async () => {
  const content = `fs off ${FAIL_APPROVAL_FINAL_MARKER}`;
  const id = await f.insertAction({
    action: 'post_message', params: { space_id: f.spaceId, content }, status: 'pending', executed: false,
  });
  const response = await f.as(f.requesterId, `/api/agent/actions/${id}/approve`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(((await response.json()) as Record<string, unknown>).success, true);
  assert.equal(await postedCount(content), 1);
});
