import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../apps/api/src/lib/db.js';
import { retrieveContext } from '../apps/api/src/lib/retrieve-context.js';
import { orgMembers, users, wikiPages } from '@deft/db/schema';

type EvalCase = {
  name: string;
  query: string;
  expectedPageId: string;
  expectedSlug: string;
  spaceId?: string | null;
};

type EvalResult = EvalCase & {
  ok: boolean;
  rank: number | null;
  hits: Array<{
    title: string;
    source_id: string;
    slug: string | null;
    score: number;
    scope: string | null;
  }>;
};

const TEST_EMAIL = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT_PATH = path.resolve('reports', `knowledge-retrieval-eval-${RUN_ID}.html`);

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function queryFromTitle(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 18)
    .join(' ')
    .slice(0, 180);
}

async function currentUser() {
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
    throw new Error(`Could not find active org member for ${TEST_EMAIL}. Set DEFT_TEST_EMAIL or seed the pilot workspace.`);
  }
  return row;
}

async function buildCases(orgId: string): Promise<EvalCase[]> {
  const proofRows = await db.select({
    id: wikiPages.id,
    slug: wikiPages.slug,
    title: wikiPages.title,
    space_id: wikiPages.space_id,
    origin_space_id: wikiPages.origin_space_id,
  })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.is_deleted, false),
      sql`${wikiPages.metadata}->>'knowledge_marker' IS NOT NULL`,
    ))
    .orderBy(desc(wikiPages.updated_at))
    .limit(3);

  const recentRows = await db.select({
    id: wikiPages.id,
    slug: wikiPages.slug,
    title: wikiPages.title,
    space_id: wikiPages.space_id,
    origin_space_id: wikiPages.origin_space_id,
  })
    .from(wikiPages)
    .where(and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.is_deleted, false),
      sql`length(${wikiPages.title}) >= 8`,
    ))
    .orderBy(desc(wikiPages.updated_at))
    .limit(8);

  const byId = new Map<string, EvalCase>();
  for (const row of [...proofRows, ...recentRows]) {
    byId.set(row.id, {
      name: row.title,
      query: queryFromTitle(row.title),
      expectedPageId: row.id,
      expectedSlug: row.slug,
      spaceId: row.space_id ?? row.origin_space_id ?? null,
    });
  }
  return Array.from(byId.values()).slice(0, 8);
}

async function runCase(user: { id: string; org_id: string }, evalCase: EvalCase): Promise<EvalResult> {
  const results = await retrieveContext({
    query: evalCase.query,
    org_id: user.org_id,
    user_id: user.id,
    space_id: evalCase.spaceId ?? undefined,
    include_org: true,
    types: ['wiki', 'decisions', 'notes'],
    limit: 8,
  });

  const rankIndex = results.findIndex((hit) => (
    hit.source_type === 'wiki_page' && hit.source_id === evalCase.expectedPageId
  ) || hit.metadata?.slug === evalCase.expectedSlug);
  return {
    ...evalCase,
    ok: rankIndex >= 0 && rankIndex < 5,
    rank: rankIndex >= 0 ? rankIndex + 1 : null,
    hits: results.slice(0, 5).map((hit) => ({
      title: hit.title,
      source_id: hit.source_id,
      slug: typeof hit.metadata?.slug === 'string' ? hit.metadata.slug : null,
      score: hit.score,
      scope: hit.scope ?? null,
    })),
  };
}

async function writeReport(results: EvalResult[]) {
  const passCount = results.filter((r) => r.ok).length;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Knowledge Retrieval Eval</title>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; margin: 32px; color: #18212f; background: #f7f4ee; }
    .wrap { max-width: 1080px; margin: 0 auto; }
    h1 { margin-bottom: 4px; }
    .summary { padding: 16px; border: 1px solid #d7cfc1; border-radius: 8px; background: #fffaf1; margin: 18px 0; }
    .case { padding: 16px; border: 1px solid #d7cfc1; border-radius: 8px; background: white; margin: 12px 0; }
    .pass { color: #166534; font-weight: 700; }
    .fail { color: #b91c1c; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    th, td { border-bottom: 1px solid #eee3d3; padding: 8px; text-align: left; vertical-align: top; }
    code { background: #f1eadf; padding: 1px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>Knowledge Retrieval Eval</h1>
    <p>Run: ${escapeHtml(RUN_ID)} / User: ${escapeHtml(TEST_EMAIL)}</p>
    <section class="summary">
      <strong>${passCount}/${results.length} cases passed</strong>
      <p>Pass means the expected wiki page appeared in the top 5 results from the shared retrieveContext gateway.</p>
    </section>
    ${results.map((result) => `
      <section class="case">
        <div class="${result.ok ? 'pass' : 'fail'}">${result.ok ? 'PASS' : 'FAIL'} / ${escapeHtml(result.name)}</div>
        <p>Query: <code>${escapeHtml(result.query)}</code> / Expected: <code>${escapeHtml(result.expectedSlug)}</code> / Rank: ${escapeHtml(result.rank ?? 'not found')}</p>
        <table>
          <thead><tr><th>#</th><th>Hit</th><th>Slug</th><th>Scope</th><th>Score</th></tr></thead>
          <tbody>
            ${result.hits.map((hit, index) => `
              <tr>
                <td>${index + 1}</td>
                <td>${escapeHtml(hit.title)}</td>
                <td>${escapeHtml(hit.slug)}</td>
                <td>${escapeHtml(hit.scope)}</td>
                <td>${escapeHtml(hit.score.toFixed(3))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </section>
    `).join('')}
  </main>
</body>
</html>`;

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, html, 'utf8');
}

async function main() {
  const user = await currentUser();
  const cases = await buildCases(user.org_id);
  if (cases.length === 0) {
    throw new Error('No wiki pages found to evaluate. Seed the pilot workspace first.');
  }

  const results: EvalResult[] = [];
  for (const evalCase of cases) {
    results.push(await runCase(user, evalCase));
  }
  await writeReport(results);

  const passCount = results.filter((r) => r.ok).length;
  console.log(`[knowledge-eval] ${passCount}/${results.length} passed`);
  console.log(`[knowledge-eval] report: ${REPORT_PATH}`);
  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('[knowledge-eval] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
