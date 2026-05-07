#!/usr/bin/env tsx
// docs/superpowers/audits/agent-byoa/agent-byoa-layer-a.audit.ts
import 'dotenv/config';
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadEnv } from './lib/env.js';
import { createMcpClient } from './lib/mcp-client.js';
import { createDeftRest } from './lib/api-client.js';
import { runPreflight } from './lib/preflight.js';
import { harnessSweep } from './lib/fixtures.js';
import { runTier1, type TierCtx } from './tiers/tier1-discovery.js';
import { runTier2 } from './tiers/tier2-read.js';
import { runTier3 } from './tiers/tier3-write.js';
import { runTier4 } from './tiers/tier4-cooperative.js';
import { runTier5 } from './tiers/tier5-guards.js';

async function main() {
  await runPreflight();

  const env = loadEnv();
  const rest = createDeftRest({ apiUrl: env.apiUrl, email: env.testEmail, password: env.testPassword });
  await rest.login();

  const mcp = createMcpClient({ apiUrl: env.apiUrl, bearer: env.agentToken });
  await mcp.initialize();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const tCtx: TierCtx = {
    page, rest, mcp,
    agent: { id: env.agentId, slug: env.agentSlug, trust_level: 'standard' /* will refresh */ },
    orgId: rest.user().org_id,
    webUrl: env.webUrl,
  };

  // Sweep stale harness state from prior runs
  await harnessSweep(rest);

  const results: Record<string, { passed: number; failed: number; failures: string[] }> = {};
  console.log('\n══ Tier 1 — Discovery ══');
  results.tier1 = await runTier1(tCtx);
  console.log('\n══ Tier 2 — Read tools ══');
  results.tier2 = await runTier2(tCtx);
  console.log('\n══ Tier 3 — Write + approval ══');
  results.tier3 = await runTier3(tCtx);
  console.log('\n══ Tier 4 — Cooperative + telemetry ══');
  results.tier4 = await runTier4(tCtx);
  console.log('\n══ Tier 5 — Guards ══');
  results.tier5 = await runTier5(tCtx);

  const totals = Object.values(results).reduce((a, b) => ({ passed: a.passed + b.passed, failed: a.failed + b.failed }), { passed: 0, failed: 0 });
  console.log(`\n══ Layer A: ${totals.passed} passed, ${totals.failed} failed ══`);
  for (const [t, r] of Object.entries(results)) {
    if (r.failures.length) console.log(`  ${t} failures:\n    ${r.failures.join('\n    ')}`);
  }

  await browser.close();
  process.exit(totals.failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
