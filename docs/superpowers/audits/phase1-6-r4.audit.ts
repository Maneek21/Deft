#!/usr/bin/env tsx
/**
 * Round 4 audit — error and failure paths.
 *
 * E.1   POST /api/inbox/read with malformed JSON body → 400 not 500
 * E.2   POST /api/inbox/read with non-string ids → handled gracefully
 * E.3   POST /api/inbox/read with all=non-bool → handled
 * E.4   GET /api/inbox?kind=invalid_value → empty list, not 500
 * E.5   GET /api/spaces/:id with bogus uuid → 404
 * E.6   GET /api/spaces/:id with non-uuid string → 4xx (no 500)
 * E.7   POST /api/agent/actions/:id/approve with bogus id → 404
 * E.8   POST /api/agent/actions/:id/reject with bogus id → 404
 * E.9   POST /api/messages/:id to non-existent space → 4xx not 500
 * E.10  Web: visit /chat?space=<bogus-uuid> → graceful UI, no white screen
 * E.11  Web: visit /inbox after killing the api → graceful error state
 *       (skipped if killing api would disrupt other audits)
 *
 * Run:
 *   DEFT_API_URL=http://localhost:3011 DEFT_WEB_URL=http://localhost:3010 \
 *     pnpm tsx docs/superpowers/audits/phase1-6-r4.audit.ts
 */
import 'dotenv/config';
import { chromium, type Browser } from 'playwright';
import { getStatePath } from './lib/auth.js';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3011';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3010';

type Severity = 'P0' | 'P1' | 'P2' | 'OK' | 'SKIP';
type Finding = { id: string; severity: Severity; title: string; detail?: string };
const findings: Finding[] = [];

function record(f: Finding) {
  findings.push(f);
  const tag = f.severity === 'OK' ? '✓' : f.severity === 'SKIP' ? '∅' : f.severity;
  console.log(`[${tag}] [E.${f.id}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
}

async function login(): Promise<string> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function rawApi(path: string, jwt: string, init: RequestInit = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${jwt}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, text: await res.text() };
}

const BOGUS_UUID = '00000000-0000-0000-0000-000000000000';

async function main() {
  console.log(`\n=== R4 audit — error / failure paths ===\napi: ${API_URL}\nweb: ${WEB_URL}\n`);
  const jwt = await login();

  // E.1 — malformed JSON to /api/inbox/read
  {
    const r = await rawApi('/api/inbox/read', jwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    if (r.status === 500) {
      record({ id: '1', severity: 'P1', title: 'Malformed JSON to /inbox/read returned 500', detail: r.text.slice(0, 100) });
    } else if (/error/i.test(r.text) || r.status >= 400) {
      record({ id: '1', severity: 'OK', title: 'Malformed JSON handled', detail: `status=${r.status}` });
    } else {
      record({ id: '1', severity: 'OK', title: 'Malformed JSON treated as empty body', detail: `status=${r.status}` });
    }
  }

  // E.2 — non-string ids
  {
    const r = await rawApi('/api/inbox/read', jwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [123, null, true] }),
    });
    if (r.status === 500) {
      record({ id: '2', severity: 'P1', title: 'Non-string ids caused 500', detail: r.text.slice(0, 100) });
    } else {
      record({ id: '2', severity: 'OK', title: 'Non-string ids handled', detail: `status=${r.status}` });
    }
  }

  // E.3 — all=non-bool
  {
    const r = await rawApi('/api/inbox/read', jwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: 'yes' }),
    });
    if (r.status === 500) {
      record({ id: '3', severity: 'P1', title: 'all=non-bool caused 500', detail: r.text.slice(0, 100) });
    } else {
      record({ id: '3', severity: 'OK', title: 'all=non-bool handled gracefully', detail: `status=${r.status}` });
    }
  }

  // E.4 — kind=invalid_value
  {
    const r = await rawApi('/api/inbox?kind=not_a_real_kind', jwt);
    if (r.status === 500) {
      record({ id: '4', severity: 'P1', title: 'Invalid kind value caused 500', detail: r.text.slice(0, 100) });
    } else if (r.status === 200) {
      const body = JSON.parse(r.text) as { items?: unknown[] };
      const empty = Array.isArray(body.items) && body.items.length === 0;
      if (empty) {
        record({ id: '4', severity: 'OK', title: 'Invalid kind returns empty list (200)', detail: '' });
      } else {
        record({ id: '4', severity: 'P2', title: 'Invalid kind returns non-empty list (filter bypassed?)', detail: `items.length=${body.items?.length}` });
      }
    } else {
      record({ id: '4', severity: 'OK', title: `Invalid kind handled with status=${r.status}` });
    }
  }

  // E.5 — bogus uuid lookup
  {
    const r = await rawApi(`/api/spaces/${BOGUS_UUID}`, jwt);
    if (r.status === 500) {
      record({ id: '5', severity: 'P1', title: 'Bogus uuid lookup caused 500', detail: r.text.slice(0, 100) });
    } else if (r.status === 404 || r.status === 403) {
      record({ id: '5', severity: 'OK', title: 'Bogus uuid lookup returned 4xx', detail: `status=${r.status}` });
    } else {
      record({ id: '5', severity: 'P2', title: `Unexpected status for bogus uuid lookup`, detail: `status=${r.status}` });
    }
  }

  // E.6 — non-uuid string in path
  {
    const r = await rawApi(`/api/spaces/not-a-uuid`, jwt);
    if (r.status === 500) {
      record({ id: '6', severity: 'P1', title: 'Non-uuid string caused 500', detail: r.text.slice(0, 100) });
    } else {
      record({ id: '6', severity: 'OK', title: `Non-uuid string handled gracefully`, detail: `status=${r.status}` });
    }
  }

  // E.7 — approve bogus action id
  {
    const r = await rawApi(`/api/agent/actions/${BOGUS_UUID}/approve`, jwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (r.status === 500) {
      record({ id: '7', severity: 'P1', title: 'Approve bogus action caused 500', detail: r.text.slice(0, 100) });
    } else if (r.status === 404) {
      record({ id: '7', severity: 'OK', title: 'Approve bogus action → 404' });
    } else {
      record({ id: '7', severity: 'P2', title: `Approve bogus action returned ${r.status}` });
    }
  }

  // E.8 — reject bogus action id
  {
    const r = await rawApi(`/api/agent/actions/${BOGUS_UUID}/reject`, jwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (r.status === 500) {
      record({ id: '8', severity: 'P1', title: 'Reject bogus action caused 500', detail: r.text.slice(0, 100) });
    } else if (r.status === 404) {
      record({ id: '8', severity: 'OK', title: 'Reject bogus action → 404' });
    } else {
      record({ id: '8', severity: 'P2', title: `Reject bogus action returned ${r.status}` });
    }
  }

  // E.9 — POST message to non-existent space
  {
    const r = await rawApi(`/api/messages/${BOGUS_UUID}`, jwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'r4 probe' }),
    });
    if (r.status === 500) {
      record({ id: '9', severity: 'P1', title: 'POST to non-existent space caused 500', detail: r.text.slice(0, 100) });
    } else if (r.status >= 400 && r.status < 500) {
      record({ id: '9', severity: 'OK', title: `POST to non-existent space → ${r.status}` });
    } else {
      record({ id: '9', severity: 'P0', title: `POST to non-existent space SUCCEEDED (${r.status}) — should be blocked` });
    }
  }

  // E.10 — Web: bogus space id in URL renders gracefully
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    let renderError = false;
    page.on('pageerror', () => { renderError = true; });
    try {
      await page.goto(`${WEB_URL}/chat?space=${BOGUS_UUID}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForTimeout(3000);
      // Page should still render the app shell — sidebar visible, not a white screen.
      const sidebarExists = await page.locator('a[href="/inbox"]').count();
      const bodyText = (await page.locator('body').innerText()).trim();
      if (sidebarExists === 0) {
        record({ id: '10', severity: 'P1', title: 'Bogus space id: app shell did not render (sidebar missing)' });
      } else if (bodyText.length < 50) {
        record({ id: '10', severity: 'P1', title: 'Bogus space id: page text < 50 chars (likely white screen)', detail: bodyText.slice(0, 100) });
      } else if (renderError) {
        record({ id: '10', severity: 'P2', title: 'Bogus space id: page rendered but threw an unhandled error' });
      } else {
        record({ id: '10', severity: 'OK', title: 'Bogus space id: app shell renders gracefully' });
      }
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // E.11 — Web: behavior with api temporarily unreachable. We DON'T actually
  //          kill the api (would disrupt other audits). Instead simulate by
  //          navigating to /inbox while denying network requests to the api.
  {
    const b = await chromium.launch({ headless: true });
    try {
      const ctx = await b.newContext({ storageState: getStatePath(), viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      // Block all api requests
      await page.route('**/api/**', (route) => route.abort());
      let renderError = false;
      page.on('pageerror', () => { renderError = true; });
      try {
        await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(4000);
        const heading = await page.locator('h1:has-text("Inbox")').count();
        const signInBtn = await page.locator('button:has-text("Sign in"), [type="submit"]:has-text("Sign in")').count();
        const bodyText = (await page.locator('body').innerText()).trim();
        // Acceptable graceful behaviors: (a) inbox heading still renders with
        // empty state, OR (b) auth context redirects to login (also a fail-safe).
        if (heading > 0) {
          record({ id: '11', severity: 'OK', title: 'API blocked: /inbox renders empty state with heading' });
        } else if (signInBtn > 0) {
          record({ id: '11', severity: 'OK', title: 'API blocked: redirected to login (graceful fail-safe)' });
        } else if (bodyText.length < 50) {
          record({ id: '11', severity: 'P1', title: 'API blocked: /inbox renders nothing (white screen)' });
        } else if (renderError) {
          record({ id: '11', severity: 'P1', title: 'API blocked: page threw unhandled error and no fallback', detail: bodyText.slice(0, 100) });
        } else {
          record({ id: '11', severity: 'P2', title: 'API blocked: page renders some content but no recognized state', detail: bodyText.slice(0, 100) });
        }
      } finally {
        await ctx.close();
      }
    } finally {
      await b.close();
    }
  }

  console.log('\n\n=== SUMMARY ===');
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Total: ${findings.length} | OK: ${counts.OK ?? 0} | SKIP: ${counts.SKIP ?? 0} | P0: ${counts.P0 ?? 0} | P1: ${counts.P1 ?? 0} | P2: ${counts.P2 ?? 0}`);
  const issues = findings.filter((f) => f.severity !== 'OK' && f.severity !== 'SKIP');
  if (issues.length > 0) {
    console.log('\nIssues:');
    for (const f of issues) {
      console.log(`  [${f.severity}] [E.${f.id}] ${f.title}${f.detail ? `\n    → ${f.detail}` : ''}`);
    }
  }
  process.exit(counts.P0 ? 1 : 0);
}

main().catch((err) => { console.error('audit crashed:', err); process.exit(2); });
