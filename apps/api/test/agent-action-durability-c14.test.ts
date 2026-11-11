/**
 * Lane W2-a2 — C14: the completion message after the last sibling action is
 * settled tells succeeded actions apart from failed ones, and never says a
 * failed one was done.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-c14.test.ts
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { formatApprovalConfirmation } from '../src/lib/agent-action-confirmation.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('CF');
});

after(async () => {
  if (f) await f.teardown();
});

test('C14: confirmation copy reports a failed sibling as failed', () => {
  const text = formatApprovalConfirmation([
    { action: 'wiki_write', params: { title: 'Trial guide' }, result: { action: 'updated' } },
    { action: 'create_note', params: { title: 'Buyer notes' }, result: null, error: 'Note could not be saved' },
  ]);
  assert.doesNotMatch(text, /completed 2/);
  assert.doesNotMatch(text, /Created note "Buyer notes"/);
  assert.match(text, /Updated wiki page "Trial guide"/);
  assert.match(text, /create note "Buyer notes" did not complete/i);
});

test('C14: when every approved action failed the copy does not start with Done', () => {
  const text = formatApprovalConfirmation([
    { action: 'create_note', params: { title: 'Buyer notes' }, error: 'boom' },
  ]);
  assert.doesNotMatch(text, /^Done/);
  assert.match(text, /did not complete/);
});

test('C14: the posted completion message for a group with a failed sibling does not claim it succeeded', { skip: !canRun }, async () => {
  const sourceId = await f.insertMessage('Proposed: a note and a post.');
  await f.insertAction({
    action: 'create_note',
    params: { title: 'c14 failed note', content: 'x' },
    result: null,
    error: 'Note could not be saved',
    messageId: sourceId,
  });
  const postId = await f.insertAction({
    action: 'post_message',
    params: { space_id: f.spaceId, content: 'c14 post body' },
    status: 'pending',
    executed: false,
    messageId: sourceId,
  });

  const response = await f.as(f.requesterId, `/api/agent/actions/${postId}/approve`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  const confirmation = await f.client.query(
    `SELECT content, metadata FROM messages
      WHERE org_id = $1 AND metadata->>'approval_confirmation_for_message_id' = $2`,
    [f.orgId, sourceId],
  );
  assert.equal(confirmation.rows.length, 1);
  const content = confirmation.rows[0].content as string;
  assert.doesNotMatch(content, /Created note "c14 failed note"/);
  assert.doesNotMatch(content, /completed 2/);
  assert.match(content, /did not complete/);
  assert.equal((confirmation.rows[0].metadata.confirmed_action_ids as string[]).length, 1);
});
