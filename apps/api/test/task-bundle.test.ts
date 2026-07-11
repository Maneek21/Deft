import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_TOOLS } from '../src/lib/agent-tools.js';
import { toolSchemas } from '../src/lib/mcp-tools/index.js';
import {
  normalizeTaskDescriptionForStorage,
  summarizeTaskBundleParams,
  validateTaskBundleSubtasks,
} from '../src/lib/task-bundle.js';

test('task bundle description formatter turns plain bullet text into readable HTML', () => {
  const html = normalizeTaskDescriptionForStorage(`Context:
- First step
- Second step

Owner notes here.`);

  assert.equal(
    html,
    '<h3>Context</h3><ul><li>First step</li><li>Second step</li></ul><p>Owner notes here.</p>',
  );
});

test('task bundle summarizer keeps real subtasks out of description-only drafts', () => {
  const summary = summarizeTaskBundleParams({
    title: 'Launch buyer outreach',
    description: 'Coordinate buyer launch follow-up.',
    subtasks: [
      { title: 'Draft buyer email', assignee_name: 'Lina', priority: 'p1' },
      { title: 'Review pricing sheet', due_date: '2026-07-16' },
      { title: '  ' },
    ],
  });

  assert.equal(summary.title, 'Launch buyer outreach');
  assert.equal(summary.subtask_count, 2);
  assert.deepEqual(summary.subtasks, [
    { title: 'Draft buyer email', priority: 'p1', assignee_name: 'Lina', due_date: null },
    { title: 'Review pricing sheet', priority: undefined, assignee_name: null, due_date: '2026-07-16' },
  ]);
});

test('Defty create_task tool advertises structured subtasks', () => {
  const createTask = AGENT_TOOLS.find((tool) => tool.name === 'create_task');
  assert.ok(createTask);
  const properties = createTask.input_schema.properties as Record<string, unknown>;
  assert.ok(properties.subtasks);
});

test('MCP task_create tool advertises structured subtasks', () => {
  const taskCreate = toolSchemas.find((tool) => tool.name === 'task_create');
  assert.ok(taskCreate);
  const inputSchema = taskCreate.inputSchema as { properties?: Record<string, unknown> };
  assert.ok(inputSchema.properties?.subtasks);
});

test('task bundles accept 1, 3, and 10 well-formed subtasks', () => {
  for (const count of [1, 3, 10]) {
    assert.doesNotThrow(() => validateTaskBundleSubtasks(Array.from({ length: count }, (_, index) => ({
      title: `Step ${index + 1}`,
      ...(index > 0 ? { depends_on: [index] } : {}),
    }))));
  }
});

test('task bundles reject malformed, nested, oversized, and forward dependencies', () => {
  assert.throws(() => validateTaskBundleSubtasks([{ title: '' }]), /requires a title/);
  assert.throws(() => validateTaskBundleSubtasks([{ title: 'Parent', subtasks: [{ title: 'Nested' }] }]), /nested subtasks/);
  assert.throws(() => validateTaskBundleSubtasks(Array.from({ length: 21 }, (_, i) => ({ title: `Step ${i}` }))), /no more than 20/);
  assert.throws(() => validateTaskBundleSubtasks([{ title: 'First', depends_on: [1] }]), /earlier subtask/);
});
