import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../apps/api/src/lib/db.js';
import { retrieveContext } from '../apps/api/src/lib/retrieve-context.js';
import {
  messages,
  orgMembers,
  spaceMembers,
  spaces,
  users,
  wikiCitations,
  wikiLinks,
  wikiOpsLog,
  wikiPages,
} from '@deft/db/schema';

type UserContext = {
  id: string;
  email: string;
  org_id: string;
};

type BenchResult = {
  name: string;
  total: number;
  concurrency: number;
  ok: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  avg_ms: number;
  duration_ms: number;
  notes?: string;
  samples?: string[];
};

type ProbeSummary = {
  runId: string;
  pageCount: number;
  messageCount: number;
  linkCount: number;
  citationCount: number;
  opCount: number;
  existingCounts: Record<string, number>;
  seedMs: number;
  cleanupMs: number | null;
  cleanedUp: boolean;
  apiUrl: string;
  webUrl: string;
  benches: BenchResult[];
  ui: Record<string, unknown>;
  reportPath: string;
};

const TEST_EMAIL = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const TEST_PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const API_URL = process.env.DEFT_API_URL || 'http://localhost:3301';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const PAGE_COUNT = Number(process.env.KNOWLEDGE_SCALE_PAGES || 1600);
const MESSAGE_COUNT = Math.max(12, Math.floor(PAGE_COUNT / 60));
const KEEP_DATA = process.env.KNOWLEDGE_SCALE_KEEP_DATA === '1';
const RUN_ID = `kscale-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const REPORT_PATH = path.resolve('reports', `knowledge-scale-probe-${RUN_ID}.html`);

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index]!;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

async function runBench(
  name: string,
  total: number,
  concurrency: number,
  fn: (index: number) => Promise<string | void>,
): Promise<BenchResult> {
  const latencies: number[] = [];
  const samples: string[] = [];
  let next = 0;
  let ok = 0;
  let errors = 0;
  const started = performance.now();

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= total) return;
      const t0 = performance.now();
      try {
        const sample = await fn(index);
        latencies.push(performance.now() - t0);
        ok += 1;
        if (sample && samples.length < 4) samples.push(sample);
      } catch (err) {
        latencies.push(performance.now() - t0);
        errors += 1;
        if (samples.length < 4) samples.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const duration = performance.now() - started;
  const avg = latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length);
  return {
    name,
    total,
    concurrency,
    ok,
    errors,
    p50_ms: round(percentile(latencies, 50)),
    p95_ms: round(percentile(latencies, 95)),
    max_ms: round(Math.max(0, ...latencies)),
    avg_ms: round(avg),
    duration_ms: round(duration),
    samples,
  };
}

async function currentUser(): Promise<UserContext> {
  const [row] = await db.select({
    id: users.id,
    email: users.email,
    org_id: orgMembers.org_id,
  })
    .from(users)
    .innerJoin(orgMembers, eq(orgMembers.user_id, users.id))
    .where(and(eq(users.email, TEST_EMAIL), eq(orgMembers.is_active, true)))
    .limit(1);

  if (!row) {
    throw new Error(`Could not find active org member for ${TEST_EMAIL}`);
  }
  return row as UserContext;
}

async function userSpaces(userId: string, orgId: string) {
  const rows = await db.select({
    id: spaces.id,
    name: spaces.name,
  })
    .from(spaces)
    .innerJoin(spaceMembers, eq(spaceMembers.space_id, spaces.id))
    .where(and(
      eq(spaces.org_id, orgId),
      eq(spaces.is_archived, false),
      eq(spaceMembers.user_id, userId),
    ))
    .limit(12);

  if (rows.length === 0) {
    throw new Error(`User ${userId} has no visible spaces; cannot run channel-aware scale probe.`);
  }
  return rows;
}

async function countExisting(orgId: string) {
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM wiki_pages WHERE org_id = ${orgId} AND is_deleted = false) AS pages,
      (SELECT count(*)::int FROM wiki_links WHERE org_id = ${orgId}) AS links,
      (SELECT count(*)::int FROM wiki_citations WHERE org_id = ${orgId}) AS citations,
      (SELECT count(*)::int FROM wiki_ops_log WHERE org_id = ${orgId}) AS ops
  `) as unknown as { rows?: Array<Record<string, number>> } | Array<Record<string, number>>;
  const row = Array.isArray(result) ? result[0] : result.rows?.[0];
  return {
    pages: Number(row?.pages ?? 0),
    links: Number(row?.links ?? 0),
    citations: Number(row?.citations ?? 0),
    ops: Number(row?.ops ?? 0),
  };
}

async function seedSyntheticCorpus(user: UserContext, visibleSpaces: Array<{ id: string; name: string }>) {
  const started = performance.now();
  const pageIds: string[] = [];
  const messageIds: string[] = [];
  const pageRows = [];
  const typeCycle = ['fact', 'decision', 'resource', 'procedure', 'entity', 'preference'] as const;
  const termCycle = [
    'cold chain calibration buyer copy route capacity',
    'sun gold sample box wholesale forecast',
    'greenhouse humidity irrigation exception',
    'packing line label audit delivery promise',
    'restaurant buyer harvest timing invoice note',
    'field ops quality threshold dispatch blocker',
  ];

  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    const space = visibleSpaces[i % visibleSpaces.length]!;
    const id = randomUUID();
    messageIds.push(id);
    await db.insert(messages).values({
      id,
      org_id: user.org_id,
      space_id: space.id,
      user_id: user.id,
      content: `Scale probe ${RUN_ID} source message ${i}: ${termCycle[i % termCycle.length]}.`,
      metadata: { scale_probe_id: RUN_ID },
    });
  }

  for (let i = 0; i < PAGE_COUNT; i += 1) {
    const id = randomUUID();
    const space = visibleSpaces[i % visibleSpaces.length]!;
    const isOrg = i % 4 === 0;
    const terms = termCycle[i % termCycle.length]!;
    pageIds.push(id);
    pageRows.push({
      id,
      org_id: user.org_id,
      scope: isOrg ? 'org' : 'space',
      space_id: isOrg ? null : space.id,
      origin_space_id: i % 3 === 0 ? space.id : null,
      origin_message_id: i % 3 === 0 ? messageIds[i % messageIds.length] : null,
      origin_user_id: user.id,
      created_via: 'scale_probe',
      type: typeCycle[i % typeCycle.length],
      title: `Scale Probe ${i} ${terms}`,
      slug: `${RUN_ID}-${i}`,
      summary: `Synthetic scale probe ${i} for ${terms}.`,
      content: [
        `Synthetic page ${i} for ${RUN_ID}.`,
        `This record tests retrieval for ${terms}.`,
        `Channel ${space.name} keeps this context near the work where it originated.`,
        `The page includes repeated operational terms so full text search and visibility filters have enough rows to chew on.`,
      ].join(' '),
      metadata: { scale_probe_id: RUN_ID, scale_index: i, terms },
      confidence: 0.55 + ((i % 40) / 100),
      tags: ['scale-probe', terms.split(' ')[0] ?? 'knowledge'],
      referenced_user_ids: [],
    });
  }

  for (let i = 0; i < pageRows.length; i += 200) {
    await db.insert(wikiPages).values(pageRows.slice(i, i + 200) as any[]);
  }

  const linkRows = [];
  for (let i = 1; i < pageIds.length; i += 1) {
    if (i % 2 === 0) {
      linkRows.push({
        id: randomUUID(),
        org_id: user.org_id,
        source_page_id: pageIds[i - 1]!,
        target_page_id: pageIds[i]!,
        context: `Scale probe link ${RUN_ID}`,
      });
    }
  }
  for (let i = 0; i < linkRows.length; i += 300) {
    await db.insert(wikiLinks).values(linkRows.slice(i, i + 300));
  }

  const citationRows = [];
  for (let i = 0; i < pageIds.length; i += 3) {
    const space = visibleSpaces[i % visibleSpaces.length]!;
    citationRows.push({
      id: randomUUID(),
      org_id: user.org_id,
      page_id: pageIds[i]!,
      source_type: 'message',
      source_id: messageIds[i % messageIds.length]!,
      source_space_id: space.id,
      source_user_id: user.id,
      excerpt: `Scale probe citation ${i}: ${termCycle[i % termCycle.length]}.`,
    });
  }
  for (let i = 0; i < citationRows.length; i += 300) {
    await db.insert(wikiCitations).values(citationRows.slice(i, i + 300));
  }

  const opRows = [];
  for (let i = 0; i < pageIds.length; i += 80) {
    opRows.push({
      id: randomUUID(),
      org_id: user.org_id,
      operation: i % 160 === 0 ? 'contradiction' : 'scale_probe_touch',
      page_id: pageIds[i]!,
      details: { scale_probe_id: RUN_ID, scale_index: i },
      performed_by: user.id,
    });
  }
  if (opRows.length > 0) {
    await db.insert(wikiOpsLog).values(opRows);
  }

  return {
    seedMs: performance.now() - started,
    pageIds,
    messageIds,
    linkCount: linkRows.length,
    citationCount: citationRows.length,
    opCount: opRows.length,
  };
}

async function cleanupSyntheticCorpus() {
  const started = performance.now();
  await db.execute(sql`
    DELETE FROM wiki_ops_log
    WHERE details->>'scale_probe_id' = ${RUN_ID}
       OR page_id IN (SELECT id FROM wiki_pages WHERE metadata->>'scale_probe_id' = ${RUN_ID})
  `);
  await db.execute(sql`
    DELETE FROM wiki_citations
    WHERE page_id IN (SELECT id FROM wiki_pages WHERE metadata->>'scale_probe_id' = ${RUN_ID})
  `);
  await db.execute(sql`
    DELETE FROM wiki_links
    WHERE source_page_id IN (SELECT id FROM wiki_pages WHERE metadata->>'scale_probe_id' = ${RUN_ID})
       OR target_page_id IN (SELECT id FROM wiki_pages WHERE metadata->>'scale_probe_id' = ${RUN_ID})
  `);
  await db.execute(sql`DELETE FROM wiki_pages WHERE metadata->>'scale_probe_id' = ${RUN_ID}`);
  await db.execute(sql`DELETE FROM messages WHERE metadata->>'scale_probe_id' = ${RUN_ID}`);
  return performance.now() - started;
}

async function loginForApi() {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`API login failed (${res.status}): ${await res.text()}`);
  }
  return await res.json() as { accessToken: string };
}

function authHeaders(accessToken: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (process.env.DEFT_AUDIT_BYPASS_TOKEN) {
    headers['x-deft-audit-token'] = process.env.DEFT_AUDIT_BYPASS_TOKEN;
  }
  return headers;
}

async function apiJson(pathname: string, accessToken: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${pathname}`, {
    ...init,
    headers: {
      ...authHeaders(accessToken),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    throw new Error(`${pathname} returned ${res.status}: ${(await res.text()).slice(0, 240)}`);
  }
  return await res.json();
}

async function runUiProbe() {
  const ui: Record<string, unknown> = {};
  try {
    const { chromium } = await import('playwright');
    const screenshotDir = path.resolve('reports', 'screenshots');
    await fs.mkdir(screenshotDir, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(30_000);

    await page.goto(`${WEB_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="email"], input[name="email"]').first().fill(TEST_EMAIL);
    await page.locator('input[type="password"], input[name="password"]').first().fill(TEST_PASSWORD);
    await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });

    let t0 = performance.now();
    await page.goto(`${WEB_URL}/knowledge`, { waitUntil: 'networkidle' });
    await page.locator('input[placeholder="Ask what the workspace knows..."]').first().waitFor();
    ui.desktopLoadMs = round(performance.now() - t0);

    const askInput = page.locator('input[placeholder="Ask what the workspace knows..."]').first();
    await askInput.fill(`scale probe cold chain calibration ${RUN_ID}`);
    t0 = performance.now();
    await page.locator('div').filter({ has: askInput }).locator('button:has-text("Ask")').first().click();
    await page.getByText(/Answered from sources|Sources only/i).first().waitFor({ timeout: 60_000 });
    ui.desktopAskMs = round(performance.now() - t0);
    await page.screenshot({
      path: path.join(screenshotDir, `knowledge-scale-desktop-${RUN_ID}.png`),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    t0 = performance.now();
    await page.goto(`${WEB_URL}/knowledge`, { waitUntil: 'networkidle' });
    const selects = page.locator('select');
    for (let i = 0; i < await selects.count(); i += 1) {
      const select = selects.nth(i);
      const options = await select.locator('option').evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent || '' })));
      const doctor = options.find((option) => option.value === 'doctor' || /doctor/i.test(option.text));
      if (doctor) {
        await select.selectOption(doctor.value);
        break;
      }
    }
    await page.getByText(/Low confidence|Contradictions|Knowledge Doctor/i).first().waitFor({ timeout: 60_000 });
    ui.mobileDoctorMs = round(performance.now() - t0);
    await page.screenshot({
      path: path.join(screenshotDir, `knowledge-scale-mobile-${RUN_ID}.png`),
      fullPage: true,
    });
    await browser.close();
    ui.ok = true;
  } catch (err) {
    ui.ok = false;
    ui.error = err instanceof Error ? err.message : String(err);
  }
  return ui;
}

async function writeReport(summary: ProbeSummary) {
  const rows = summary.benches.map((bench) => `
    <tr>
      <td>${escapeHtml(bench.name)}</td>
      <td>${bench.ok}/${bench.total}</td>
      <td>${bench.concurrency}</td>
      <td>${bench.p50_ms}</td>
      <td>${bench.p95_ms}</td>
      <td>${bench.max_ms}</td>
      <td>${bench.avg_ms}</td>
      <td>${escapeHtml((bench.samples ?? []).join(' | '))}</td>
    </tr>
  `).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Knowledge Scale Probe</title>
  <style>
    body { margin: 0; background: #f6f0e7; color: #191714; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 40px 24px 64px; }
    h1 { font-size: 34px; margin: 0 0 8px; }
    h2 { margin: 30px 0 12px; font-size: 20px; }
    p, li { color: #675f56; line-height: 1.55; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .card { background: #fff; border: 1px solid #e2d8c8; border-radius: 8px; padding: 16px; }
    .metric { font-size: 28px; font-weight: 760; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2d8c8; border-radius: 8px; overflow: hidden; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #e2d8c8; font-size: 13px; text-align: left; vertical-align: top; }
    th { background: #fff8ee; }
    code { background: #efe5d7; border: 1px solid #dfd1bf; border-radius: 4px; padding: 1px 5px; font-size: 12px; }
    .ok { color: #137a42; font-weight: 700; }
    .warn { color: #9a5b00; font-weight: 700; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } main { padding: 28px 16px 48px; } }
  </style>
</head>
<body>
  <main>
    <h1>Knowledge Scale Probe</h1>
    <p>Run <code>${escapeHtml(summary.runId)}</code>. Synthetic corpus was ${summary.cleanedUp ? 'cleaned up after the probe' : 'left in place'}.</p>

    <section class="grid">
      <div class="card"><div class="metric">${summary.pageCount}</div><p>synthetic wiki pages</p></div>
      <div class="card"><div class="metric">${summary.linkCount}</div><p>synthetic links</p></div>
      <div class="card"><div class="metric">${summary.citationCount}</div><p>synthetic citations</p></div>
      <div class="card"><div class="metric">${summary.seedMs}ms</div><p>seed time</p></div>
    </section>

    <h2>Existing Corpus Before Probe</h2>
    <p>Pages: <code>${summary.existingCounts.pages}</code>, links: <code>${summary.existingCounts.links}</code>, citations: <code>${summary.existingCounts.citations}</code>, ops: <code>${summary.existingCounts.ops}</code>.</p>

    <h2>Benchmarks</h2>
    <table>
      <thead><tr><th>Path</th><th>OK</th><th>Conc.</th><th>p50 ms</th><th>p95 ms</th><th>max ms</th><th>avg ms</th><th>Samples/errors</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <h2>UI Probe</h2>
    <div class="card">
      <p>Desktop load: <code>${escapeHtml(summary.ui.desktopLoadMs)}</code> ms. Desktop Ask: <code>${escapeHtml(summary.ui.desktopAskMs)}</code> ms. Mobile Doctor: <code>${escapeHtml(summary.ui.mobileDoctorMs)}</code> ms. UI result: <span class="${summary.ui.ok ? 'ok' : 'warn'}">${summary.ui.ok ? 'passed' : 'needs attention'}</span>.</p>
      ${summary.ui.error ? `<p>Error: <code>${escapeHtml(summary.ui.error)}</code></p>` : ''}
    </div>

    <h2>Interpretation</h2>
    <ul>
      <li>Direct retrieval is the cleanest measure of the Context Router path without HTTP/auth/rate-limit overhead.</li>
      <li>Live API list/graph/Doctor checks include auth middleware, JSON serialization, and route-level visibility filters.</li>
      <li>Ask synthesis intentionally runs as a small sample because LLM latency and provider limits dominate that path.</li>
      <li>Doctor's orphan/contradiction checks are the paths to watch as wiki volume grows because they use anti-join style checks across links and citations.</li>
    </ul>

    <h2>Cleanup</h2>
    <p>Cleanup duration: <code>${escapeHtml(summary.cleanupMs)}</code> ms. Set <code>KNOWLEDGE_SCALE_KEEP_DATA=1</code> to keep synthetic data for manual UI inspection.</p>
  </main>
</body>
</html>`;

  await fs.mkdir(path.dirname(summary.reportPath), { recursive: true });
  await fs.writeFile(summary.reportPath, html, 'utf8');
}

async function main() {
  const user = await currentUser();
  const visibleSpaces = await userSpaces(user.id, user.org_id);
  const existingCounts = await countExisting(user.org_id);
  console.log(`[knowledge-scale] user=${user.email} org=${user.org_id} spaces=${visibleSpaces.length}`);
  console.log(`[knowledge-scale] seeding ${PAGE_COUNT} pages...`);

  let cleanupMs: number | null = null;
  let cleanedUp = false;
  const benches: BenchResult[] = [];
  const seeded = await seedSyntheticCorpus(user, visibleSpaces);
  const seedMs = round(seeded.seedMs);

  try {
    const access = await loginForApi();
    const queryTerms = [
      'cold chain calibration buyer copy',
      'sun gold sample wholesale forecast',
      'greenhouse humidity irrigation exception',
      'packing line label audit',
      'restaurant buyer harvest timing',
      'field ops quality threshold',
    ];

    benches.push(await runBench('direct retrieveContext wiki+decisions+notes', 180, 18, async (index) => {
      const query = `${queryTerms[index % queryTerms.length]} ${RUN_ID}`;
      const hits = await retrieveContext({
        query,
        org_id: user.org_id,
        user_id: user.id,
        space_id: visibleSpaces[index % visibleSpaces.length]?.id,
        include_org: true,
        types: ['wiki', 'decisions', 'notes'],
        limit: 8,
      });
      if (hits.length === 0) throw new Error('no hits');
      return hits[0]?.title;
    }));

    benches.push(await runBench('live API /api/wiki search', 90, 12, async (index) => {
      const query = encodeURIComponent(`${queryTerms[index % queryTerms.length]} ${RUN_ID}`);
      const data = await apiJson(`/api/wiki?q=${query}&limit=50`, access.accessToken);
      if (!Array.isArray(data.pages) || data.pages.length === 0) throw new Error('no pages');
      return `${data.pages.length} pages`;
    }));

    benches.push(await runBench('live API /api/wiki/graph org', 24, 4, async () => {
      const data = await apiJson('/api/wiki/graph?mode=org&limit=1000', access.accessToken);
      if (!Array.isArray(data.nodes)) throw new Error('missing nodes');
      return `${data.nodes.length} nodes`;
    }));

    benches.push(await runBench('live API /api/wiki/graph channel', 24, 4, async (index) => {
      const space = visibleSpaces[index % visibleSpaces.length]!;
      const data = await apiJson(`/api/wiki/graph?mode=space&space_id=${space.id}&limit=1000`, access.accessToken);
      if (!Array.isArray(data.nodes)) throw new Error('missing nodes');
      return `${data.nodes.length} nodes`;
    }));

    benches.push(await runBench('live API /api/wiki/doctor', 18, 3, async () => {
      const data = await apiJson('/api/wiki/doctor', access.accessToken);
      if (!data.summary) throw new Error('missing summary');
      return `${data.summary.orphaned} orphaned`;
    }));

    benches.push(await runBench('live API /api/wiki/ask synthesis sample', 3, 1, async (index) => {
      const data = await apiJson('/api/wiki/ask', access.accessToken, {
        method: 'POST',
        body: JSON.stringify({
          query: `${queryTerms[index % queryTerms.length]} ${RUN_ID}`,
          include_org: true,
          space_id: visibleSpaces[index % visibleSpaces.length]?.id,
          limit: 6,
        }),
      });
      if (!data.answer || !Array.isArray(data.sources)) throw new Error('bad ask response');
      return `${data.mode}/${data.sources.length} sources`;
    }));

    const ui = await runUiProbe();
    if (!KEEP_DATA) {
      cleanupMs = round(await cleanupSyntheticCorpus());
      cleanedUp = true;
    }

    const summary: ProbeSummary = {
      runId: RUN_ID,
      pageCount: PAGE_COUNT,
      messageCount: MESSAGE_COUNT,
      linkCount: seeded.linkCount,
      citationCount: seeded.citationCount,
      opCount: seeded.opCount,
      existingCounts,
      seedMs,
      cleanupMs,
      cleanedUp,
      apiUrl: API_URL,
      webUrl: WEB_URL,
      benches,
      ui,
      reportPath: REPORT_PATH,
    };
    await writeReport(summary);
    console.log(`[knowledge-scale] report: ${REPORT_PATH}`);
    for (const bench of benches) {
      console.log(`[knowledge-scale] ${bench.name}: ok=${bench.ok}/${bench.total} p50=${bench.p50_ms}ms p95=${bench.p95_ms}ms max=${bench.max_ms}ms`);
    }
    console.log(`[knowledge-scale] ui=${JSON.stringify(ui)}`);
    process.exit(0);
  } catch (err) {
    if (!KEEP_DATA) {
      cleanupMs = round(await cleanupSyntheticCorpus().catch(() => -1));
      cleanedUp = cleanupMs >= 0;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error('[knowledge-scale] failed:', err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
