import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MODULE_OPERATION_DEFINITIONS,
  MODULE_OPERATION_NAMES,
} from '@deft/shared/modules';
import {
  ACTION_TOOLS,
  AGENT_TOOLS,
  MODULE_AGENT_TOOLS,
} from '../src/lib/agent-tools.js';
import {
  getApprovalTier,
  isDestructiveAction,
  shouldAutoExecute,
} from '../src/lib/agent-approval.js';
import { sanitizeModuleActionParamsForReceipt } from '../src/lib/agent-approval-resolver.js';
import {
  MCP_ACTION_KINDS,
  normalizeMcpApprovalAction,
} from '../src/lib/mcp-approval-actions.js';

test('Defty discovers exactly the shared eight module operations', () => {
  assert.deepEqual(
    MODULE_AGENT_TOOLS.map((tool) => tool.name),
    MODULE_OPERATION_NAMES,
  );
  for (const operation of MODULE_OPERATION_NAMES) {
    assert.equal(
      AGENT_TOOLS.filter((tool) => tool.name === operation).length,
      1,
      `${operation} should appear exactly once in the native tool catalog`,
    );
  }
});

test('Defty module input schemas stay strict and carry concurrency fields', () => {
  const create = MODULE_AGENT_TOOLS.find((tool) => tool.name === 'module_record_create');
  const update = MODULE_AGENT_TOOLS.find((tool) => tool.name === 'module_record_update');
  const archive = MODULE_AGENT_TOOLS.find((tool) => tool.name === 'module_record_archive');
  assert.ok(create && update && archive);

  assert.equal(create.input_schema.additionalProperties, false);
  assert.equal(update.input_schema.additionalProperties, false);
  assert.equal(archive.input_schema.additionalProperties, false);
  assert.deepEqual(
    new Set(create.input_schema.required),
    new Set(['module_id', 'collection_key', 'data', 'expected_manifest_digest', 'idempotency_key']),
  );
  assert.ok(update.input_schema.properties.expected_revision);
  assert.ok(update.input_schema.properties.expected_manifest_digest);
  assert.ok(update.input_schema.properties.relations);
  assert.ok(archive.input_schema.properties.expected_revision);
  assert.ok(archive.input_schema.properties.expected_manifest_digest);
  for (const tool of [create, update, archive]) {
    assert.ok(
      tool.input_schema.required?.includes('idempotency_key'),
      `${tool.name} must require retry-safe idempotency at the Defty boundary`,
    );
  }
});

test('every Defty module read labels manifest and record text as untrusted data', () => {
  for (const operation of [
    'module_list',
    'module_schema_get',
    'module_record_search',
    'module_record_query',
    'module_record_get',
  ]) {
    const tool = MODULE_AGENT_TOOLS.find((item) => item.name === operation);
    assert.ok(tool);
    assert.match(tool.description ?? '', /untrusted data[\s\S]*never[\s\S]*instructions/i);
  }
});

test('only shared module writes enter the native action executor', () => {
  for (const operation of MODULE_OPERATION_NAMES) {
    assert.equal(
      ACTION_TOOLS.has(operation),
      MODULE_OPERATION_DEFINITIONS[operation].mode === 'write',
      `${operation} action classification drifted from the shared contract`,
    );
  }
});

test('module approval tiers and destructive policy derive from the shared contract', () => {
  for (const operation of MODULE_OPERATION_NAMES) {
    assert.equal(
      getApprovalTier(operation),
      MODULE_OPERATION_DEFINITIONS[operation].approval_tier,
    );
    assert.equal(
      isDestructiveAction(operation),
      MODULE_OPERATION_DEFINITIONS[operation].destructive,
    );
  }

  assert.equal(shouldAutoExecute('module_record_create', 'conservative'), false);
  assert.equal(shouldAutoExecute('module_record_create', 'standard'), true);
  assert.equal(shouldAutoExecute('module_record_archive', 'autonomous'), false);
  assert.equal(isDestructiveAction('mcp__deft__module_record_archive'), true);
});

test('module writes use the signed resolver but cannot bypass dedicated preflight', () => {
  for (const action of [
    'module_record_create',
    'module_record_update',
    'module_record_archive',
  ]) {
    assert.equal(MCP_ACTION_KINDS.has(action), true);
    assert.equal(
      normalizeMcpApprovalAction(action, {}, 'test-employee').ok,
      false,
      'generic request_human_approval must not queue module mutations',
    );
  }
});

test('module receipts retain field names and concurrency metadata but no record values', () => {
  const create = sanitizeModuleActionParamsForReceipt('module_record_create', {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    data: { name: 'Alice Example', notes: 'Private CRM note' },
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    idempotency_key: 'alice@example.com',
  });
  assert.deepEqual(create, {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    changed_fields: ['name', 'notes'],
  });
  assert.equal(JSON.stringify(create).includes('Alice Example'), false);
  assert.equal(JSON.stringify(create).includes('Private CRM note'), false);
  assert.equal(JSON.stringify(create).includes('alice@example.com'), false);

  const update = sanitizeModuleActionParamsForReceipt('module_record_update', {
    record_id: 'record_1',
    patch: { email: 'private@example.com', company: 'Acme' },
    unset_fields: ['notes', 'company'],
    relations: { company_id: ['private-company-record'] },
    expected_revision: 4,
    expected_manifest_digest: `sha256:${'b'.repeat(64)}`,
    idempotency_key: 'private@example.com',
  });
  assert.deepEqual(update, {
    record_id: 'record_1',
    expected_manifest_digest: `sha256:${'b'.repeat(64)}`,
    expected_revision: 4,
    changed_fields: ['company', 'company_id', 'email', 'notes'],
  });
  assert.equal(JSON.stringify(update).includes('private@example.com'), false);
  assert.equal(JSON.stringify(update).includes('Acme'), false);
  assert.equal(JSON.stringify(update).includes('private-company-record'), false);
});
