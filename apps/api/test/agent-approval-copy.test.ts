import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileApprovalReplyText } from '../src/lib/agent-approval-copy.js';

test('terminal approval copy removes the live awaits-approval paraphrase', () => {
  const context = 'I have prepared a task titled "QA — approval status reconciliation" in the Northstar Launch project, assigned to you.';
  const outcome = 'Done - Created NTH-37: QA — approval status reconciliation.';
  assert.equal(
    reconcileApprovalReplyText(`${context} It awaits your approval before creation.`, outcome),
    `${context}\n\n${outcome}`,
  );
});
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

test('approval dependency sentences reconcile across wording and terminal outcomes', () => {
  const context = 'The source is [Northstar](https://example.com/playbook). The approval policy is conservative.';
  for (const pending of [
    'The task is awaiting approval.',
    'Your approval is required to create it.',
    'I need approval to proceed.',
    'I will create it once you approve.',
    'Please confirm the proposal to proceed.',
    'Queued 2 actions for your approval (create task, assign task) — confirm the cards above to proceed.',
  ]) {
    for (const outcome of ['Done - Created NTH-37.', 'Rejected 1 proposed action.', 'Failed to create the task.']) {
      assert.equal(reconcileApprovalReplyText(`${context}\n\n${pending}`, outcome), `${context}\n\n${outcome}`);
    }
  }
});

test('non-action approval context and citations survive reconciliation', () => {
  const context = 'The task is titled "QA — approval status reconciliation". Read [Approval requirements](https://example.com/approval-policy). The approval policy is conservative. Email requires approval for every send. The policy requires approval.';
  const outcome = 'Rejected 1 proposed action.';
  assert.equal(reconcileApprovalReplyText(context, outcome), `${context}\n\n${outcome}`);
});
