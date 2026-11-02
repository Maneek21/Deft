// Standalone authority-latency harness (§3.1): calls the real handlers
// (appDataRuntimeAuthority / integrationToolAuthority) with DEFT_APP_DATA_TIMING
// and captures the per-phase `app_data_timing` event, then prints exact
// nearest-rank p50/p95/max per route.
//
// PREREQUISITE: a fully seeded test DB + deployment registry (see the
// statement-count harness header). Without a seed the run cannot complete;
// the summary here reports zero pool-acquisition timeouts only when a real
// pool is exercised.
//
// Usage:
//   DEFT_APP_DATA_TIMING=authority pnpm exec tsx test/perf/authority-latency.ts --n 256 --concurrency 1 --route both
import { appDataRuntimeAuthority } from '../../src/lib/app-data-authority.js';
import { integrationToolAuthority } from '../../src/lib/app-integration-tool-runtime.js';

type TimingEvent = { event: 'app_data_timing'; operation: string; outcome: 'completed' | 'failed'; failure_kind?: string; elapsed_ms: number; timings: Record<string, { calls: number; elapsed_ms: number }> };
type Sample = { route: string; elapsed_ms: number; ok: boolean; code: string; timings: TimingEvent['timings']; failure_kind?: string };

const args = process.argv.slice(2);
const n = Number(args[args.indexOf('--n') + 1] ?? 256);
const concurrency = Number(args[args.indexOf('--concurrency') + 1] ?? 4);
const routeArg = args[args.indexOf('--route') + 1] ?? 'both';
const emitJson = args.includes('--json');

const seedPath = process.env.DEFT_AUTHORITY_SEED;
if (!seedPath) throw new Error('Set DEFT_AUTHORITY_SEED to a module exporting { makeRequest, cleanup }');
const seed = (await import(seedPath)) as { makeRequest: () => Promise<{ route: 'data' | 'integration'; raw: unknown; authorization: string | undefined }>; cleanup?: () => Promise<void> };

const percentile = (sorted: number[], p: number) => {
  if (!sorted.length) return NaN;
  // nearest-rank
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
};

const samples: Sample[] = [];
const poolWaitEvents = { database_pool_acquisition_timeout: 0, database_lock_timeout: 0 };
let cursor = 0;
const worker = async () => {
  while (true) {
    const index = cursor++;
    if (index >= n) return;
    const { route, raw, authorization } = await seed.makeRequest();
    const began = performance.now();
    let ok = false, code = 'none', failure_kind: string | undefined, timings: TimingEvent['timings'] = {};
    const sink = (event: TimingEvent) => {
      if (event.operation === 'authority') { timings = event.timings; failure_kind = event.failure_kind; }
      if (event.failure_kind === 'database_pool_acquisition_timeout') poolWaitEvents.database_pool_acquisition_timeout++;
      if (event.failure_kind === 'database_lock_timeout') poolWaitEvents.database_lock_timeout++;
    };
    try {
      if (route === 'data') { await appDataRuntimeAuthority(raw, authorization); ok = true; }
      else if (route === 'integration') { await integrationToolAuthority(raw, authorization); ok = true; }
    } catch (error) {
      code = (error as { code?: string }).code ?? 'error';
      ok = false;
    }
    samples.push({ route, elapsed_ms: Math.round((performance.now() - began) * 100) / 100, ok, code, timings, failure_kind });
  }
};

const routeMask = routeArg === 'both' ? ['data', 'integration'] : routeArg === 'data' ? ['data'] : ['integration'];
// The seed chooses per-call route; filter to the requested mask for the summary.
try {
  await Promise.all(Array.from({ length: concurrency }, worker));
} finally {
  await seed.cleanup?.();
}

const summary: Record<string, unknown> = {};
for (const route of routeMask as string[]) {
  const routeSamples = samples.filter(s => s.route === route).map(s => s.elapsed_ms).sort((a, b) => a - b);
  const completed = samples.filter(s => s.route === route && s.ok).length;
  const completed_under_150 = samples.filter(s => s.route === route && s.ok && s.elapsed_ms < 150).length;
  summary[route] = { calls: samples.filter(s => s.route === route).length, completed, denied: samples.filter(s => s.route === route && !s.ok).length,
    completed_under_150_ms: completed_under_150, p50: percentile(routeSamples, 50), p95: percentile(routeSamples, 95), max: percentile(routeSamples, 100) };
}
summary.pool_wait_events = poolWaitEvents;
summary.concurrency = concurrency;
summary.ts = new Date().toISOString();

if (emitJson) for (const s of samples) console.log(JSON.stringify(s));
console.log(JSON.stringify(summary));

for (const route of routeMask as string[]) {
  const s = summary[route] as { p50: number; p95: number };
  console.log(`${route}: p50=${s.p50}ms p95=${s.p95}ms completed_under_150=${(summary[route] as { completed_under_150_ms: number }).completed_under_150_ms}`);
}
const failed = (routeMask as string[]).some(route => {
  const s = summary[route] as { p50: number; p95: number; completed_under_150_ms: number; calls: number };
  return s.p95 >= 150 || s.p50 > 90 || s.completed_under_150_ms !== s.calls;
});
process.exitCode = failed ? 1 : 0;
