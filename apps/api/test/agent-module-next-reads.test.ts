import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseDeftModuleManifest, type ModuleOperationName } from '@deft/shared/modules';

import {
  createModuleNextReadsResolver,
  nativeAgentToolResult,
  nativeAgentToolResultContent,
} from '../src/lib/agent-module-next-reads.js';
import { createAgentMessage } from '../src/lib/agent-llm.js';

const MODULE_ID = 'com.deft.contacts';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const manifest = parseDeftModuleManifest(JSON.parse(readFileSync(
  new URL('../../../modules/bundled/contacts/deft.module.json', import.meta.url),
  'utf8',
)));

const collectionContracts = manifest.collections.map((collection) => ({
  collection_key: collection.key,
  relation_fields: collection.fields.flatMap((field) => field.type === 'relation'
    ? [{
        field_key: field.key,
        target_collection: field.target_collection,
        cardinality: field.multiple ? 'many' as const : 'one' as const,
        required: field.required,
        request_value_shape: 'record_id[]' as const,
      }]
    : []),
  examples: { create: {}, update: {} },
}));

function schemaResult() {
  return {
    installation_id: 'installation-1',
    enabled: true,
    manifest_digest: DIGEST,
    manifest,
    operation_contracts: {
      module_record_create: { input_schema: {} },
      module_record_update: { input_schema: {} },
    },
    collection_contracts: collectionContracts,
  };
}

function searchHit(collectionKey = 'companies', id = 'company-01', title = 'Company 01') {
  return {
    resource_id: `module_record:${id}`,
    record_id: id,
    installation_id: 'installation-1',
    module_id: MODULE_ID,
    module_slug: 'contacts',
    module_name: 'Contacts',
    collection_key: collectionKey,
    collection_name: collectionKey,
    title,
    subtitle: null,
    snippet: null,
    url: `/modules/contacts/${collectionKey}/${id}`,
    score: 1,
    updated_at: '2026-09-17T00:00:00.000Z',
  };
}

function moduleRecord(collectionKey: string, id: string, data: Record<string, unknown> = {}) {
  return {
    resource_id: `module_record:${id}`,
    id,
    installation_id: 'installation-1',
    module_id: MODULE_ID,
    collection_key: collectionKey,
    manifest_digest: DIGEST,
    data: { name: `Untrusted ${collectionKey} ${id}`, ...data },
    relations: [],
    members: [],
    revision: 1,
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
    archived_at: null,
  };
}

function linkedTask() {
  return {
    edge_id: 'edge-01',
    task_id: 'task-01',
    title: 'Follow up on the implementation brief',
    identifier: 'CRM-7',
    status: 'todo',
    priority: 'p1',
    due_date: '2026-09-16',
    assignee_id: null,
    assignee_name: null,
    project_id: 'project-01',
    project_name: 'CRM Review',
    url: '/tasks?task=task-01',
    created_at: '2026-09-17T00:00:00.000Z',
  };
}

const allReadTools = [
  'module_record_search',
  'module_schema_get',
  'module_record_get',
  'module_record_incoming',
  'module_record_task_links',
];

function sourcesForRecords(items: Array<{ resource_id: string; collection_key: string; id: string }>) {
  return items.map((item) => ({
    type: 'module_record',
    id: item.resource_id,
    title: item.id,
    url: `/modules/contacts/${item.collection_key}/${item.id}`,
  }));
}

function twoHopExecutor(calls: Array<{ operation: string; input: Record<string, unknown> }>) {
  return async (operation: ModuleOperationName, input: Record<string, unknown>) => {
    calls.push({ operation, input });
    if (operation === 'module_schema_get') return { result: schemaResult(), sources: [] };
    if (operation === 'module_record_get') {
      const record = moduleRecord('companies', String(input.record_id), { status: 'prospect' });
      return { result: { record }, sources: sourcesForRecords([record]) };
    }
    if (operation === 'module_record_task_links') {
      const resourceId = String(input.resource_id);
      const tasks = resourceId === 'module_record:deal-01' ? [linkedTask()] : [];
      return {
        result: { resource_id: resourceId, tasks, count: tasks.length, next_offset: null },
        sources: tasks.map((task) => ({ type: 'task', id: task.task_id, title: task.identifier, url: task.url })),
      };
    }
    if (operation === 'module_record_incoming') {
      const recordId = String(input.record_id);
      const collection = String(input.collection_key);
      let items: ReturnType<typeof moduleRecord>[] = [];
      if (recordId === 'company-01' && collection === 'contacts') items = [moduleRecord('contacts', 'contact-01')];
      if (recordId === 'company-01' && collection === 'deals') items = [moduleRecord('deals', 'deal-01')];
      if (recordId === 'contact-01' && collection === 'deals') items = [moduleRecord('deals', 'deal-01')];
      if (recordId === 'contact-01' && collection === 'outreach') {
        items = [moduleRecord('outreach', 'outreach-01', { subject: 'Hidden-name outreach draft' })];
      }
      return { result: { items, next_cursor: null }, sources: sourcesForRecords(items) };
    }
    throw new Error(`Unexpected operation ${operation}`);
  };
}

test('single seed expands two declared hops and linked tasks without hidden-name searches', async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const resolver = createModuleNextReadsResolver({
    availableToolNames: allReadTools,
    executeRead: twoHopExecutor(calls),
  });
  const formatted = await nativeAgentToolResult({
    resolver,
    operation: 'module_record_search',
    input: { query: 'Company 01', module_id: MODULE_ID, collection_key: 'companies', limit: 10 },
    result: { items: [searchHit()], next_cursor: null },
    sources: [{ type: 'module_record', id: 'module_record:company-01', title: 'Company 01', url: '/modules/contacts/companies/company-01' }],
  });

  const payload = JSON.parse(formatted.content);
  assert.equal(payload.relationship_context.status, 'ready');
  assert.equal(payload.relationship_context.seed_source, 'original');
  assert.equal(payload.relationship_context.cycle_skipped, 1);
  assert.equal(
    payload.relationship_context.nodes.filter((node: any) => node.resource_id === 'module_record:deal-01').length,
    1,
    'the same deal returned through company and contact edges is queued once',
  );
  assert.equal(payload.relationship_context.incomplete_reasons.length, 0);
  assert.ok(payload.relationship_context.nodes.some((node: any) => node.resource_id === 'module_record:outreach-01' && node.depth === 2));
  const taskRead = payload.relationship_context.reads.find((read: any) => (
    read.operation === 'module_record_task_links' && read.input.resource_id === 'module_record:deal-01'
  ));
  assert.equal(taskRead.result.tasks[0].identifier, 'CRM-7');
  assert.equal(calls.some((call) => Object.values(call.input).includes('Hidden-name outreach draft')), false);
  assert.ok(formatted.sources.some((source: any) => source.id === 'module_record:outreach-01'));
  assert.ok(formatted.sources.some((source: any) => source.id === 'task-01'));
  assert.ok(calls.length <= 18);
  assert.equal(
    calls.filter((call) => call.operation === 'module_record_task_links' && call.input.resource_id === 'module_record:deal-01').length,
    1,
    'the repeated deal id is read once rather than traversed as a second node',
  );
});

test('repeated searches on one resolver never reserve more than the per-run node cap', async () => {
  const resolver = createModuleNextReadsResolver({
    availableToolNames: ['module_record_search'],
    executeRead: async () => { throw new Error('no automatic read tool is advertised'); },
  });
  let finalContext: any = null;
  for (let index = 0; index < 13; index += 1) {
    const formatted = await nativeAgentToolResult({
      resolver,
      operation: 'module_record_search',
      input: { query: `Company ${index}`, module_id: MODULE_ID, collection_key: 'companies', limit: 1 },
      result: { items: [searchHit('companies', `company-${index}`, `Company ${index}`)], next_cursor: null },
      sources: [],
    });
    finalContext = JSON.parse(formatted.content).relationship_context;
  }
  assert.equal(finalContext.budget.used_nodes, finalContext.budget.max_nodes);
  assert.equal(finalContext.status, 'unavailable');
  assert.deepEqual(finalContext.incomplete_reasons, ['budget_exhausted']);
  assert.deepEqual(finalContext.nodes, []);
});

test('empty scoped search reports a separate broad fallback and never substitutes the original empty result', async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const base = twoHopExecutor(calls);
  const resolver = createModuleNextReadsResolver({
    availableToolNames: allReadTools,
    executeRead: async (operation, input) => {
      if (operation === 'module_record_search') {
        calls.push({ operation, input });
        return {
          result: { items: [searchHit()], next_cursor: null },
          sources: [{ type: 'module_record', id: 'module_record:company-01', title: 'Company 01', url: '/modules/contacts/companies/company-01' }],
        };
      }
      return base(operation, input);
    },
  });
  const content = await nativeAgentToolResultContent({
    resolver,
    operation: 'module_record_search',
    input: { query: 'Company 01', module_id: MODULE_ID, collection_key: 'contacts', limit: 10 },
    result: { items: [], next_cursor: null },
    sources: [],
  });
  const payload = JSON.parse(content);

  assert.deepEqual(payload.result, { items: [], next_cursor: null });
  assert.equal(payload.relationship_context.seed_source, 'fallback');
  assert.equal(payload.relationship_context.fallback_search.attempted, true);
  assert.deepEqual(payload.relationship_context.fallback_search.input, {
    query: 'Company 01', module_id: MODULE_ID, limit: 5,
  });
  assert.equal(payload.relationship_context.fallback_search.result.items[0].record_id, 'company-01');
  assert.equal(calls.filter((call) => call.operation === 'module_record_search').length, 1);
});

test('ambiguous fallback does not choose or expand a record', async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const resolver = createModuleNextReadsResolver({
    availableToolNames: allReadTools,
    executeRead: async (operation, input) => {
      calls.push({ operation, input });
      assert.equal(operation, 'module_record_search');
      return { result: { items: [searchHit(), searchHit('companies', 'company-02', 'Company 02')], next_cursor: null }, sources: [] };
    },
  });
  const formatted = await nativeAgentToolResult({
    resolver,
    operation: 'module_record_search',
    input: { query: 'Company', module_id: MODULE_ID, collection_key: 'contacts', limit: 10 },
    result: { items: [], next_cursor: null },
    sources: [],
  });
  const context = JSON.parse(formatted.content).relationship_context;
  assert.equal(context.status, 'ambiguous');
  assert.equal(context.seed, null);
  assert.deepEqual(context.reads, []);
  assert.deepEqual(context.incomplete_reasons, ['ambiguous_seed']);
  assert.equal(calls.length, 1);
});

test('policy loss halfway stops further reads and reports unavailable rather than empty', async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const resolver = createModuleNextReadsResolver({
    availableToolNames: allReadTools,
    executeRead: async (operation, input) => {
      calls.push({ operation, input });
      if (operation === 'module_schema_get') return { result: schemaResult(), sources: [] };
      throw new Error('revoked private policy detail');
    },
  });
  const formatted = await nativeAgentToolResult({
    resolver,
    operation: 'module_record_search',
    input: { query: 'Company 01', module_id: MODULE_ID, collection_key: 'companies', limit: 10 },
    result: { items: [searchHit()], next_cursor: null },
    sources: [],
  });
  const context = JSON.parse(formatted.content).relationship_context;
  assert.equal(context.status, 'partial');
  assert.ok(context.incomplete_reasons.includes('read_failed'));
  assert.equal(context.reads[0].status, 'unavailable');
  assert.equal(JSON.stringify(context).includes('revoked private policy detail'), false);
  assert.equal(calls.length, 2, 'no reads continue after the first revoked/failed operation');
});

test('cycles, pagination, policy filters, and hard budgets remain explicit', async () => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const resolver = createModuleNextReadsResolver({
    availableToolNames: allReadTools,
    executeRead: async (operation, input) => {
      calls.push({ operation, input });
      if (operation === 'module_schema_get') return { result: schemaResult(), sources: [] };
      if (operation === 'module_record_get') return { result: { record: moduleRecord('companies', 'company-01') }, sources: [] };
      if (operation === 'module_record_task_links') {
        return { result: { resource_id: input.resource_id, tasks: [], count: 0, next_offset: null }, sources: [] };
      }
      if (operation === 'module_record_incoming') {
        const collection = String(input.collection_key);
        const items = Array.from({ length: Number(input.limit) }, (_, index) => (
          moduleRecord(collection, `${collection}-${String(input.record_id)}-${index}`)
        ));
        return { result: { items, next_cursor: 'more' }, sources: [] };
      }
      throw new Error('unexpected');
    },
  });
  const formatted = await nativeAgentToolResult({
    resolver,
    operation: 'module_record_search',
    input: { query: 'Company 01', module_id: MODULE_ID, collection_key: 'companies', limit: 10 },
    result: { items: [searchHit()], next_cursor: null },
    sources: [],
  });
  const context = JSON.parse(formatted.content).relationship_context;
  assert.equal(context.status, 'partial');
  assert.ok(context.incomplete_reasons.includes('pagination_remaining'));
  assert.ok(context.incomplete_reasons.includes('budget_exhausted'));
  assert.equal(context.truncated, true);
  assert.ok(context.budget.used_read_calls <= context.budget.max_read_calls);
  assert.ok(context.budget.used_nodes <= context.budget.max_nodes);
  assert.ok(context.budget.used_pages <= context.budget.max_pages);
  assert.ok(calls.length <= 18);

  let filteredCalls = 0;
  const filtered = createModuleNextReadsResolver({
    availableToolNames: ['module_record_get'],
    executeRead: async (operation, input) => {
      filteredCalls += 1;
      assert.equal(operation, 'module_record_get');
      return { result: { record: moduleRecord('companies', String(input.record_id)) }, sources: [] };
    },
  });
  const filteredResult = await nativeAgentToolResult({
    resolver: filtered,
    operation: 'module_record_search',
    input: { query: 'Company 01', module_id: MODULE_ID, collection_key: 'companies', limit: 10 },
    result: { items: [searchHit()], next_cursor: null },
    sources: [],
  });
  const filteredContext = JSON.parse(filteredResult.content).relationship_context;
  assert.ok(filteredContext.incomplete_reasons.includes('schema_unavailable'));
  assert.ok(filteredContext.incomplete_reasons.includes('tool_unavailable'));
  assert.equal(filteredCalls, 1, 'filtered tools are never invoked through the automatic reader');
});

test('continuation guidance and expanded metadata reach the OpenAI provider seam', async (t) => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const resolver = createModuleNextReadsResolver({
    availableToolNames: allReadTools,
    executeRead: twoHopExecutor(calls),
  });
  const content = await nativeAgentToolResultContent({
    resolver,
    operation: 'module_record_search',
    input: { query: 'Company 01', module_id: MODULE_ID, collection_key: 'companies', limit: 10 },
    result: { items: [searchHit()], next_cursor: null },
    sources: [{ type: 'module_record', id: 'module_record:company-01', title: 'Company 01', url: '/modules/contacts/companies/company-01' }],
  });

  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const functionOutput = body.messages.find((item: { role?: string }) => item.role === 'tool');
    assert.ok(functionOutput);
    const payload = JSON.parse(functionOutput.content);
    assert.equal(payload.next_reads.status, 'ready');
    assert.equal(payload.relationship_context.status, 'ready');
    assert.ok(payload.relationship_context.nodes.some((node: any) => node.resource_id === 'module_record:outreach-01'));
    assert.ok(payload.relationship_context.reads.some((read: any) => (
      read.operation === 'module_record_task_links'
      && read.result?.tasks?.some((task: any) => task.identifier === 'CRM-7')
    )));
    assert.match(payload.relationship_context.boundary, /untrusted data/);
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Use the bounded relationship context.' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });

  await createAgentMessage({
    resolved: { provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key' },
    system: 'Use authoritative tool contracts.',
    messages: [
      { role: 'user', content: 'Summarize Company 01 and its related work.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'module_record_search', input: { query: 'Company 01' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content }] },
    ],
    tools: [],
    maxTokens: 256,
  });
});
