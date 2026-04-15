#!/usr/bin/env tsx
/**
 * April 15, 2026 human test gap fixes — Playwright-based verification suite.
 *
 * This audit script validates fixes for 17 gaps discovered during human
 * testing of the agent UI, task management, and real-time features.
 * Each gap is represented by a single check block; the suite exits non-zero
 * if any check fails.
 *
 * Preconditions:
 *   - Deft API dev server live on http://localhost:3001
 *   - Deft web dev server live on http://localhost:3000
 *   - DATABASE_URL set in root .env
 *   - DEFT_TEST_EMAIL / DEFT_TEST_PASSWORD set for the login helper
 *
 * Run:
 *   pnpm audit:gap-fixes
 *   or
 *   DEFT_TEST_EMAIL=maneek@test.com DEFT_TEST_PASSWORD=test1234 pnpm exec tsx docs/superpowers/audits/gap-fixes.audit.ts
 *
 * Coverage:
 *   Checks will be added below as tasks 1-16 are completed. Each check
 *   records PASS/FAIL and the script exits 0 only if all pass.
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync } from 'node:fs';

import { getStatePath, loginAndSaveState } from './lib/auth.js';

// ─── Constants ─────────────────────────────────────────────────────────

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';

// ─── Check recording ──────────────────────────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  const msg = detail ? ` — ${detail}` : '';
  console.log(`  ${status}: ${name}${msg}`);
}

// ─── Auth and token extraction ────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const statePath = getStatePath();
  const stateText = readFileSync(statePath, 'utf8');
  const state = JSON.parse(stateText) as Record<string, unknown>;

  // The storageState includes origins > localStorage > key/value pairs
  const origins = state.origins as Array<Record<string, unknown>> | undefined;
  if (!origins) {
    throw new Error('No origins in storage state');
  }

  for (const origin of origins) {
    const localStorage = origin.localStorage as Array<{ name: string; value: string }> | undefined;
    if (!localStorage) continue;

    const tokenItem = localStorage.find((item) => item.name === 'deft-access-token');
    if (tokenItem) {
      return tokenItem.value;
    }
  }

  throw new Error('deft-access-token not found in playwright-auth.json');
}

// ─── Health checks ──────────────────────────────────────────────────

async function preflight(): Promise<void> {
  const apiRes = await fetch(`${API_URL}/health`).catch(() => null);
  if (!apiRes || !apiRes.ok) {
    throw new Error(`Deft API not reachable at ${API_URL}/health — run pnpm dev:api`);
  }

  const webRes = await fetch(`${WEB_URL}/login`).catch(() => null);
  if (!webRes || webRes.status >= 500) {
    throw new Error(`Deft web not reachable at ${WEB_URL} — run pnpm dev:web`);
  }

  console.log('preflight: API + web reachable');
}

// ─── Main runner ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('April 15, 2026 gap fixes audit\n');
  const runStart = Date.now();

  try {
    await preflight();

    // Ensure we have a fresh session
    try {
      await loginAndSaveState();
    } catch (err) {
      console.warn(
        `  loginAndSaveState: ${err instanceof Error ? err.message : err} (falling back to saved state)`,
      );
    }

    // Extract the access token for direct API calls
    const accessToken = await getAccessToken();
    console.log('extracted access token from storage state');

    // Launch browser and open a page
    const browser: Browser = await chromium.launch({ headless: true });

    try {
      const ctx = await browser.newContext({
        storageState: getStatePath(),
        viewport: { width: 1440, height: 900 },
      });
      const page = await ctx.newPage();

      // ─── GAP CHECKS START ───
      // ─── Gap #10: wiki detail endpoint 200 ───
      {
        const res = await page.request.get(`${API_URL}/api/wiki/fact-license-bsl`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        record(
          'gap#10 wiki detail endpoint 200',
          res.status() === 200,
          `status=${res.status()}`,
        );
      }
      // ─── GAP CHECKS END ───

    } finally {
      await browser.close();
    }

    // Summary
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    const total = results.length;

    console.log(
      `\n${passed} passing, ${failed} failing (${total} total) — ${(Date.now() - runStart)}ms`,
    );

    if (failed > 0) {
      console.error('\nFailed checks:');
      results.filter((r) => !r.ok).forEach((r) => {
        console.error(`  - ${r.name}${r.detail ? ': ' + r.detail : ''}`);
      });
      process.exit(1);
    }

    console.log(`\nAll checks passed.`);
    process.exit(0);
  } catch (err) {
    console.error(
      `\nAudit failed to run: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
