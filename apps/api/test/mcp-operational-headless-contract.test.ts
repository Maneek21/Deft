import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTE_MCP_AUTHORIZATION_SCOPES,
  REMOTE_MCP_DEFAULT_READ_SCOPES,
  REMOTE_MCP_SCOPES,
  authorizationScopeSelection,
  normalizeScopes,
  profileForScopes,
} from '../src/lib/oauth-mcp.js';
import { isHttpsPublicUrl } from '../src/lib/public-url.js';
import {
  HUMAN_READ_TOOLS,
  HUMAN_TOOL_SCOPES,
  HUMAN_TOOLS,
  HUMAN_WRITE_TOOLS,
  buildHumanToolSchemas,
  humanToolHasRequiredScope,
} from '../src/lib/mcp-tools/human.js';
import { toolSchemas } from '../src/lib/mcp-tools/index.js';
import {
  MODULE_OPERATION_DEFINITIONS,
  MODULE_OPERATION_NAMES,
} from '@deft/shared/modules';

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
  assert.ok(REMOTE_MCP_SCOPES.includes('read:modules'));
  assert.ok(REMOTE_MCP_SCOPES.includes('write:modules'));
  assert.deepEqual(normalizeScopes(undefined), [
    'read:workspace',
    'read:wiki',
    'read:tasks',
    'read:messages',
    'read:calendar',
  ]);
  assert.equal(normalizeScopes(undefined).includes('read:modules'), false);
  assert.deepEqual(normalizeScopes('read:modules write:modules'), [
    'read:modules',
    'write:modules',
  ]);
  assert.deepEqual(normalizeScopes('write:calendar write:workspace unknown:scope'), [
    'write:calendar',
    'write:workspace',
  ]);
  assert.equal(profileForScopes(['read:workspace']), 'knowledge');
  assert.equal(profileForScopes(['read:workspace', 'write:tasks']), 'task-helper');
  assert.equal(profileForScopes(['read:workspace', 'write:calendar']), 'workspace-operator');
  assert.equal(profileForScopes(['read:workspace', 'write:workspace']), 'workspace-operator');
});

test('scope-less OAuth clients get a read-safe default with explicit access choices', () => {
  const omitted = authorizationScopeSelection(undefined, {});
  assert.deepEqual(omitted.scopes, [...REMOTE_MCP_DEFAULT_READ_SCOPES]);
  assert.deepEqual(omitted.availableScopes, [...REMOTE_MCP_AUTHORIZATION_SCOPES]);
  assert.equal(omitted.mode, 'deft-choice');

  const legacyChatGpt = authorizationScopeSelection(
    'read:workspace read:wiki read:tasks read:messages read:calendar',
    { client_name: 'ChatGPT' },
  );
  assert.deepEqual(legacyChatGpt.scopes, [...REMOTE_MCP_DEFAULT_READ_SCOPES]);
  assert.deepEqual(legacyChatGpt.availableScopes, [...REMOTE_MCP_AUTHORIZATION_SCOPES]);
  assert.equal(legacyChatGpt.mode, 'deft-choice');

  const explicitReadOnly = authorizationScopeSelection(
    'read:workspace read:wiki',
    { scope: 'read:workspace read:wiki' },
  );
  assert.deepEqual(explicitReadOnly.scopes, ['read:workspace', 'read:wiki']);
  assert.deepEqual(explicitReadOnly.availableScopes, ['read:workspace', 'read:wiki']);
  assert.equal(explicitReadOnly.mode, 'client-requested');

  const blockedEscalation = authorizationScopeSelection(
    'read:workspace write:tasks',
    { scope: 'read:workspace' },
  );
  assert.deepEqual(blockedEscalation.scopes, ['read:workspace']);
  assert.deepEqual(blockedEscalation.availableScopes, ['read:workspace']);
});

test('hosted connector readiness requires a real HTTPS public URL', () => {
  assert.equal(isHttpsPublicUrl('http://localhost:3301'), false);
  assert.equal(isHttpsPublicUrl('http://127.0.0.1:3301'), false);
  assert.equal(isHttpsPublicUrl('https://deft.example.com'), true);
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

test('module MCP exposes exactly eight static operations from the shared contract', () => {
  const operationNames = new Set<string>(MODULE_OPERATION_NAMES);
  const agentSchemas = toolSchemas.filter((schema) => operationNames.has(schema.name));
  assert.deepEqual(
    agentSchemas.map((schema) => schema.name).sort(),
    [...MODULE_OPERATION_NAMES].sort(),
  );
  assert.equal(agentSchemas.length, 8);

  const humanSchemas = buildHumanToolSchemas(
    toolSchemas as unknown as Array<Record<string, unknown>>,
  );
  const humanByName = new Map(
    humanSchemas.map((schema) => [String(schema.name), schema]),
  );
  for (const operation of MODULE_OPERATION_NAMES) {
    const agent = agentSchemas.find((schema) => schema.name === operation)!;
    const agentInput = agent.inputSchema as any;
    assert.ok(agentInput.required.includes('caller_employee_slug'));
    assert.equal(agentInput.additionalProperties, false);
    if (MODULE_OPERATION_DEFINITIONS[operation].mode === 'read') {
      assert.match(
        String(agent.description ?? ''),
        /untrusted data[\s\S]*never[\s\S]*instructions/i,
      );
    }

    const human = humanByName.get(operation)!;
    const humanInput = human.inputSchema as any;
    assert.equal(Boolean(humanInput.properties?.caller_employee_slug), false);
    assert.equal(
      (human.annotations as any)?.readOnlyHint,
      MODULE_OPERATION_DEFINITIONS[operation].mode === 'read',
    );
    if (MODULE_OPERATION_DEFINITIONS[operation].mode === 'write') {
      assert.ok(agentInput.required.includes('idempotency_key'));
      assert.ok(humanInput.required.includes('idempotency_key'));
      assert.equal(
        (human.annotations as any)?.destructiveHint,
        MODULE_OPERATION_DEFINITIONS[operation].destructive,
      );
    }
  }
});

test('human module scopes are explicit and generic search/fetch use any granted read scope', () => {
  for (const operation of MODULE_OPERATION_NAMES) {
    const expected = MODULE_OPERATION_DEFINITIONS[operation].mode === 'read'
      ? 'read:modules'
      : 'write:modules';
    assert.equal(HUMAN_TOOL_SCOPES[operation], expected);
    assert.equal(humanToolHasRequiredScope([expected], operation), true);
    assert.equal(humanToolHasRequiredScope([], operation), false);
  }
  assert.equal(humanToolHasRequiredScope(['read:modules'], 'search'), true);
  assert.equal(humanToolHasRequiredScope(['read:modules'], 'fetch'), true);
  assert.equal(humanToolHasRequiredScope(['read:tasks'], 'search'), true);
  assert.equal(humanToolHasRequiredScope([], 'search'), false);
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
