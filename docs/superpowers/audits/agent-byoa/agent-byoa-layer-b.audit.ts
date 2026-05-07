#!/usr/bin/env tsx
// docs/superpowers/audits/agent-byoa/agent-byoa-layer-b.audit.ts
import 'dotenv/config';
import { chromium } from 'playwright';
import { loadEnv } from './lib/env.js';
import { createMcpClient } from './lib/mcp-client.js';
import { createDeftRest } from './lib/api-client.js';
import { runPreflight } from './lib/preflight.js';
import { runTier6 } from './tiers/tier6-llm.js';
import type { TierCtx } from './tiers/tier1-discovery.js';

async function main() {
  await runPreflight();
  const env = loadEnv({ requireLayerB: true });
  const rest = createDeftRest({ apiUrl: env.apiUrl, email: env.testEmail, password: env.testPassword });
  await rest.login();
  const mcp = createMcpClient({ apiUrl: env.apiUrl, bearer: env.agentToken });
  await mcp.initialize();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const tCtx: TierCtx = {
    page, rest, mcp,
    agent: { id: env.agentId, slug: env.agentSlug, trust_level: 'standard' },
    orgId: rest.user().org_id,
    webUrl: env.webUrl,
  };
  console.log(`\n══ Tier 6 — Live LLM (model=${env.layerBModel}) ══`);
  const r = await runTier6(tCtx, { apiKey: env.anthropicKey!, model: env.layerBModel });
  console.log(`\n══ Layer B: ${r.passed} passed, ${r.failed} failed ══`);
  if (r.failures.length) console.log(`  failures:\n    ${r.failures.join('\n    ')}`);
  await browser.close();
  process.exit(r.failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
