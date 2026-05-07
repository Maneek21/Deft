#!/usr/bin/env tsx
// Minimal MCP stub server for Phase 1 empirical tests.
// Not committed to production. Lives under scripts/scratch/.
//
// Usage:
//   tsx scripts/scratch/dummy-mcp-server.ts --port 9001 --label alex
//   tsx scripts/scratch/dummy-mcp-server.ts --port 9002 --label bob
//
// Each instance logs every request with its port-identifying label prefix,
// so we can see which agent is calling which MCP endpoint when testing
// per-agent MCP override support (Phase 1 Test 1.1 / NC2 verification).

import { createServer } from 'node:http';

function getArg(name: string, fallback?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required --${name} arg`);
  }
  return process.argv[idx + 1]!;
}

const port = parseInt(getArg('port'), 10);
const label = getArg('label');

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const stamp = new Date().toISOString();
    console.log(
      `[${label}:${port}] ${stamp} ${req.method} ${req.url} — ${body.slice(0, 200)}`,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        result: {
          tools: [
            {
              name: 'ping',
              description: `echo from dummy mcp ${label}`,
              inputSchema: { type: 'object', properties: {} },
            },
          ],
          _source: label,
          _port: port,
        },
      }),
    );
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`dummy MCP ${label} listening on http://127.0.0.1:${port}`);
});
