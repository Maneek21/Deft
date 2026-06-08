import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS, TOOL_ALIASES, toolSchemas } from '../src/lib/mcp-tools/index.js';

test('wiki_search is exposed as a compatibility alias for memory_recall', () => {
  const names = new Set(toolSchemas.map((tool) => tool.name));

  assert.equal(TOOL_ALIASES.wiki_search, 'memory_recall');
  assert.ok(names.has('memory_recall'), 'memory_recall schema exists');
  assert.ok(names.has('wiki_search'), 'wiki_search schema exists');
  assert.equal(ALL_TOOLS[TOOL_ALIASES.wiki_search], ALL_TOOLS.memory_recall);
});
