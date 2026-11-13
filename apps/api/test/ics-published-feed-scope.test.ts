import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, events, orgMembers, orgs, projects, tasks, users } from '@deft/db';
import { icsPublicRoutes } from '../src/routes/ics.js';
import { installRequestGate, isPublicApiRequest } from '../src/middleware/request-gate.js';

const s = crypto.randomUUID().replace(/-/g, '');
const orgA = crypto.randomUUID();
const foreignOrg = crypto.randomUUID();
const owner = crypto.randomUUID();
const other = crypto.randomUUID();
const ownerToken = `ownerfeed${s}`;
const due = new Date(Date.now() + 24 * 60 * 60 * 1000);
const projectIds = { live: crypto.randomUUID(), archived: crypto.randomUUID(), deleted: crypto.randomUUID(), foreign: crypto.randomUUID() };

const app = new Hono();
app.route('/api/ics', icsPublicRoutes);

async function fetchFeed(token: string) {
  const res = await app.request(`/api/ics/feed/${token}`);
  return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
}

function task(projectId: string, number: number, title: string, extra: Partial<typeof tasks.$inferInsert> = {}) {
  return { org_id: orgA, project_id: projectId, number, title, assignee_id: owner, created_by: owner, due_date: due, ...extra };
}

before(async () => {
  await db.insert(orgs).values([
    { id: orgA, name: `Feed A ${s}`, slug: `feed-a-${s}` },
    { id: foreignOrg, name: `Feed foreign ${s}`, slug: `feed-foreign-${s}` },
  ]);
  await db.insert(users).values([
    { id: owner, email: `feed-owner-${s}@test.local`, name: 'Feed Owner', ics_publish_token: ownerToken },
    { id: other, email: `feed-other-${s}@test.local`, name: 'Feed Other' },
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgA, user_id: owner },
    { org_id: orgA, user_id: other },
  ]);
  await db.insert(projects).values([
    { id: projectIds.live, org_id: orgA, name: 'Live', prefix: `L${s.slice(0, 6)}` },
    { id: projectIds.archived, org_id: orgA, name: 'Archived', prefix: `R${s.slice(0, 6)}`, is_archived: true },
    { id: projectIds.deleted, org_id: orgA, name: 'Deleted', prefix: `D${s.slice(0, 6)}`, is_deleted: true, deleted_at: new Date() },
    { id: projectIds.foreign, org_id: foreignOrg, name: 'Foreign', prefix: `F${s.slice(0, 6)}` },
  ]);
  await db.insert(tasks).values([
    task(projectIds.live, 1, 'LIVE-A-TASK'),
    task(projectIds.live, 2, 'SOFTDELETED-A-TASK', { is_deleted: true }),
    task(projectIds.live, 3, 'TEMPLATE-A-TASK', { is_template: true }),
    task(projectIds.live, 4, 'RESTRICTED-OWNER-TASK', { metadata: { visibility: 'restricted' } }),
    task(projectIds.live, 5, 'RESTRICTED-HIDDEN-TASK', { assignee_id: other, created_by: other, metadata: { visibility: 'restricted' } }),
    task(projectIds.archived, 1, 'ARCHIVEDPROJ-A-TASK'),
    task(projectIds.deleted, 1, 'DELETEDPROJ-A-TASK'),
    task(projectIds.foreign, 1, 'MISMATCHED-PROJECT-TASK'),
    { ...task(projectIds.foreign, 2, 'FOREIGN-ORG-TASK'), org_id: foreignOrg },
  ]);
  await db.insert(events).values(
    { org_id: orgA, source: 'native', event_type: 'calendar_event', title: 'EVENT-A', timestamp: due, metadata: {}, user_id: owner },
  );
});

after(async () => {
  await db.delete(events).where(eq(events.org_id, orgA));
  await db.delete(tasks).where(inArray(tasks.org_id, [orgA, foreignOrg]));
  await db.delete(projects).where(inArray(projects.org_id, [orgA, foreignOrg]));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, orgA));
  await db.delete(users).where(inArray(users.id, [owner, other]));
  await db.delete(orgs).where(inArray(orgs.id, [orgA, foreignOrg]));
});

test('unknown, malformed and rotated tokens get one answer', async () => {
  const unknown = await fetchFeed(`nosuchtoken${s}`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await fetchFeed('short'), unknown);
  const rotatedFrom = `rotated${s}`;
  await db.update(users).set({ ics_publish_token: rotatedFrom }).where(eq(users.id, other));
  await db.update(users).set({ ics_publish_token: `rotatedto${s}` }).where(eq(users.id, other));
  assert.deepEqual(await fetchFeed(rotatedFrom), unknown);
});

test('the feed lists only live tasks the owner may see', async () => {
  const res = await fetchFeed(ownerToken);
  assert.equal(res.status, 200);
  assert.match(res.body, /LIVE-A-TASK/);
  assert.match(res.body, /EVENT-A/);
  assert.match(res.body, /RESTRICTED-OWNER-TASK/, 'assignee may see a restricted task under the current rule');
  for (const absent of ['SOFTDELETED-A-TASK', 'TEMPLATE-A-TASK', 'RESTRICTED-HIDDEN-TASK', 'ARCHIVEDPROJ-A-TASK', 'DELETEDPROJ-A-TASK', 'MISMATCHED-PROJECT-TASK', 'FOREIGN-ORG-TASK']) {
    assert.doesNotMatch(res.body, new RegExp(absent), absent);
  }
});

test('request log lines for a feed fetch never contain the token', async () => {
  const { requestLogger } = await import('../src/lib/request-logger.js');
  const logged: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  try {
    const logApp = new Hono();
    logApp.use('*', requestLogger);
    logApp.route('/api/ics', icsPublicRoutes);
    logApp.get('/api/other/:id', (c) => c.text('ok'));
    logApp.get('/api/files/:id', (c) => c.text('ok'));
    installRequestGate(logApp, {
      isPublic: isPublicApiRequest,
      authenticate: async () => ({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED', status: 401 }) as never,
      edgeMiddleware: [requestLogger],
    });
    const encodedFirst = `%${ownerToken.charCodeAt(0).toString(16)}${ownerToken.slice(1)}`;
    const paths = [
      `/api/ics/feed/${ownerToken}`,
      `/api/ics/feed/${ownerToken}?x=1`,
      `/api/ics/feed/${encodedFirst}`,
      `/api/ics/%66eed/${ownerToken}`,
      `/api/ics/%66eed/${ownerToken}?x=%`,
      `/api/ics/feed/%zz${ownerToken}`,
      `/api/ics/feed//${ownerToken}`,
      `/API/ICS/FEED/${ownerToken}`,
      `/api/ics/feed/nosuchtoken${s}`,
    ];
    const statuses = new Set<number>();
    for (const p of paths) statuses.add((await logApp.request(p)).status);
    for (const p of [`/api/ics/feed/${ownerToken}`, `/api/ics/feed/%01${ownerToken}`]) {
      statuses.add((await logApp.request(p, { method: 'HEAD' })).status);
      statuses.add((await logApp.request(p, { method: 'POST' })).status);
    }
    assert.ok(statuses.has(200) && statuses.has(400) && statuses.has(401), `gate denials covered: ${[...statuses]}`);
    const feedLines = logged.join('\n');
    assert.equal(logged.length, (paths.length + 4) * 2, 'feed requests are still logged');
    assert.doesNotMatch(feedLines, new RegExp(ownerToken.slice(2)));
    assert.doesNotMatch(feedLines, new RegExp(`nosuchtoken${s}`));
    for (const line of logged) assert.match(line, /^(<--|-->) (GET|HEAD|POST) \/api\/ics\/feed\/<redacted>( |$)/, line);
    logged.length = 0;
    await logApp.request('/api/other/abc123?q=1');
    assert.equal(logged[0], '<-- GET /api/other/abc123?q=1');
    assert.match(logged[1] ?? '', /^--> GET \/api\/other\/abc123\?q=1 /);
    logged.length = 0;
    await logApp.request('/api/files/%2Fics%2Ffeed%2Fexample');
    assert.equal(logged[0], '<-- GET /api/files/%2Fics%2Ffeed%2Fexample');
  } finally {
    console.log = orig;
  }
});
