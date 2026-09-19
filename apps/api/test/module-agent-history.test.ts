import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  sanitizeAgentBlocksForStorage,
  sanitizeAgentMetadataForStorage,
} from '../src/lib/module-agent-history.js';

test('module tool history preserves protocol shape without record values or idempotency keys', () => {
  const secret = 'history-secret@example.test';
  const rawKey = 'history-idempotency-secret';
  const toolNames = new Map<string, string>();
  const assistant = sanitizeAgentBlocksForStorage([{
    type: 'tool_use',
    id: 'toolu_module_create',
    name: 'module_record_create',
    input: {
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { name: 'History Secret', email: secret },
      expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
      idempotency_key: rawKey,
    },
  }], toolNames) as Array<Record<string, unknown>>;

  assert.equal(assistant[0]?.type, 'tool_use');
  assert.equal(assistant[0]?.name, 'module_record_create');
  assert.deepEqual(assistant[0]?.input, {
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    expected_manifest_digest: `sha256:${'a'.repeat(64)}`,
    changed_fields: ['email', 'name'],
  });
  assert.doesNotMatch(JSON.stringify(assistant), new RegExp(`${secret}|${rawKey}`));

  const result = sanitizeAgentBlocksForStorage([{
    type: 'tool_result',
    tool_use_id: 'toolu_module_create',
    content: JSON.stringify({ record: { data: { email: secret } } }),
  }], toolNames) as Array<Record<string, unknown>>;
  assert.equal(result[0]?.type, 'tool_result');
  assert.match(String(result[0]?.content), /module_result_redacted/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('successful module writes retain validated resource identities for a later turn', () => {
  const toolNames = new Map<string, string>();
  sanitizeAgentBlocksForStorage([{
    type: 'tool_use',
    id: 'toolu_module_create_identity',
    name: 'module_record_create',
    input: {
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      data: { email: 'must-not-survive@example.test' },
    },
  }], toolNames);

  const [result] = sanitizeAgentBlocksForStorage([{
    type: 'tool_result',
    tool_use_id: 'toolu_module_create_identity',
    content: JSON.stringify({
      resource_id: 'module_record:record_123',
      record_id: 'record_123',
      installation_id: 'installation_123',
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      manifest_digest: `sha256:${'a'.repeat(64)}`,
      revision: 1,
      archived: false,
      changed_fields: ['email'],
      replayed: false,
    }),
  }], toolNames) as Array<Record<string, unknown>>;

  const durableResult = JSON.parse(String(result?.content));
  assert.deepEqual(durableResult, {
    status: 'completed',
    operation: 'module_record_create',
    resource_id: 'module_record:record_123',
    record_id: 'record_123',
    installation_id: 'installation_123',
    module_id: 'com.deft.contacts',
    collection_key: 'contacts',
    revision: 1,
    archived: false,
    changed_fields: ['email'],
    replayed: false,
  });
  assert.doesNotMatch(JSON.stringify(durableResult), /must-not-survive/);
  const [untrustedRehydration] = sanitizeAgentBlocksForStorage([result], toolNames) as Array<Record<string, unknown>>;
  assert.match(String(untrustedRehydration?.content), /module_result_redacted/);
  const [rehydratedResult] = sanitizeAgentBlocksForStorage(
    [result],
    toolNames,
    durableResult,
  ) as Array<Record<string, unknown>>;
  assert.deepEqual(
    JSON.parse(String(rehydratedResult?.content)),
    durableResult,
    'rehydrating already-sanitized history must not erase the durable identifiers',
  );

  const [invalidResult] = sanitizeAgentBlocksForStorage([{
    type: 'tool_result',
    tool_use_id: 'toolu_module_create_identity',
    content: JSON.stringify({
      resource_id: 'module_record:record_123',
      record_id: 'record_123',
      installation_id: 'installation_123',
      module_id: 'com.deft.contacts',
      collection_key: 'contacts',
      manifest_digest: `sha256:${'a'.repeat(64)}`,
      revision: 1,
      archived: false,
      changed_fields: ['email'],
      replayed: false,
      record: { data: { email: 'extra-secret@example.test' } },
    }),
  }], toolNames) as Array<Record<string, unknown>>;
  assert.match(String(invalidResult?.content), /module_result_redacted/);
  assert.doesNotMatch(String(invalidResult?.content), /extra-secret/);
});

test('legacy module reads are redacted while unrelated tool history remains intact', () => {
  const secret = 'legacy-module-secret';
  const names = new Map<string, string>();
  const assistant = sanitizeAgentBlocksForStorage([{
    type: 'tool_use',
    id: 'toolu_module_get',
    name: 'module_record_get',
    input: { record_id: 'record_123', query: secret },
  }, {
    type: 'tool_use',
    id: 'toolu_task',
    name: 'read_task',
    input: { task_id: 'task_123' },
  }], names) as Array<Record<string, unknown>>;
  assert.deepEqual(assistant[0]?.input, { record_id: 'record_123' });
  assert.deepEqual(assistant[1]?.input, { task_id: 'task_123' });

  const results = sanitizeAgentBlocksForStorage([{
    type: 'tool_result',
    tool_use_id: 'toolu_module_get',
    content: JSON.stringify({ data: { notes: secret } }),
  }, {
    type: 'tool_result',
    tool_use_id: 'toolu_task',
    content: JSON.stringify({ title: 'Keep this task result' }),
  }], names) as Array<Record<string, unknown>>;
  assert.doesNotMatch(String(results[0]?.content), new RegExp(secret));
  assert.match(String(results[1]?.content), /Keep this task result/);
});

test('module tool badges keep safe identities but omit sensitive params', () => {
  const metadata = sanitizeAgentMetadataForStorage({
    tool_calls: [{
      tool: 'module_record_search',
      params: {
        module_id: 'com.deft.contacts',
        query: 'private-search-term',
        limit: 10,
      },
    }],
  });
  assert.deepEqual(metadata.tool_calls, [{
    tool: 'module_record_search',
    params: { module_id: 'com.deft.contacts', limit: 10 },
  }]);
  assert.doesNotMatch(JSON.stringify(metadata), /private-search-term/);
});

test('module task-link history redacts results and raw retry keys', () => {
  const privateTitle = 'Private linked contact sentinel';
  const rawKey = 'module-task-link-history-key';
  const names = new Map<string, string>();
  const assistant = sanitizeAgentBlocksForStorage([{
    type: 'tool_use',
    id: 'toolu_module_task_link',
    name: 'module_record_task_link',
    input: {
      resource_id: 'module_record:record_123',
      task_identifier: 'DEFT-42',
      idempotency_key: rawKey,
    },
  }], names) as Array<Record<string, unknown>>;
  assert.deepEqual(assistant[0]?.input, {
    resource_id: 'module_record:record_123',
    task_identifier: 'DEFT-42',
  });
  assert.doesNotMatch(JSON.stringify(assistant), new RegExp(rawKey));

  const result = sanitizeAgentBlocksForStorage([{
    type: 'tool_result',
    tool_use_id: 'toolu_module_task_link',
    content: JSON.stringify({ title: privateTitle, module_name: 'Contacts' }),
  }], names) as Array<Record<string, unknown>>;
  assert.match(String(result[0]?.content), /module_result_redacted/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateTitle));

  const metadata = sanitizeAgentMetadataForStorage({
    tool_calls: [{
      tool: 'module_record_task_unlink',
      params: {
        resource_id: 'module_record:record_123',
        task_identifier: 'DEFT-42',
        idempotency_key: rawKey,
      },
    }],
  });
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(rawKey));
});
