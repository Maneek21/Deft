/**
 * Lane W2-a2 — E04 (API side): approving again an action that was approved
 * but failed answers `failed` with its error, not "already approved".
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-e04.test.ts
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

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

test('E04: re-approving an approved action whose execution failed answers failed with the error', { skip: !canRun }, async () => {
  const actionId = await f.insertAction({
    action: 'create_note',
    params: { title: 'e04 note', content: 'x' },
    result: null,
    error: 'Note could not be saved',
  });
  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { status: string; error?: string };
  assert.equal(body.status, 'failed');
  assert.equal(body.error, 'Note could not be saved');
});

test('E04: re-approving a successful approved action still answers approved', { skip: !canRun }, async () => {
  const actionId = await f.insertAction({
    action: 'create_note',
    params: { title: 'e04 ok', content: 'x' },
    result: { note_id: 'n1' },
  });
  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  const body = await response.json() as { status: string };
  assert.equal(body.status, 'approved');
});
