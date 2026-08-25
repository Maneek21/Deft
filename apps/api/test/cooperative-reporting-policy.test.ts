import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldConsumeAgentDailyActionBudget } from '../src/lib/agent-tool-policy.js';
import { cooperativeRecordDigest } from '../src/lib/mcp-tools/cooperative.js';

test('cooperative reporting does not consume employee execution headroom', () => {
  for (const tool of [
    'record_conversation_turn',
    'record_decision',
    'record_outcome',
    'record_progress',
    'record_reasoning_step',
    'record_action_attempt',
    'request_human_approval',
  ]) {
    assert.equal(shouldConsumeAgentDailyActionBudget(tool), false, tool);
  }
  assert.equal(shouldConsumeAgentDailyActionBudget('task_create'), true);
});

test('cooperative report replay identity is employee, kind, and key scoped', () => {
  const first = cooperativeRecordDigest('org-1', 'employee-1', 'action_attempt', 'tool-call-1');
  assert.equal(
    first,
    cooperativeRecordDigest('org-1', 'employee-1', 'action_attempt', 'tool-call-1'),
  );
  assert.notEqual(
    first,
    cooperativeRecordDigest('org-1', 'employee-2', 'action_attempt', 'tool-call-1'),
  );
});

