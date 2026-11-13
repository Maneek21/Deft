// An approve that answers "failed" keeps its card on screen with the reason,
// on every surface that approves through the shared approval card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { failedApprovalSnapshot, getAgentActionDisplayStatus } from './agent-action-presentation';

const reason = 'The wiki page changed after this update was proposed, so it was not applied. Review the current page and propose the update again.';

test('a failed approve answer keeps the action as approved with its reason', () => {
  const action = { id: 'a1', action: 'wiki_update', params: {}, approval_status: 'pending' };
  const failed = failedApprovalSnapshot(action, { status: 'failed', message: 'approved, but it did not complete', error: reason, code: 'WIKI_PAGE_CHANGED' });
  assert.ok(failed);
  assert.equal(failed.error, reason);
  assert.equal(getAgentActionDisplayStatus(failed), 'failed');
  assert.equal(failedApprovalSnapshot(action, { status: 'failed' })?.error, 'The approved action did not complete.');
});

test('other approve answers keep nothing', () => {
  const action = { id: 'a1' };
  for (const answer of [{ status: 'approved' }, { status: 'rejected' }, { status: 'executing' }, null, undefined]) {
    assert.equal(failedApprovalSnapshot(action, answer), null);
  }
});

test('every approve surface keeps its failed approvals after the refresh', () => {
  for (const path of ['../app/(app)/inbox/page.tsx', '../components/notification-panel.tsx', '../components/space-chat.tsx', '../components/thread-panel.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /useRetainedApprovalFailures\(\)/, path);
  }
  const inbox = readFileSync(new URL('../app/(app)/inbox/page.tsx', import.meta.url), 'utf8');
  assert.match(inbox, /retain\(tab, action, result\);\s*(\/\/[^\n]*\n\s*)?await refresh\(\);/);
  assert.match(inbox, /items\.length === 0 && failedApprovals\.length === 0/);
  const panel = readFileSync(new URL('../components/notification-panel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /if \(action === 'approve'\) retain\('needs_you', card, result\);\s*await refresh\(\);/);
  assert.match(panel, /items\.length === 0 && failedApprovals\.length === 0/);
  for (const path of ['../components/space-chat.tsx', '../components/thread-panel.tsx']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /retainFailure\(msg(Id|\.id), action, body\);/, path);
    assert.match(source, /retainedFailures\(msg(Id|\.id), /, path);
  }
});
