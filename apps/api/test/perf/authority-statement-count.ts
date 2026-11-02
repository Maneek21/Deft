// Standalone statement-count harness for the authority callback (§3.1).
// Instruments the Drizzle pg pool and prints statements-per-call and
// checkouts-per-call so the C1/C4 gains are visible as numbers, not vibes.
//
// PREREQUISITE: a fully seeded test DB (DEFT_TEST_DATABASE_URL / DATABASE_URL)
// plus a deployment registry file (DEFT_APP_CONNECTION_HTTP_CONFIG) whose entry
// matches a real connected app-data chain. This brief's diagnostics target the
// `record_read` data authority path; a caller-supplied seed must materialise
// that chain (see apps/api/test/app-data-process-db.test.ts runDataProcessFixture
// for the reference seed, which additionally needs DEFT_E2_RUNTIME_ROOT).
//
// Usage:
//   DEFT_APP_DATA_TIMING=authority pnpm exec tsx test/perf/authority-statement-count.ts --route data --n 20
import { db } from '../../src/lib/db.js';
import { appDataRuntimeAuthority } from '../../src/lib/app-data-authority.js';
import { integrationToolAuthority } from '../../src/lib/app-integration-tool-runtime.js';

type Pool = import('pg').Pool & { on(event: 'query', cb: (q: unknown) => void): unknown; on(event: 'acquire' | 'release', cb: () => void): unknown };
const pool = (db as unknown as { $client: Pool }).$client;
if (!pool || typeof pool.on !== 'function') {
  throw new Error('authority-statement-count: drizzle pool ($client) unavailable — cannot instrument statements');
}

const args = new Set(process.argv.slice(2));
const route = (['data', 'integration'] as const).find(r => args.has(`--route`) && process.argv[process.argv.indexOf('--route') + 1] === r) ?? 'data';
const n = Number(process.argv[process.argv.indexOf('--n') + 1] ?? 20);

// A seed must be supplied out-of-band: load it from an env-provided module so
// this harness stays framework-free and never invents its own fixture.
const seedPath = process.env.DEFT_AUTHORITY_SEED;
if (!seedPath) {
  throw new Error('Set DEFT_AUTHORITY_SEED to a module exporting { makeRequest, cleanup } that seeds the DB/registry and returns a per-call { raw, authorization }');
}
const seed = (await import(seedPath)) as { makeRequest: () => Promise<{ raw: unknown; authorization: string | undefined }>; cleanup?: () => Promise<void> };

let statements = 0, checkouts = 0, active = 0;
pool.on('query', () => { statements++; });
pool.on('acquire', () => { checkouts++; active++; });
pool.on('release', () => { active--; });

try {
  let perCall: number[] = [];
  for (let i = 0; i < n; i++) {
    const startStatements = statements, startCheckouts = checkouts;
    const { raw, authorization } = await seed.makeRequest();
    try {
      await (route === 'data' ? appDataRuntimeAuthority(raw, authorization) : integrationToolAuthority(raw, authorization));
    } catch (error) {
      console.error(`# call ${i} denied: ${(error as Error).message}`);
    }
    perCall.push(statements - startStatements);
    console.log(`# call ${i}: statements=${statements - startStatements} checkouts=${checkouts - startCheckouts}`);
  }
  const avg = perCall.reduce((a, b) => a + b, 0) / n;
  console.log(JSON.stringify({ route, n, statements_per_call: { avg, min: Math.min(...perCall), max: Math.max(...perCall) }, total_statements: statements, total_checkouts: checkouts, peak_active_connections: active }));
} finally {
  await seed.cleanup?.();
}
