import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineApprovalDisplayContent } from './agent-approval-copy';

const AGENT_TEXT = 'I can create the task "Ship the beta". Please check your Inbox under the Approvals tab to approve or reject this task creation.';
const pending = { 'agent-msg': [{ id: 'action-1' }] };

test('E09: a human message is never rewritten, even when another message has a pending approval', () => {
  const human = { id: 'human-msg', metadata: null };
  const text = 'Can you approve or reject the vendor contract by Friday?';
  assert.equal(inlineApprovalDisplayContent(human, text, pending), text);
});

test('E09: a human message with approval-like words is kept even if it is the action anchor', () => {
  const human = { id: 'agent-msg', metadata: {} };
  const text = 'Please approve or reject the task by noon.';
  assert.equal(inlineApprovalDisplayContent(human, text, pending), text);
});

test('E09: an agent reply without its own pending approval keeps its text', () => {
  const otherAgentReply = { id: 'older-agent-msg', metadata: { is_agent_reply: true } };
  assert.equal(inlineApprovalDisplayContent(otherAgentReply, AGENT_TEXT, pending), AGENT_TEXT);
});

test('E09: an agent reply with its own inline approval points at the card', () => {
  const agentReply = { id: 'agent-msg', metadata: { is_agent_reply: true } };
  assert.equal(
    inlineApprovalDisplayContent(agentReply, AGENT_TEXT, pending),
    'I drafted the task. Review the approval card below.',
  );
});

test('E09: no pending approvals means no rewrite', () => {
  const agentReply = { id: 'agent-msg', metadata: { is_agent_reply: true } };
  assert.equal(inlineApprovalDisplayContent(agentReply, AGENT_TEXT, {}), AGENT_TEXT);
  assert.equal(inlineApprovalDisplayContent(agentReply, AGENT_TEXT, undefined), AGENT_TEXT);
});
