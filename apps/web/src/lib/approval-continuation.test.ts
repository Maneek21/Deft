import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvalContinuationGate,
  consumeAgentContinuationStream,
  type ApprovalContinuationMessage,
} from './approval-continuation';

function message(
  id: string,
  metadata: Record<string, unknown> = {},
): ApprovalContinuationMessage {
  return { id, metadata };
}

const confirmation = message('confirmation-1', {
  subtype: 'approval_confirmation',
  approval_confirmation_for_message_id: 'proposal-1',
});

function gate(overrides: Partial<Parameters<typeof approvalContinuationGate>[0]> = {}) {
  return approvalContinuationGate({
    spaceType: 'agent_conversation',
    confirmationId: confirmation.id,
    messages: [message('proposal-1'), confirmation],
    pendingByMessage: {},
    pendingActionsLoaded: true,
    pendingActionsUnavailable: false,
    busy: false,
    alreadyContinued: false,
    ...overrides,
  });
}

test('offers continuation for the latest settled approval confirmation', () => {
  assert.deepEqual(gate(), {
    show: true,
    disabled: false,
    sourceMessageId: 'proposal-1',
    reason: 'ready',
  });
});

test('does not offer continuation while a sibling approval is pending', () => {
  assert.deepEqual(
    gate({ pendingByMessage: { 'proposal-1': [{ id: 'pending-sibling' }] } }),
    { show: false, disabled: true, reason: 'pending_actions' },
  );
  assert.deepEqual(
    gate({ pendingActionsLoaded: false }),
    { show: false, disabled: true, reason: 'pending_actions_loading' },
  );
});

test('does not treat an unavailable pending-actions snapshot as settled', () => {
  assert.deepEqual(
    approvalContinuationGate({
      spaceType: 'agent_conversation',
      confirmationId: confirmation.id,
      messages: [message('proposal-1'), confirmation],
      pendingByMessage: {},
      pendingActionsLoaded: true,
      pendingActionsUnavailable: true,
      busy: false,
      alreadyContinued: false,
    }),
    { show: false, disabled: true, reason: 'pending_actions_unavailable' },
  );
});

test('disables continuation while the current request is running', () => {
  assert.deepEqual(gate({ busy: true }), {
    show: true,
    disabled: true,
    sourceMessageId: 'proposal-1',
    reason: 'busy',
  });
});

test('does not offer a stale confirmation after a newer response', () => {
  assert.deepEqual(
    gate({ messages: [message('proposal-1'), confirmation, message('agent-response', { is_agent_reply: true })] }),
    { show: false, disabled: true, reason: 'stale' },
  );
  assert.deepEqual(
    gate({ alreadyContinued: true }),
    { show: false, disabled: true, reason: 'already_continued' },
  );
});

test('limits the control to valid confirmations in agent conversations', () => {
  assert.equal(gate({ spaceType: 'dm' }).show, false);
  assert.equal(gate({ messages: [message('proposal-1'), message('confirmation-1')] }).show, false);
});

test('drains continuation SSE and surfaces a streamed server error', async () => {
  const success = new Response([
    'data: {"type":"heartbeat"}',
    '',
    'data: {"type":"text","text":"Continuing"}',
    '',
    'data: {"type":"done"}',
    '',
  ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } });
  await consumeAgentContinuationStream(success);

  const failure = new Response('data: {"type":"error","error":"Provider unavailable"}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  await assert.rejects(consumeAgentContinuationStream(failure), /Provider unavailable/);

  const interrupted = new Response('data: {"type":"text","text":"Continuing"}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  await assert.rejects(consumeAgentContinuationStream(interrupted), /ended before completion/);
});
