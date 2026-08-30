import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const adapterPath = 'lib/capability-providers/mcp.ts';

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

test('low-level MCP discovery is callable only inside the capability provider adapter', async () => {
  const forbiddenOutsideAdapter = /\.(?:getCachedTools|discoverTools|testConnection|getCachedToolDiscovery|discoverToolDiscovery|testToolDiscovery)\s*\(/g;
  const violations: string[] = [];

  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath === adapterPath) continue;
    const source = await readFile(path, 'utf8');
    const matches = [...source.matchAll(forbiddenOutsideAdapter)];
    for (const match of matches) violations.push(`${sourcePath}:${match.index ?? 0}:${match[0]}`);
  }

  assert.deepEqual(violations, []);
});

test('every current runtime, admin, and script discovery consumer names the Capability Service seam', async () => {
  const consumers = [
    'lib/mcp-tools.ts',
    'routes/mcp-connections.ts',
    'scripts/reclassify-mcp-tools.ts',
    'scripts/install-tier1-mcp-bundle.ts',
  ];

  for (const consumer of consumers) {
    const source = await readFile(join(sourceRoot, consumer), 'utf8');
    assert.match(source, /capabilityService\.discover\s*\(/, consumer);
    assert.doesNotMatch(source, /MCPConnectionConfig/, consumer);
  }
});

test('every production MCP execution crosses Capability Service and only its adapter calls executeTool', async () => {
  for (const consumer of ['lib/agent-context.ts', 'lib/agent-actions.ts']) {
    const source = await readFile(join(sourceRoot, consumer), 'utf8');
    assert.match(source, /capabilityService\.invoke\s*\(/, consumer);
    assert.doesNotMatch(source, /mcpClientManager/, consumer);
    assert.doesNotMatch(
      source,
      /\b(?:getExecutableMcpConnection|toConnectionConfig|mcpResultPayload)\b/,
      consumer,
    );
    assert.doesNotMatch(source, /\.executeTool\s*\(/, consumer);
  }

  const violations: string[] = [];
  for (const path of await typescriptFiles(sourceRoot)) {
    const sourcePath = relative(sourceRoot, path).replaceAll('\\', '/');
    if (sourcePath === adapterPath) continue;
    const source = await readFile(path, 'utf8');
    const matches = [...source.matchAll(/\.executeTool\s*\(/g)];
    for (const match of matches) violations.push(`${sourcePath}:${match.index ?? 0}:${match[0]}`);
  }
  assert.deepEqual(violations, []);
});
