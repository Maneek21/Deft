import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OBSERVE_CHAT_MESSAGE_JOB } from '../src/lib/chat-observation.js';
import { jobPriorityRank, QUEUE_NAMES } from '../src/lib/queues.js';

test('agent reply and employee action jobs outrank bulk observation jobs', () => {
  assert.equal(jobPriorityRank(QUEUE_NAMES.AGENT_JOBS, 'agent-reply'), 0);
  assert.equal(jobPriorityRank(QUEUE_NAMES.AGENT_JOBS, 'agent-employee-message'), 0);
  assert.equal(jobPriorityRank(QUEUE_NAMES.AGENT_JOBS, 'employee-trigger'), 1);
  assert.equal(jobPriorityRank(QUEUE_NAMES.AGENT_JOBS, 'plan-executor'), 1);
  assert.equal(jobPriorityRank(QUEUE_NAMES.AGENT_JOBS, 'some-background-job'), 3);
  assert.equal(jobPriorityRank(QUEUE_NAMES.AGENT_JOBS, OBSERVE_CHAT_MESSAGE_JOB), 5);
});

test('non-agent queues keep neutral priority', () => {
  assert.equal(jobPriorityRank(QUEUE_NAMES.SCHEDULED_JOBS, 'agent-reply'), 3);
  assert.equal(jobPriorityRank('custom-queue', OBSERVE_CHAT_MESSAGE_JOB), 3);
});
