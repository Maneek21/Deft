import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REMOTE_MCP_AUTHORIZATION_SCOPES,
  REMOTE_MCP_APP_SCOPES,
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
  humanToolChallengeScope,
  humanToolHasRequiredScope,
} from '../src/lib/mcp-tools/human.js';
import {
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  agentAppToolHasRequiredScope,
  agentAppToolRequiredScopes,
  toolSchemas,
} from '../src/lib/mcp-tools/index.js';
import { ACTION_TOOLS, AGENT_TOOLS } from '../src/lib/agent-tools.js';
import {
  APP_ACTION_OPERATION_NAMES,
  APP_ACTION_OPERATION_PRIMARY_SCOPES,
} from '../src/lib/app-action-operations.js';
import {
  MODULE_OPERATION_DEFINITIONS,
  MODULE_OPERATION_NAMES,
} from '@deft/shared/modules';
import { closeDb } from '../src/lib/db.js';

after(async () => closeDb());

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
  assert.deepEqual(REMOTE_MCP_APP_SCOPES, ['read:apps', 'invoke:apps', 'read:app-runs']);
  for (const scope of REMOTE_MCP_APP_SCOPES) {
    assert.ok(REMOTE_MCP_SCOPES.includes(scope));
    assert.equal((REMOTE_MCP_DEFAULT_READ_SCOPES as readonly string[]).includes(scope), false);
  }
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
  assert.equal(profileForScopes(['read:modules', 'invoke:apps']), 'task-helper');
});

test('App operations use one fixed shallow adapter vocabulary on native and MCP surfaces', () => {
  const nativeNames = AGENT_TOOLS
    .filter((tool) => APP_ACTION_OPERATION_NAMES.some((name) => name === tool.name))
    .map((tool) => tool.name);
  assert.deepEqual(nativeNames, [...APP_ACTION_OPERATION_NAMES]);

  const humanSchemas = buildHumanToolSchemas(
    toolSchemas as unknown as Array<Record<string, unknown>>,
  );
  const humanByName = new Map(humanSchemas.map((schema) => [String(schema.name), schema]));

  for (const operation of APP_ACTION_OPERATION_NAMES) {
    assert.equal(ACTION_TOOLS.has(operation), false, `${operation} must not enter legacy approval`);
    assert.equal(typeof READ_ONLY_TOOLS[operation], 'function');
    assert.equal(WRITE_TOOLS[operation], undefined, `${operation} must not consume the generic budget`);

    const employeeSchema = toolSchemas.find((schema) => schema.name === operation)!;
    assert.ok(employeeSchema);
    assert.ok((employeeSchema.inputSchema as any).required.includes('caller_employee_slug'));
    assert.equal((employeeSchema.inputSchema as any).additionalProperties, false);

    const expectedPrimary = APP_ACTION_OPERATION_PRIMARY_SCOPES[operation];
    assert.equal(HUMAN_TOOL_SCOPES[operation], expectedPrimary);
    assert.deepEqual(
      agentAppToolRequiredScopes(operation),
      operation === 'app_run_get' ? [expectedPrimary] : ['read:modules', expectedPrimary],
    );
    assert.equal(agentAppToolHasRequiredScope([], operation), false);
    assert.equal(
      agentAppToolHasRequiredScope(
        operation === 'app_run_get' ? [expectedPrimary] : ['read:modules', expectedPrimary],
        operation,
      ),
      true,
    );
    if (operation !== 'app_run_get') {
      assert.equal(humanToolHasRequiredScope([expectedPrimary], operation), false);
      assert.equal(humanToolChallengeScope(operation, [expectedPrimary]), 'read:modules');
    }

    const humanSchema = humanByName.get(operation)!;
    assert.ok(humanSchema);
    assert.equal((humanSchema.inputSchema as any).properties?.caller_employee_slug, undefined);
    assert.equal(
      (humanSchema.annotations as any)?.readOnlyHint,
      operation !== 'app_binding_invoke',
    );
  }
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
