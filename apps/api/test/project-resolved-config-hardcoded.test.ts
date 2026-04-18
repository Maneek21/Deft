import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProjectResolvedConfig } from '../src/lib/project-resolved-config.js';
import {
  ENGINEERING_STATUSES,
  ENGINEERING_TRANSITIONS,
} from '../src/lib/task-status-machine.js';

test('getProjectResolvedConfig returns engineering defaults for any project id', async () => {
  const resolved = await getProjectResolvedConfig('any-project-id-even-nonexistent');
  assert.deepEqual(resolved.statuses, ENGINEERING_STATUSES);
  assert.deepEqual(resolved.allowed_transitions, ENGINEERING_TRANSITIONS);
  assert.equal(resolved.default_view, 'board');
  assert.equal(resolved.hide_prefix_ids, false);
  assert.deepEqual(resolved.custom_fields, []);
  assert.deepEqual(resolved.task_templates, []);
  assert.equal(resolved.priority_vocab?.kind, 'numbered');
  assert.deepEqual(resolved.priority_vocab?.labels, ['p0', 'p1', 'p2', 'p3']);
});

test('getProjectResolvedConfig returns structurally-equal object across multiple calls (same project id)', async () => {
  const a = await getProjectResolvedConfig('proj-1');
  const b = await getProjectResolvedConfig('proj-1');
  assert.deepEqual(a, b);
});

test('getProjectResolvedConfig returns structurally-equal object for different project ids (no per-project overrides)', async () => {
  const a = await getProjectResolvedConfig('proj-a');
  const b = await getProjectResolvedConfig('proj-b');
  assert.deepEqual(a, b);
});
