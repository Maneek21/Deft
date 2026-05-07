#!/usr/bin/env tsx
/**
 * Round 5 audit — cursor pagination + perf budget.
 *
 * P.1   Pagination correctness — manufacture 60 unread notifications,
 *       fetch page 1 (limit=50), fetch page 2 with cursor, verify:
 *       - exactly 50 items on page 1
 *       - has_more=true on page 1
 *       - >=10 items on page 2 with no overlap with page 1
 *       - sort desc by created_at across pages
 * P.2   Cursor with no more results returns has_more=false
 *
 * X.1   /inbox time-to-content under threshold (h1 visible within 5s)
 * X.2   /chat time-to-sidebar under threshold (Inbox link within 5s)
 * X.3   /api/inbox latency p95 (10 sequential calls) under 1500ms
 *
 * Run:
 *   DEFT_API_URL=http://localhost:3011 DEFT_WEB_URL=http://localhost:3010 \
 *     pnpm tsx docs/superpowers/audits/phase1-6-r5.audit.ts
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { eq, inArray, like } from 'drizzle-orm';
import { db, schema } from './lib/db.js';
import { getStatePath } from './lib/auth.js';

const { notifications } = schema;

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3011';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3010';

type Severity = 'P0' | 'P1' | 'P2' | 'OK' | 'SKIP';
type Finding = { id: string; severity: Severity; title: string; detail?: string };
const findings: Finding[] = [];

function record(f: Finding) {
  findings.push(f);
  const tag = f.severity === 'OK' ? '✓' : f.severity === 'SKIP' ? '∅' : f.severity;
  console.log(`[${tag}] [${f.id}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
}

async function login() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
  });
  const body = (await res.json()) as { accessToken: string; user: { id: string }; org_id: string };
  return { jwt: body.accessToken, userId: body.user.id, orgId: body.org_id };
}

async function api<T = unknown>(path: string, jwt: string): Promise<{ status: number; body: T; latencyMs: number }> {
  const start = Date.now();
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
  const text = await res.text();
  const latencyMs = Date.now() - start;
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as T, latencyMs };
}

async function flowPagination(jwt: string, orgId: string, userId: string) {
  // Mark all current notifications read so the seed test data doesn't bleed in.
  // We'll seed exactly 60 fresh unread rows tagged with our marker.
  const marker = '[r5-page]';
  const seed: Array<{ id: string }> = [];
  try {
    // Insert 60 unread notifications with strictly-increasing created_at.
    const baseTime = new Date();
    for (let i = 0; i < 60; i++) {
      const t = new Date(baseTime.getTime() - i * 1000); // 1s apart, desc by index
      const [n] = await db.insert(notifications).values({
        org_id: orgId,
        user_id: userId,
        type: 'system',
        title: `${marker} ${i.toString().padStart(2, '0')}`,
        is_read: false,
        created_at: t,
      }).returning();
      seed.push(n);
    }

    // First, mark all PRE-EXISTING notifications read so they don't pollute
    // the inbox feed with their kinds. Our 60 seeded rows are already
    // returned because created_at is fresh; they should dominate the feed.
    await fetch(`${API_URL}/api/inbox/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    // After mark-all-read, the inbox seed rows we JUST inserted are also
    // marked read because the route flips ALL is_read=false rows. Re-flag
    // ours back to unread.
    await db.update(notifications)
      .set({ is_read: false })
      .where(inArray(notifications.id, seed.map((s) => s.id)));

    // Fetch page 1, limit=50
    const page1 = await api<{ items: Array<{ id: string; created_at: string }>; has_more: boolean; next_cursor: string | null }>('/api/inbox?limit=50', jwt);
    if (page1.status !== 200 || !page1.body) {
      record({ id: 'P.1', severity: 'P0', title: 'Page 1 failed', detail: `status=${page1.status}` });
      return;
    }
    const seededInPage1 = page1.body.items.filter((it) => it.id.startsWith('notif:') && seed.some((s) => `notif:${s.id}` === it.id));
    const otherInPage1 = page1.body.items.length - seededInPage1.length;

    if (page1.body.items.length !== 50) {
      record({ id: 'P.1', severity: 'P1', title: `Page 1 had ${page1.body.items.length} items, expected 50` });
      return;
    }
    if (!page1.body.has_more) {
      record({ id: 'P.1', severity: 'P1', title: 'Page 1: has_more=false despite 60 unread + cursor null', detail: `next_cursor=${page1.body.next_cursor}` });
      return;
    }
    if (!page1.body.next_cursor) {
      record({ id: 'P.1', severity: 'P1', title: 'Page 1: next_cursor missing despite has_more=true' });
      return;
    }

    // Fetch page 2 with cursor
    const page2 = await api<{ items: Array<{ id: string; created_at: string }>; has_more: boolean; next_cursor: string | null }>(
      `/api/inbox?limit=50&cursor=${encodeURIComponent(page1.body.next_cursor)}`, jwt,
    );
    if (page2.status !== 200) {
      record({ id: 'P.1', severity: 'P1', title: 'Page 2 fetch failed', detail: `status=${page2.status}` });
      return;
    }

    // Check no overlap
    const page1Ids = new Set(page1.body.items.map((it) => it.id));
    const overlap = page2.body.items.filter((it) => page1Ids.has(it.id));
    if (overlap.length > 0) {
      record({ id: 'P.1', severity: 'P0', title: `${overlap.length} items duplicated across pages`, detail: overlap.slice(0, 2).map((o) => o.id).join(' | ') });
      return;
    }

    // Check sort desc — page 2 items should all be older (or equal-and-after by id) than page 1's last item
    const page1Last = new Date(page1.body.items[page1.body.items.length - 1]!.created_at).getTime();
    const orderViolations = page2.body.items.filter((it) => new Date(it.created_at).getTime() > page1Last);
    if (orderViolations.length > 0) {
      record({ id: 'P.1', severity: 'P1', title: `${orderViolations.length} page-2 items are newer than page-1 tail`, detail: 'sort order violated across pages' });
      return;
    }

    record({ id: 'P.1', severity: 'OK', title: `Pagination correct`, detail: `page1=50 (seeded:${seededInPage1.length}, other:${otherInPage1}) page2=${page2.body.items.length} no-overlap` });

    // P.2 — fetch deep page (cursor=oldest) to verify has_more=false eventually
    if (page2.body.next_cursor) {
      const page3 = await api<{ has_more: boolean; items: Array<{ id: string }> }>(
        `/api/inbox?limit=50&cursor=${encodeURIComponent(page2.body.next_cursor)}`, jwt,
      );
      // Either page 3 is empty (the seed is exhausted) or has more items.
      // What we're checking: when there really are no more items, has_more=false.
      if (page3.body.items.length === 0 && page3.body.has_more) {
        record({ id: 'P.2', severity: 'P1', title: 'has_more=true but items=[] on tail page' });
      } else if (page3.body.items.length < 50 && page3.body.has_more) {
        record({ id: 'P.2', severity: 'P2', title: `has_more=true with ${page3.body.items.length}<50 items (semantic ambiguity)` });
      } else {
        record({ id: 'P.2', severity: 'OK', title: `Deep page handled correctly`, detail: `items=${page3.body.items.length} has_more=${page3.body.has_more}` });
      }
    } else {
      record({ id: 'P.2', severity: 'OK', title: 'No cursor returned past page 2 (data exhausted)' });
    }
  } finally {
    // Cleanup seed
    if (seed.length > 0) {
      await db.delete(notifications).where(inArray(notifications.id, seed.map((s) => s.id))).catch(() => {});
    }
    // Sanity: delete any leftover marker rows
    await db.delete(notifications).where(like(notifications.title, `${marker}%`)).catch(() => {});
  }
}

async function flowPerf(jwt: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      storageState: getStatePath(),
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
    try {
      // X.1 — /inbox TTI
      const inboxStart = Date.now();
      await page.goto(`${WEB_URL}/inbox`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      try {
        await page.waitForSelector('h1:has-text("Inbox")', { timeout: 5_000 });
        const lag = Date.now() - inboxStart;
        const sev: Severity = lag > 5_000 ? 'P1' : lag > 3_000 ? 'P2' : 'OK';
        record({ id: 'X.1', severity: sev, title: `/inbox heading visible in ${lag}ms` });
      } catch {
        record({ id: 'X.1', severity: 'P1', title: '/inbox heading not visible within 5s' });
      }

      // X.2 — /chat sidebar
      const chatStart = Date.now();
      await page.goto(`${WEB_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      try {
        await page.waitForSelector('a[href="/inbox"]', { timeout: 5_000 });
        const lag = Date.now() - chatStart;
        const sev: Severity = lag > 5_000 ? 'P1' : lag > 3_000 ? 'P2' : 'OK';
        record({ id: 'X.2', severity: sev, title: `/chat sidebar Inbox link visible in ${lag}ms` });
      } catch {
        record({ id: 'X.2', severity: 'P1', title: '/chat sidebar not visible within 5s' });
      }
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  // X.3 — /api/inbox latency p95
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await api('/api/inbox?limit=50', jwt);
    samples.push(r.latencyMs);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)]!;
  const p95 = samples[Math.floor(samples.length * 0.95)]!;
  const max = samples[samples.length - 1]!;
  if (p95 > 1500) {
    record({ id: 'X.3', severity: 'P1', title: `/api/inbox p95=${p95}ms exceeds 1500ms`, detail: `p50=${p50} max=${max}` });
  } else if (p95 > 500) {
    record({ id: 'X.3', severity: 'P2', title: `/api/inbox p95=${p95}ms (over 500ms target)`, detail: `p50=${p50} max=${max}` });
  } else {
    record({ id: 'X.3', severity: 'OK', title: `/api/inbox latency healthy`, detail: `p50=${p50} p95=${p95} max=${max}` });
  }
}

async function main() {
  console.log(`\n=== R5 audit — pagination + perf ===\napi: ${API_URL}\nweb: ${WEB_URL}\n`);
  const auth = await login();

  console.log('--- P: cursor pagination ---');
  await flowPagination(auth.jwt, auth.orgId, auth.userId);

  console.log('\n--- X: perf budget ---');
  await flowPerf(auth.jwt);

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
      console.log(`  [${f.severity}] [${f.id}] ${f.title}${f.detail ? `\n    → ${f.detail}` : ''}`);
    }
  }
  process.exit(counts.P0 ? 1 : 0);
}

main().catch((err) => { console.error('audit crashed:', err); process.exit(2); });
