import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTaskReviewLabels, taskReviewAssignmentLines, taskReviewDisplayParams, taskReviewTargets, type TaskReviewLabels } from './agent-task-review-labels';
import { getAgentActionPresentation } from './agent-action-presentation';

const member = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('canonical IDs resolve through the existing scoped endpoints; repeated subtask targets are deduplicated and immutable params survive', async () => {
  const params = { assignee_id: member, project_id: project, assignee_name: 'Unverified name', project_name: 'Unverified project', subtasks: [{ assignee_id: member }] };
  const original = structuredClone(params), paths: string[] = [], seen: TaskReviewLabels[] = [];
  const lookup = loadTaskReviewLabels({ key: 'session/action/targets', targets: taskReviewTargets(params), current: () => true,
    request: async path => { paths.push(path); return response(path.includes('/members/') ? { id: member, name: 'Noah Chen' } : { id: project, name: 'Northstar', is_deleted: false }); }, publish: value => seen.push(value) });
  await lookup.finished;
  assert.deepEqual(paths, [`/api/members/${member}`, `/api/projects/${project}`]);
  assert.equal(taskReviewAssignmentLines(params, seen[0]), `Assignee: Noah Chen (ID: ${member})\nProject: Northstar (ID: ${project})`);
  const pendingPresentation = getAgentActionPresentation({ action: 'task_create', params: taskReviewDisplayParams(params) });
  assert.ok(!JSON.stringify(pendingPresentation).includes('Unverified'));
  const resolvedPresentation = getAgentActionPresentation({ action: 'task_create', params: taskReviewDisplayParams(params, seen[0]) });
  assert.ok(JSON.stringify(resolvedPresentation).includes('Noah Chen'));
  assert.ok(JSON.stringify(resolvedPresentation).includes('Northstar'));
  assert.deepEqual(params, original);
});

test('delayed responses from an earlier action, target or session cannot publish after cleanup', async () => {
  for (const key of ['old-action', 'old-target', 'old-session']) {
    const held = deferred<ReturnType<typeof response>>(), seen: TaskReviewLabels[] = []; let signal!: AbortSignal;
    const lookup = loadTaskReviewLabels({ key, targets: [{ kind: 'members', id: member }], current: () => true,
      request: async (_path, options) => { signal = options.signal; return held.promise; }, publish: value => seen.push(value) });
    lookup.dispose(); held.resolve(response({ id: member, name: 'Old result' })); await lookup.finished;
    assert.equal(signal.aborted, true); assert.deepEqual(seen, []);
  }
});

test('a session change during JSON decoding drops the queued result without needing a render first', async () => {
  const held = deferred<unknown>(), seen: TaskReviewLabels[] = []; let current = true;
  const lookup = loadTaskReviewLabels({ key: 'old', targets: [{ kind: 'members', id: member }], current: () => current,
    request: async () => ({ ok: true, json: () => held.promise }), publish: value => seen.push(value) });
  await Promise.resolve(); current = false; held.resolve({ id: member, name: 'Old result' }); await lookup.finished;
  assert.deepEqual(seen, []);
});

test('unavailable, mismatched and deleted labels preserve exact IDs and never substitute proposal-supplied names', async () => {
  for (const value of [null, { id: project, name: 'Wrong identity' }, { id: member, name: 'Inactive', is_active: false }]) {
    const seen: TaskReviewLabels[] = [];
    await loadTaskReviewLabels({ key: 'current', targets: [{ kind: 'members', id: member }], current: () => true,
      request: async () => response(value, value !== null), publish: item => seen.push(item) }).finished;
    assert.equal(taskReviewAssignmentLines({ assignee_id: member, assignee_name: 'Unverified' }, seen[0]), `Assignee: ID: ${member}`);
  }
  const seen: TaskReviewLabels[] = [];
  await loadTaskReviewLabels({ key: 'current', targets: [{ kind: 'projects', id: project }], current: () => true,
    request: async () => response({ id: project, name: 'Deleted', is_deleted: true }), publish: value => seen.push(value) }).finished;
  assert.equal(taskReviewAssignmentLines({ project_id: project }, seen[0]), `Project: ID: ${project}`);
});
