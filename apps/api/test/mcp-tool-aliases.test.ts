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

test('scoped recall and context packet contract are advertised in tool schemas', () => {
  const memorySchema = toolSchemas.find((tool) => tool.name === 'memory_recall') as any;
  const wikiSearchSchema = toolSchemas.find((tool) => tool.name === 'wiki_search') as any;
  const platformSchema = toolSchemas.find((tool) => tool.name === 'platform_context') as any;

  for (const schema of [memorySchema, wikiSearchSchema]) {
    assert.ok(schema, 'recall schema exists');
    const properties = schema.inputSchema?.properties ?? {};
    assert.ok(properties.space_id, `${schema.name} should advertise space_id`);
    assert.ok(properties.include_org, `${schema.name} should advertise include_org`);
    assert.equal(properties.include_org.type, 'boolean');
  }

  assert.match(
    String(platformSchema?.description ?? ''),
    /context_packets/,
    'platform_context description should advertise context packets',
  );
});
