/**
 * Channel-aware wiki graph tests.
 *
 * Run: pnpm --filter @deft/api test -- wiki-graph-scope
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = `wiki-graph-user-${Date.now()}`;
const SPACE_A_ID = `wiki-graph-space-a-${Date.now()}`;
const SPACE_B_ID = `wiki-graph-space-b-${Date.now()}`;

const createdPageIds: string[] = [];

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
  });
});

after(async () => {
  await withClient(async (c) => {
    if (createdPageIds.length > 0) {
      await c.query(`DELETE FROM wiki_links WHERE source_page_id = ANY($1) OR target_page_id = ANY($1)`, [createdPageIds]);
      await c.query(`DELETE FROM wiki_citations WHERE page_id = ANY($1)`, [createdPageIds]);
      await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [createdPageIds]);
    }
    await c.query(`DELETE FROM space_members WHERE space_id = ANY($1)`, [[SPACE_A_ID, SPACE_B_ID]]);
    await c.query(`DELETE FROM spaces WHERE id = ANY($1)`, [[SPACE_A_ID, SPACE_B_ID]]);
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
