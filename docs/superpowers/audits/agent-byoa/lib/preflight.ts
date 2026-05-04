// docs/superpowers/audits/agent-byoa/lib/preflight.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { createMcpClient } from './mcp-client.js';
import { assert } from '../../lib/assert.js';

export async function runPreflight(): Promise<void> {
  const env = loadEnv();
  const c = createMcpClient({ apiUrl: env.apiUrl, bearer: env.agentToken });

  // 1. tools/list works
  const list = await c.toolsList();
  assert(Array.isArray(list.tools) && list.tools.length >= 27,
    `tools/list returned ${list.tools?.length ?? 0} tools, expected ≥27`);

  // 2. caller_employee_slug is accepted (platform_context echoes it)
  const ctx = await c.toolsCall<{ employee?: { slug?: string } } | { error?: string }>('platform_context', {
    caller_employee_slug: env.agentSlug,
  });
  assert(typeof ctx === 'object' && ctx !== null && !('error' in ctx && (ctx as any).error),
    `platform_context errored: ${JSON.stringify(ctx)}`);

  // 3. API liveness — /api/health is auth-gated, so 401 is fine (means
  // the server is alive and rejecting our anon GET). 200 also acceptable
  // for routes that opt out of auth.
  const apiHealth = await fetch(`${env.apiUrl}/api/health`).catch((e) => ({ ok: false, status: 0, error: e } as any));
  const hStatus = (apiHealth as any).status ?? 0;
  assert(hStatus === 200 || hStatus === 401,
    `API /api/health returned ${hStatus}, expected 200 or 401 (liveness)`);

  console.log('[preflight] ✅ MCP endpoint live, ≥27 tools, slug accepted, API healthy');
}

function isMainModule(): boolean {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const argvFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return path.resolve(thisFile) === argvFile;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runPreflight()
    .then(() => process.exit(0))
    .catch((e) => { console.error('❌ preflight failed:', e instanceof Error ? e.message : e); process.exit(1); });
}
