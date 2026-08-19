import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_TOOLS, AGENT_TOOLS } from '../src/lib/agent-tools.js';
import { getApprovalTier } from '../src/lib/agent-approval.js';
import { normalizeAgentModuleTaskLinkParams } from '../src/lib/agent-actions.js';
import {
  MODULE_GOVERNED_WRITE_ACTION_NAMES,
  isModuleGovernedWriteActionName,
} from '../src/lib/module-action-visibility.js';

test('static module task tools expose one read and two governed idempotent writes', () => {
  const byName = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));
  for (const name of [
    'module_record_task_links',
    'module_record_task_link',
    'module_record_task_unlink',
  ]) {
    assert.ok(byName.has(name), `${name} must be advertised to Defty`);
  }
  assert.equal(ACTION_TOOLS.has('module_record_task_links'), false);
  assert.equal(ACTION_TOOLS.has('module_record_task_link'), true);
  assert.equal(ACTION_TOOLS.has('module_record_task_unlink'), true);
  assert.equal(getApprovalTier('module_record_task_links'), 'auto');
  assert.equal(getApprovalTier('module_record_task_link'), 'quick');
  assert.equal(getApprovalTier('module_record_task_unlink'), 'quick');
  assert.equal(isModuleGovernedWriteActionName('module_record_task_link'), true);
  assert.equal(isModuleGovernedWriteActionName('module_record_task_unlink'), true);
  assert.equal(MODULE_GOVERNED_WRITE_ACTION_NAMES.includes('module_record_task_link'), true);

  for (const action of ['module_record_task_link', 'module_record_task_unlink']) {
    const schema = byName.get(action)?.input_schema as { required?: string[] };
    assert.deepEqual(
      schema.required,
      ['resource_id', 'task_identifier', 'idempotency_key'],
      `${action} must require a caller-stable retry key`,
    );
  }

  assert.throws(() => normalizeAgentModuleTaskLinkParams('module_record_task_link', {
    resource_id: 'module_record:record_123',
    task_identifier: 'x'.repeat(129),
    idempotency_key: 'bounded-key',
  }));
  assert.throws(() => normalizeAgentModuleTaskLinkParams('module_record_task_link', {
    resource_id: 'module_record:record_123',
    task_identifier: 'DEFT-12',
    idempotency_key: 'x'.repeat(129),
  }));
  assert.throws(() => normalizeAgentModuleTaskLinkParams('module_record_task_link', {
    resource_id: 'module_record:record_123',
    task_identifier: 'DEFT 12',
    idempotency_key: 'bounded-key',
  }));
});
