import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCoalescedRefresh,
  createSnapshotGuard,
  progressAfterRead,
  progressFromEvent,
  type TaskAgentProgress,
  type TaskAgentProgressEvent,
} from './task-agent-progress';

const event: TaskAgentProgressEvent = {
  task_id: 'task-1',
  agent_employee_id: 'employee-1',
  step_index: 0,
  total_steps: 1,
  step_description: 'Agent employee activity updated',
  status: 'started',
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

test('W2a4-B-web: a progress event shows its neutral state, then the text the task read returns', () => {
  const neutral = progressFromEvent(event);
  assert.equal(neutral.step_description, 'Agent employee activity updated');
  const fetched: TaskAgentProgress = { ...neutral, step_description: 'Drafted the vendor comparison' };
  assert.equal(progressAfterRead(neutral, { agent_progress: fetched, agent_outcome: null })?.step_description, 'Drafted the vendor comparison');
});

test('W2a4-B-web: a task read without progress keeps the neutral state; an outcome clears the strip', () => {
  const neutral = progressFromEvent({ ...event, step_index: 1, total_steps: 3, step_description: 'Step 2 of 3' });
  assert.deepEqual(progressAfterRead(neutral, { agent_progress: null }), neutral);
  assert.equal(progressAfterRead(neutral, { agent_progress: null, agent_outcome: { business_outcome: 'completed' } }), null);
});

test('W2a4-B-web: one event triggers one task read', async () => {
  let reads = 0;
  const refresh = createCoalescedRefresh(async () => { reads += 1; });
  await refresh();
  assert.equal(reads, 1);
});

test('W2a4-B-web: a burst of events keeps at most one task read in flight and ends with one more', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  const gates: Array<ReturnType<typeof deferred>> = [];
  const refresh = createCoalescedRefresh(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    reads += 1;
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    inFlight -= 1;
  });
  const first = refresh();
  for (let i = 0; i < 5; i += 1) void refresh();
  gates[0]!.resolve();
  await new Promise((r) => setTimeout(r, 0));
  gates[1]!.resolve();
  await first;
  assert.equal(maxInFlight, 1);
  assert.equal(reads, 2, 'the burst during the first read causes exactly one more read');
});

test('W2a4-B-web: a failed read does not stop later events from refreshing', async () => {
  let reads = 0;
  const refresh = createCoalescedRefresh(async () => {
    reads += 1;
    if (reads === 1) throw new Error('network');
  });
  await refresh();
  await refresh();
  assert.equal(reads, 2);
});

test('a progress read that started before a terminal event is not applied after it', async () => {
  const guard = createSnapshotGuard();
  const applied: string[] = [];
  const response = deferred();
  const read = (async () => {
    const isCurrent = guard.capture();
    await response.promise;
    if (isCurrent()) applied.push('started');
  })();
  // The terminal event arrives and its reload finishes while the read is in flight.
  guard.invalidate();
  applied.push('completed');
  response.resolve();
  await read;
  assert.deepEqual(applied, ['completed']);

  const later = guard.capture();
  assert.equal(later(), true, 'a read started after the terminal event applies');
});
