#!/usr/bin/env tsx
/**
 * Phase 10 — metrics endpoint smoke audit.
 *
 * Preconditions:
 *   - Deft API dev server live on http://localhost:3001
 *   - `METRICS_SCRAPE_TOKEN` set in the API's env to a known value
 *
 * Run:
 *   METRICS_SCRAPE_TOKEN=dev-scrape pnpm audit:metrics
 *
 * Coverage:
 *   1. GET /api/metrics without a bearer → 401
 *   2. GET /api/metrics with the wrong bearer → 401
 *   3. GET /api/metrics with the right bearer → 200 text/plain
 *   4. The response body contains `deft_employee_chat_turn_total` and
 *      `deft_approval_queue_size` lines
 *
 * We do NOT spin up Playwright — metrics are a machine surface.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { assert } from './lib/assert.js';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const TOKEN = process.env.METRICS_SCRAPE_TOKEN || '';
const LAST_RUN_PATH = 'docs/superpowers/audits/metrics-smoke.last-run.txt';

async function main(): Promise<void> {
  console.log('Phase 10 audit — /api/metrics smoke\n');
  const runStart = Date.now();

  assert(
    TOKEN.length > 0,
    'METRICS_SCRAPE_TOKEN must be set in the environment before running this audit',
  );

  const health = await fetch(`${API_URL}/health`).catch(() => null);
  assert(health && health.ok, `Deft API not reachable at ${API_URL}/health`);

  // 1. No bearer → 401
  const resNoAuth = await fetch(`${API_URL}/api/metrics`);
  assert(
    resNoAuth.status === 401,
    `expected 401 without bearer, got ${resNoAuth.status}`,
  );
  console.log('  step 1: 401 without bearer OK');

  // 2. Wrong bearer → 401
  const resBadAuth = await fetch(`${API_URL}/api/metrics`, {
    headers: { Authorization: 'Bearer not-the-right-token' },
  });
  assert(
    resBadAuth.status === 401,
    `expected 401 with wrong bearer, got ${resBadAuth.status}`,
  );
  console.log('  step 2: 401 with wrong bearer OK');

  // 3. Correct bearer → 200 text/plain
  const resOk = await fetch(`${API_URL}/api/metrics`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert(resOk.status === 200, `expected 200 with correct bearer, got ${resOk.status}`);
  const ct = resOk.headers.get('content-type') ?? '';
  assert(
    ct.startsWith('text/plain'),
    `content-type should be text/plain, got ${ct}`,
  );
  const body = await resOk.text();
  console.log('  step 3: 200 text/plain OK');

  // 4. Body contains the expected metric names
  assert(
    body.includes('deft_employee_chat_turn_total'),
    `response missing deft_employee_chat_turn_total; first 200 chars: ${body.slice(0, 200)}`,
  );
  assert(
    body.includes('deft_approval_queue_size'),
    `response missing deft_approval_queue_size; first 200 chars: ${body.slice(0, 200)}`,
  );
  console.log('  step 4: expected metric lines present OK');

  const elapsedMs = Date.now() - runStart;
  const baseline = [
    'Phase 10 metrics smoke audit — PASS',
    `run at: ${new Date().toISOString()}`,
    `elapsed_ms: ${elapsedMs}`,
    `api_url: ${API_URL}`,
    `body_bytes: ${body.length}`,
    '',
  ].join('\n');
  writeFileSync(LAST_RUN_PATH, baseline);
  console.log(`\n  PASS — baseline written to ${LAST_RUN_PATH} (${elapsedMs}ms)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n  FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
