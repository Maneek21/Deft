import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileApprovalReplyText } from '../src/lib/agent-approval-copy.js';
test('terminal approval copy keeps grounding and replaces the known pending claim', () => {
  const proposal = 'The playbook is [Northstar](/knowledge/playbook).\n\nI have drafted a task. This is pending your approval before creation.\n\nUse the approval card below this message to approve or dismiss it. It is also mirrored in Inbox under Needs you.';
  const result = reconcileApprovalReplyText(proposal, 'Done - Created NTH-33.');
  assert.match(result, /\[Northstar\]\(\/knowledge\/playbook\)/);
  assert.match(result, /Done - Created NTH-33/);
  assert.doesNotMatch(result, /pending your approval|approve or dismiss/);
});
test('failed or rejected outcomes never claim execution succeeded; unrelated facts remain', () => {
  for (const outcome of ['Rejected 1 proposed action.', 'Failed to create the task.']) {
    const result = reconcileApprovalReplyText('The approval policy is conservative. Queued the **create task** action for your approval — confirm the card above to proceed.', outcome);
    assert.match(result, /approval policy is conservative/);
    assert.ok(result.includes(outcome));
    assert.doesNotMatch(result, /confirm the card above/);
  }
});
