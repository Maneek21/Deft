import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS } from '../src/lib/agent-tools.js';
import { toolSchemas } from '../src/lib/mcp-tools/index.js';
import { HUMAN_TOOLS, buildHumanToolSchemas, humanToolHasRequiredScope } from '../src/lib/mcp-tools/human.js';
import { RUNTIME_WORKFLOW_NAMES, RUNTIME_WORKFLOW_TOOL_SCHEMAS, runtimeWorkflowHasScopes, employeeRuntimeWorkflowTool } from '../src/lib/app-runtime-workflow-tools.js';

test('native and MCP advertise the same bounded workflow; approval stays host-only', () => {
  const human = buildHumanToolSchemas(toolSchemas);
  for (const descriptor of RUNTIME_WORKFLOW_TOOL_SCHEMAS) {
    assert.deepEqual(AGENT_TOOLS.find(t => t.name === descriptor.name)?.input_schema, descriptor.inputSchema);
    assert.deepEqual(human.find(t => t.name === descriptor.name)?.inputSchema, descriptor.inputSchema);
    assert.equal(typeof HUMAN_TOOLS[descriptor.name], 'function');
  }
  assert(!RUNTIME_WORKFLOW_NAMES.some(name => /approve|confirm/.test(name)));
  assert(!human.some(t => t.name === 'app_action_batch_approve'));
});

test('every runtime workflow scope is required, not any one of the scopes', () => {
  assert(!humanToolHasRequiredScope(['read:apps'], 'app_action_batch_propose'));
  assert(!humanToolHasRequiredScope(['invoke:apps'], 'app_action_batch_propose'));
  assert(humanToolHasRequiredScope(['read:apps', 'invoke:apps'], 'app_action_batch_propose'));
  assert(!runtimeWorkflowHasScopes('app_action_batch_cancel', ['read:app-runs']));
  assert(runtimeWorkflowHasScopes('app_action_batch_get', ['read:app-runs']));
});

test('an employee without a scoped credential cannot enter the workflow', async () => {
  const result = await employeeRuntimeWorkflowTool('app_action_batch_propose', {}, {
    org_id: '00000000-0000-4000-8000-000000000001', employee_id: '00000000-0000-4000-8000-000000000002',
    employee_slug: 'test', trust_level: 'autonomous', scopes: ['read:apps','invoke:apps'],
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /APP_RUN_ACCESS_DENIED/);
});
