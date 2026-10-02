import assert from 'node:assert/strict';
import test from 'node:test';
import { PrivateMcpReadInput, PrivateMcpSearchInput, PrivateMcpCiteInput, PrivateMcpSearchOutput, encodePrivateMcpToolResult } from '../src/lib/app-private-mcp-contract.js';

const id = 'c165b8d3-bde5-4e6a-b383-fd6c2b7d701b';
const expires_at = '2026-09-27T23:00:00.000Z';
test('Private MCP DTOs reject actor credential destination and provider selectors', () => {
  const input = { schema_version: 'deft.app_private_mcp_read.v1', grant_id: id };
  assert.equal(PrivateMcpReadInput.parse(input).schema_version, input.schema_version);
  for (const key of ['org_id', 'user_id', 'employee_id', 'token_id', 'sid', 'destination', 'provider', 'ref']) {
    assert.equal(PrivateMcpReadInput.safeParse({ ...input, [key]: id }).success, false);
  }
  assert.equal(PrivateMcpReadInput.safeParse({ ...input, citation_token: 'opaque' }).success, false);
  assert.equal(PrivateMcpCiteInput.safeParse({ schema_version: 'deft.app_private_mcp_cite.v1', grant_id: id, operation: 'read' }).success, false);
  assert.equal(PrivateMcpSearchInput.safeParse({ schema_version: 'deft.app_private_mcp_search.v1', grant_id: id, query: 'literal', field_keys: ['body', 'body'] }).success, false);
});
test('Private MCP response is plain scalar closed JSON with no implicit native destination', () => {
  const row = { schema_version: 'deft.app_private_mcp_record.v1', grant_id: id, label: 'Private App record', data: { body: '<script>literal only</script>', count: 1, active: true }, freshness: 'unknown', expires_at };
  const result = encodePrivateMcpToolResult(row);
  assert.deepEqual(JSON.parse(result.content[0]!.text), row);
  for (const key of ['ref', 'href', 'provider', 'storage_url', 'token_id']) assert.throws(() => encodePrivateMcpToolResult({ ...row, [key]: id }));
  for (const value of [null, {}, [], Infinity]) assert.throws(() => encodePrivateMcpToolResult({ ...row, data: { body: value } }));
});
test('Whole MCP result byte bound includes JSON-string escaping and rejects oversize without partial output', () => {
  const base = { schema_version: 'deft.app_private_mcp_record.v1', grant_id: id, label: 'Private App record', freshness: 'unknown', expires_at };
  const payload = { ...base, data: { body: '"'.repeat(20000) } };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 65536);
  assert.throws(() => encodePrivateMcpToolResult(payload), RangeError);
  assert.ok(Buffer.byteLength(JSON.stringify(encodePrivateMcpToolResult({ ...base, data: { body: 'x'.repeat(1000) } }))) < 65536);
});
test('Private MCP search page states continuation honestly and bounds hits and snippets', () => {
  const hit = { grant_id: id, label: 'Private App record', snippets: { body: 'literal' } };
  const page = { schema_version: 'deft.app_private_mcp_search_page.v1', hits: [hit], next_cursor: 'opaque', complete: false, expires_at };
  assert.equal(PrivateMcpSearchOutput.safeParse(page).success, true);
  assert.equal(PrivateMcpSearchOutput.safeParse({ ...page, complete: true }).success, false);
  assert.equal(PrivateMcpSearchOutput.safeParse({ ...page, hits: Array.from({ length: 26 }, () => hit) }).success, false);
  assert.equal(PrivateMcpSearchOutput.safeParse({ ...page, hits: [{ ...hit, snippets: { body: 'x'.repeat(241) } }] }).success, false);
});
