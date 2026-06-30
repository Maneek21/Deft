/**
 * Channel-aware wiki graph tests.
 *
 * Run: pnpm --filter @deft/api test -- wiki-graph-scope
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { env } from '../src/lib/env.js';

const DATABASE_URL = env.DATABASE_URL;

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = `wiki-graph-user-${Date.now()}`;
const SPACE_A_ID = `wiki-graph-space-a-${Date.now()}`;
const SPACE_B_ID = `wiki-graph-space-b-${Date.now()}`;
const HIDDEN_SPACE_ID = `wiki-graph-hidden-space-${Date.now()}`;

const createdPageIds: string[] = [];
const createdMessageIds: string[] = [];

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Wiki Graph Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, `${USER_ID}@test.local`],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );
    for (const [spaceId, name] of [[SPACE_A_ID, 'Wiki Graph A'], [SPACE_B_ID, 'Wiki Graph B']] as const) {
      await c.query(
        `INSERT INTO spaces (id, org_id, name, type, is_archived)
         VALUES ($1, $2, $3, 'public', false)
         ON CONFLICT (id) DO NOTHING`,
        [spaceId, ORG_ID, name],
      );
      await c.query(
        `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
         VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())
         ON CONFLICT (space_id, user_id) DO NOTHING`,
        [spaceId, USER_ID],
      );
    }
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_archived)
       VALUES ($1, $2, 'Wiki Graph Hidden', 'private', false)
       ON CONFLICT (id) DO NOTHING`,
      [HIDDEN_SPACE_ID, ORG_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM wiki_ops_log WHERE page_id = ANY($1)`, [createdPageIds]);
    if (createdPageIds.length > 0) {
      await c.query(`DELETE FROM wiki_links WHERE source_page_id = ANY($1) OR target_page_id = ANY($1)`, [createdPageIds]);
      await c.query(`DELETE FROM wiki_citations WHERE page_id = ANY($1)`, [createdPageIds]);
      await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [createdPageIds]);
    }
    if (createdMessageIds.length > 0) {
      await c.query(`DELETE FROM messages WHERE id = ANY($1)`, [createdMessageIds]);
    }
    await c.query(`DELETE FROM space_members WHERE space_id = ANY($1)`, [[SPACE_A_ID, SPACE_B_ID, HIDDEN_SPACE_ID]]);
    await c.query(`DELETE FROM spaces WHERE id = ANY($1)`, [[SPACE_A_ID, SPACE_B_ID, HIDDEN_SPACE_ID]]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

async function insertPage(input: {
  scope: 'org' | 'space';
  title: string;
  slug: string;
  spaceId?: string | null;
  originSpaceId?: string | null;
}) {
  const id = `wiki-graph-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, scope, space_id, origin_space_id, origin_user_id, created_via,
          type, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'test', 'fact', $7, $8, $9, 1.0, false, NOW(), NOW())`,
      [
        id,
        ORG_ID,
        input.scope,
        input.spaceId ?? null,
        input.originSpaceId ?? null,
        USER_ID,
        input.title,
        input.slug,
        `${input.title} body`,
      ],
    );
  });
  createdPageIds.push(id);
  return id;
}

async function insertMessage(spaceId: string, content: string) {
  const id = `wiki-graph-message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO messages
         (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, false, NOW(), NOW())`,
      [id, ORG_ID, spaceId, USER_ID, content],
    );
  });
  createdMessageIds.push(id);
  return id;
}

async function insertWikiLink(sourcePageId: string, targetPageId: string, context: string) {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO wiki_links (id, org_id, source_page_id, target_page_id, context, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW())
       ON CONFLICT (source_page_id, target_page_id) DO NOTHING`,
      [ORG_ID, sourcePageId, targetPageId, context],
    );
  });
}

async function insertWikiCitation(pageId: string, messageId: string, spaceId: string, excerpt: string) {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO wiki_citations
         (id, org_id, page_id, source_type, source_id, source_space_id, source_user_id, excerpt, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'message', $3, $4, $5, $6, NOW())`,
      [ORG_ID, pageId, messageId, spaceId, USER_ID, excerpt],
    );
  });
}

async function insertWikiOp(pageId: string, operation: string, marker: string) {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO wiki_ops_log (id, org_id, operation, page_id, details, performed_by, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, $5, NOW())`,
      [ORG_ID, operation, pageId, JSON.stringify({ marker }), USER_ID],
    );
  });
}

async function callGraph(path: string) {
  const { Hono } = await import('hono');
  const { wikiRoutes } = await import('../src/routes/wiki.js');
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER_ID, org_id: ORG_ID, email: `${USER_ID}@test.local`, name: 'Wiki Graph Test User' });
    await next();
  });
  app.route('/api/wiki', wikiRoutes);
  return app.request(path);
}

test('space graph includes channel-scoped and channel-origin pages, but not unrelated org/pages', async () => {
  const suffix = Date.now();
  const orgGeneralId = await insertPage({
    scope: 'org',
    title: 'General Company Page',
    slug: `wiki-graph-general-${suffix}`,
  });
  const orgFromSpaceId = await insertPage({
    scope: 'org',
    title: 'Channel Origin Company Page',
    slug: `wiki-graph-origin-${suffix}`,
    originSpaceId: SPACE_A_ID,
  });
  const spaceAId = await insertPage({
    scope: 'space',
    title: 'Space A Local Page',
    slug: `wiki-graph-space-a-${suffix}`,
    spaceId: SPACE_A_ID,
    originSpaceId: SPACE_A_ID,
  });
  const spaceBId = await insertPage({
    scope: 'space',
    title: 'Space B Local Page',
    slug: `wiki-graph-space-b-${suffix}`,
    spaceId: SPACE_B_ID,
    originSpaceId: SPACE_B_ID,
  });

  const orgRes = await callGraph('/api/wiki/graph?mode=org&limit=500');
  assert.equal(orgRes.status, 200);
  const orgGraph = await orgRes.json() as any;
  const orgIds = orgGraph.nodes.map((n: any) => n.id);
  assert.ok(orgIds.includes(orgGeneralId), 'org graph should include general org page');
  assert.ok(orgIds.includes(orgFromSpaceId), 'org graph should include org page that originated in a channel');
  assert.ok(!orgIds.includes(spaceAId), 'org graph should not include space-scoped pages');

  const spaceRes = await callGraph(`/api/wiki/graph?mode=space&space_id=${SPACE_A_ID}&limit=500`);
  assert.equal(spaceRes.status, 200);
  const spaceGraph = await spaceRes.json() as any;
  const spaceIds = spaceGraph.nodes.map((n: any) => n.id);
  assert.ok(spaceIds.includes(orgFromSpaceId), 'channel graph should include org page with origin_space_id');
  assert.ok(spaceIds.includes(spaceAId), 'channel graph should include space-scoped page');
  assert.ok(!spaceIds.includes(orgGeneralId), 'channel graph should not include unrelated org page');
  assert.ok(!spaceIds.includes(spaceBId), 'channel graph should not include other channel page');

  const strictRes = await callGraph(`/api/wiki/graph?mode=space&space_id=${SPACE_A_ID}&include_org=false&limit=500`);
  assert.equal(strictRes.status, 200);
  const strictGraph = await strictRes.json() as any;
  const strictIds = strictGraph.nodes.map((n: any) => n.id);
  assert.ok(strictIds.includes(spaceAId), 'strict channel graph should include space-scoped page');
  assert.ok(!strictIds.includes(orgFromSpaceId), 'strict channel graph should exclude org-origin pages');
});

test('wiki log and page detail only expose visible linked pages, citations, and ops', async () => {
  const suffix = Date.now();
  const sourceSlug = `wiki-graph-visible-source-${suffix}`;
  const hiddenSlug = `wiki-graph-hidden-target-${suffix}`;
  const visibleSourceId = await insertPage({
    scope: 'space',
    title: 'Visible Source Page',
    slug: sourceSlug,
    spaceId: SPACE_A_ID,
    originSpaceId: SPACE_A_ID,
  });
  const visibleTargetId = await insertPage({
    scope: 'space',
    title: 'Visible Target Page',
    slug: `wiki-graph-visible-target-${suffix}`,
    spaceId: SPACE_A_ID,
    originSpaceId: SPACE_A_ID,
  });
  const hiddenTargetId = await insertPage({
    scope: 'space',
    title: 'Hidden Target Page',
    slug: hiddenSlug,
    spaceId: HIDDEN_SPACE_ID,
    originSpaceId: HIDDEN_SPACE_ID,
  });

  await insertWikiLink(visibleSourceId, visibleTargetId, 'visible link');
  await insertWikiLink(visibleSourceId, hiddenTargetId, 'hidden link');

  const visibleMessageId = await insertMessage(SPACE_A_ID, 'Visible citation source');
  const hiddenMessageId = await insertMessage(HIDDEN_SPACE_ID, 'Hidden citation source');
  await insertWikiCitation(visibleSourceId, visibleMessageId, SPACE_A_ID, 'visible citation');
  await insertWikiCitation(visibleSourceId, hiddenMessageId, HIDDEN_SPACE_ID, 'hidden citation');

  const operation = `visibility-test-${suffix}`;
  await insertWikiOp(visibleSourceId, operation, 'visible-op');
  await insertWikiOp(hiddenTargetId, operation, 'hidden-op');
  await insertWikiOp(hiddenTargetId, 'contradiction', `hidden-contradiction-${suffix}`);

  const detailRes = await callGraph(`/api/wiki/${sourceSlug}`);
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json() as any;
  assert.ok(detail.linked_pages.some((p: any) => p.slug !== hiddenSlug), 'visible linked page should remain visible');
  assert.ok(!detail.linked_pages.some((p: any) => p.slug === hiddenSlug), 'hidden linked page should not be exposed');
  assert.ok(detail.citations.some((c: any) => c.excerpt === 'visible citation'), 'visible message citation should remain visible');
  assert.ok(!detail.citations.some((c: any) => c.excerpt === 'hidden citation'), 'hidden message citation should not be exposed');

  const logRes = await callGraph(`/api/wiki/log?operation=${operation}&limit=100`);
  assert.equal(logRes.status, 200);
  const log = await logRes.json() as any;
  const markers = log.entries.map((entry: any) => entry.details?.marker);
  assert.ok(markers.includes('visible-op'), 'visible ops log entry should be returned');
  assert.ok(!markers.includes('hidden-op'), 'ops log entry for hidden page should not be returned');

  const contradictionsRes = await callGraph('/api/wiki/contradictions');
  assert.equal(contradictionsRes.status, 200);
  const contradictions = await contradictionsRes.json() as any;
  assert.ok(
    !contradictions.contradictions.some((entry: any) => entry.details?.marker === `hidden-contradiction-${suffix}`),
    'contradictions tied to hidden pages should not be returned',
  );
});
