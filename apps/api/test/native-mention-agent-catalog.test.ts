import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_TOOLS, ACTION_TOOLS } from '../src/lib/agent-tools.js';
import { ALL_TOOLS, READ_ONLY_TOOLS, toolSchemas } from '../src/lib/mcp-tools/index.js';

for (const name of ['native_mentions_search', 'native_mentions_resolve']) {
  test(`Defty and employee MCP both discover the ${name} read adapter`, () => {
    const defty = AGENT_TOOLS.filter(tool => tool.name === name);
    const employee = toolSchemas.filter(tool => tool.name === name);
    assert.equal(defty.length, 1, 'Defty must see exactly one callable adapter');
    assert.equal(employee.length, 1, 'Employees must see exactly one callable adapter');
    assert.equal(typeof ALL_TOOLS[name], 'function');
    assert.equal(typeof READ_ONLY_TOOLS[name], 'function');
    assert.equal(ACTION_TOOLS.has(name), false);
  });
}
