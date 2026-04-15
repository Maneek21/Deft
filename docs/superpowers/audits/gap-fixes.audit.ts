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
      // ─── Gap #2: chat message body wrapper is <div>, not <p> ───
      // Pre-fix bug: outer wrapper was <p>, inner TipTap content also had
      // <p>, so the browser auto-closed the outer <p> and split each message
      // into sibling paragraphs. Post-fix: outer wrapper is <div> so the
      // inner <p> parses cleanly under span.message-content.
      {
        await page.goto(`${WEB_URL}/chat`);
        await page.waitForLoadState('networkidle');
        await page.waitForSelector('main span.message-content', { timeout: 5000 });
        const bad = await page.evaluate(() => {
          const spans = document.querySelectorAll('main span.message-content');
          return Array.from(spans).filter((s) => {
            const parent = s.parentElement;
            return parent?.tagName !== 'DIV';
          }).length;
        });
        record(
          'gap#2 chat message wrapper is <div> not <p>',
          bad === 0,
          `${bad} span.message-content with non-DIV parent`,
        );
      }
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
      // ─── Gap #21: agent employee create dropdown has all 9 role values ───
      {
        await page.goto(`${WEB_URL}/settings/agent-employees/create`);
        await page.waitForLoadState('networkidle');
        const values = await page.$$eval('select option', (opts) =>
          (opts as HTMLOptionElement[]).map((o) => o.value).filter(Boolean),
        );
        const expected = [
          'project_manager',
          'engineering_lead',
          'executive_assistant',
          'product_designer',
          'qa_engineer',
          'customer_success',
          'community_manager',
          'cfo',
          'custom',
        ];
        const missing = expected.filter((v) => !values.includes(v));
        record(
          'gap#21 agent employee create dropdown has all 9 role values',
          missing.length === 0,
          missing.length ? `missing=${missing.join(',')}` : `values=${values.length}`,
        );
      }
      // ─── Gap #7+#12: projects endpoint exposes live total_tasks ───
      {
        const r = await page.request.get(`${API_URL}/api/projects`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        type ProjectRow = { prefix?: string; total_tasks?: number; task_counter?: number };
        const projects = (await r.json()) as ProjectRow[];
        const deft = projects.find((p) => p.prefix === 'DEFT');
        const hasLive = deft && typeof deft.total_tasks === 'number';
        const counter = deft?.task_counter ?? Number.MAX_SAFE_INTEGER;
        const sane = hasLive && (deft.total_tasks as number) < counter;
        record(
          'gap#7+12 projects endpoint exposes live total_tasks',
          Boolean(hasLive) && Boolean(sane),
          `deft.total_tasks=${deft?.total_tasks} deft.task_counter=${deft?.task_counter}`,
        );
      }
      // ─── Gap #5: no tiptap duplicate extension warning ───
      {
        const warnings: string[] = [];
        const handler = (msg: { type: () => string; text: () => string }) => {
          if (msg.type() === 'warning' && /Duplicate extension/i.test(msg.text())) {
            warnings.push(msg.text());
          }
        };
        page.on('console', handler);
        await page.goto(`${WEB_URL}/chat`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);
        page.off('console', handler);
        record(
          'gap#5 no tiptap duplicate extension warning',
          warnings.length === 0,
          warnings.length ? warnings[0].slice(0, 200) : 'clean',
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
