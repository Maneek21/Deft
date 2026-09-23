import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { AGENT_TOOLS } from '../src/lib/agent-tools.js';
import { MODULE_MCP_TOOL_SCHEMAS, MODULE_MCP_READ_TOOLS } from '../src/lib/mcp-tools/modules.js';
import { closeDb } from '../src/lib/db.js';

after(closeDb);

test('native and MCP Module tools share task discovery and tool guidance', () => {
  const native = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));
  const mcp = new Map(MODULE_MCP_TOOL_SCHEMAS.map((tool) => [tool.name, tool]));
  assert.ok(mcp.has('module_record_task_links'), 'Hermes must discover the linked-task read');
  assert.equal(typeof MODULE_MCP_READ_TOOLS.module_record_task_links, 'function');
  for (const [name, tool] of mcp) {
    assert.equal(tool.description, native.get(String(name))?.description, `${name} guidance must be shared`);
  }
  assert.match(String(mcp.get('module_record_query')?.description), /scalar.*module_record_incoming/s);
});
