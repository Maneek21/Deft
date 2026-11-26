import test from 'node:test';
import assert from 'node:assert/strict';
import { formatToolLabel } from './tool-display';

test('tool labels say app where tool names say module; raw names are not changed', () => {
  assert.equal(formatToolLabel('module_list'), 'App List');
  assert.equal(formatToolLabel('module_record_create'), 'App Record Create');
  assert.equal(formatToolLabel('mcp__deft__module_record_query'), 'Deft · App Record Query');
  assert.equal(formatToolLabel('create_task'), 'Create Task');
  assert.equal(formatToolLabel('modulename_tool'), 'Modulename Tool');
});
