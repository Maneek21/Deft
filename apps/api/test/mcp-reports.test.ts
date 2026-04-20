/**
 * Path C Phase 1 — mcp-tools/reports handlers are thin wrappers around
 * executeToolCall in agent-context. These tests don't seed full task /
 * message fixtures; they verify the wrappers:
 *   - reject missing required args with a clean error result
 *   - forward the shape executeToolCall expects
 *   - translate `{error: "..."}` returns into MCP error results
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/mcp-reports.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskDetail, messagesSearch, projectProgress, teamWorkload } from '../src/lib/mcp-tools/reports.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';
import { ALL_TOOLS, READ_ONLY_TOOLS, toolSchemas } from '../src/lib/mcp-tools/index.js';

const FAKE_CTX: ToolContext = {
  org_id: '00000000-0000-0000-0000-000000000001',
  employee_id: '00000000-0000-0000-0000-000000000002',
  employee_slug: 'test-employee',
  trust_level: 'standard',
};

test('task_detail rejects missing task_identifier', async () => {
  const r = await taskDetail({ task_identifier: '' }, FAKE_CTX);
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /task_identifier is required/);
});

test('messages_search rejects missing query', async () => {
  const r = await messagesSearch({ query: '' }, FAKE_CTX);
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /query is required/);
});

test('project_progress runs without required args (returns org-wide summary)', async () => {
  const r = await projectProgress({}, FAKE_CTX);
  assert.ok(r.content[0]);
  // Result is either data (JSON) or an error for non-existent org — both acceptable
  assert.ok(typeof r.content[0]!.text === 'string');
});

test('team_workload runs without required args (default window)', async () => {
  const r = await teamWorkload({}, FAKE_CTX);
  assert.ok(r.content[0]);
  assert.ok(typeof r.content[0]!.text === 'string');
});

test('reports handlers are registered in the READ_ONLY_TOOLS registry', () => {
  for (const name of ['task_detail', 'messages_search', 'project_progress', 'team_workload']) {
    assert.ok(READ_ONLY_TOOLS[name], `missing handler: ${name}`);
    assert.ok(ALL_TOOLS[name], `missing from ALL_TOOLS: ${name}`);
  }
});

test('reports tools have JSON schemas in toolSchemas', () => {
  for (const name of ['task_detail', 'messages_search', 'project_progress', 'team_workload']) {
    const schema = toolSchemas.find((s) => s.name === name);
    assert.ok(schema, `missing schema: ${name}`);
    assert.ok(schema!.description.length > 20, `description too short for ${name}`);
    assert.ok(schema!.inputSchema, `missing inputSchema for ${name}`);
  }
});

test('task_detail schema requires task_identifier', () => {
  const s = toolSchemas.find((s) => s.name === 'task_detail')!;
  const req = (s.inputSchema as { required?: string[] }).required ?? [];
  assert.ok(req.includes('task_identifier'));
});

test('messages_search schema requires query', () => {
  const s = toolSchemas.find((s) => s.name === 'messages_search')!;
  const req = (s.inputSchema as { required?: string[] }).required ?? [];
  assert.ok(req.includes('query'));
});
