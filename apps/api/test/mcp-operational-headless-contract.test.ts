import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REMOTE_MCP_SCOPES, normalizeScopes } from '../src/lib/oauth-mcp.js';
import {
  HUMAN_READ_TOOLS,
  HUMAN_TOOL_SCOPES,
  HUMAN_TOOLS,
  HUMAN_WRITE_TOOLS,
  buildHumanToolSchemas,
} from '../src/lib/mcp-tools/human.js';
import { toolSchemas } from '../src/lib/mcp-tools/index.js';

const READ_TOOLS = [
  'workspace_capabilities',
  'note_list',
  'note_get',
  'calendar_list',
  'calendar_get',
  'calendar_availability',
  'inbox_list',
  'inbox_get',
  'approval_list',
  'approval_get',
  'task_saved_view_list',
  'agent_employee_list',
  'agent_employee_get',
];

const WRITE_TOOLS = [
  'note_create',
  'note_update',
  'note_archive',
  'calendar_event_create',
  'calendar_event_update',
  'calendar_event_cancel',
  'inbox_mark_read',
  'inbox_mark_all_read',
  'approval_approve',
  'approval_reject',
  'project_create',
  'project_update',
  'project_archive',
  'task_saved_view_create',
  'agent_employee_update_state',
];

test('operational headless scopes are accepted without weakening default read grants', () => {
  assert.ok(REMOTE_MCP_SCOPES.includes('write:calendar'));
  assert.ok(REMOTE_MCP_SCOPES.includes('write:workspace'));
  assert.deepEqual(normalizeScopes(undefined), [
    'read:workspace',
    'read:wiki',
    'read:tasks',
    'read:messages',
    'read:calendar',
  ]);
  assert.deepEqual(normalizeScopes('write:calendar write:workspace unknown:scope'), [
    'write:calendar',
    'write:workspace',
  ]);
});

test('every operational tool is registered, classified, and advertised once', () => {
  const schemas = buildHumanToolSchemas(toolSchemas as unknown as Array<Record<string, unknown>>);
  const schemaByName = new Map(schemas.map((schema) => [String(schema.name), schema]));
  assert.equal(new Set(schemas.map((schema) => String(schema.name))).size, schemas.length);
  for (const name of [...HUMAN_READ_TOOLS, ...HUMAN_WRITE_TOOLS]) {
    assert.ok(HUMAN_TOOL_SCOPES[name], `${name} must have an explicit scope contract`);
  }

  for (const name of READ_TOOLS) {
    assert.ok(HUMAN_READ_TOOLS.has(name), `${name} must be a read tool`);
    assert.equal(typeof HUMAN_TOOLS[name], 'function', `${name} must have a handler`);
    assert.equal((schemaByName.get(name)?.annotations as any)?.readOnlyHint, true);
  }
  for (const name of WRITE_TOOLS) {
    assert.ok(HUMAN_WRITE_TOOLS.has(name), `${name} must be a write tool`);
    assert.equal(typeof HUMAN_TOOLS[name], 'function', `${name} must have a handler`);
    const schema = schemaByName.get(name)!;
    assert.equal((schema.annotations as any)?.readOnlyHint, false);
    assert.ok((schema.inputSchema as any)?.properties?.idempotency_key, `${name} must advertise retry safety`);
  }
  assert.equal((schemaByName.get('calendar_event_cancel')?.annotations as any)?.destructiveHint, true);
});

test('capability catalog keeps dangerous administration out of MCP', () => {
  const names = new Set(buildHumanToolSchemas(toolSchemas as unknown as Array<Record<string, unknown>>).map((schema) => String(schema.name)));
  for (const forbidden of [
    'member_remove',
    'member_change_role',
    'transfer_ownership',
    'billing_update',
    'provider_secret_set',
    'agent_employee_reveal_token',
    'agent_employee_delete',
    'project_delete',
  ]) {
    assert.equal(names.has(forbidden), false, `${forbidden} must remain UI-only`);
  }
});
