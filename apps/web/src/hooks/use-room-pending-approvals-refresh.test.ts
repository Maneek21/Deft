import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isApprovalAttentionEvent, ROOM_PENDING_APPROVALS_REFRESH_MS } from './use-room-pending-approvals-refresh';

test('a room re-reads its approvals on an approval Inbox event, and on nothing else', () => {
  assert.equal(isApprovalAttentionEvent({ id: 'a', source_type: 'agent_action' }), true);
  for (const item of [{ source_type: 'message' }, { source_type: 'task' }, {}, null, undefined, 'agent_action']) {
    assert.equal(isApprovalAttentionEvent(item), false, JSON.stringify(item));
  }
});

test('the rooms poll their approvals only as a fallback, every 30 seconds, and both re-read on the events', () => {
  assert.equal(ROOM_PENDING_APPROVALS_REFRESH_MS, 30_000);
  for (const file of ['../components/space-chat.tsx', '../components/thread-panel.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/pending-by-space[\s\S]{0,1200}refreshInterval: 5000/.test(source), `${file}: no 5-second poll`);
    assert.ok(source.includes('refreshInterval: ROOM_PENDING_APPROVALS_REFRESH_MS'), `${file}: the fallback interval`);
    assert.ok(source.includes('useRoomPendingApprovalsRefresh(pendingBySpaceKey, refreshPendingApprovals)'), `${file}: re-reads on the events`);
  }
});
