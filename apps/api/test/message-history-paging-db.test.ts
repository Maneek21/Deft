import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { messages, orgMembers, orgs, spaceMembers, spaces, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';

const orgId = randomUUID();
const humanId = randomUUID();
const spaceId = randomUUID();
let app: Hono;
const inserted: string[] = [];

type Page = { messages: Array<{ id: string; created_at: string }>; next_cursor: string | null };

async function insertAt(content: string, at: string) {
  const [row] = await db.insert(messages).values({
    org_id: orgId, space_id: spaceId, user_id: humanId, content, created_at: sql`${at}::timestamp`,
  }).returning({ id: messages.id });
  inserted.push(row!.id);
}

before(async () => {
  await db.insert(orgs).values({ id: orgId, name: 'History paging', slug: `hist-${orgId}` });
  await db.insert(users).values({ id: humanId, name: 'Reader', email: `hist-${humanId}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: humanId, role: 'owner' });
  await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'hist-space', type: 'public', created_by: humanId });
  await db.insert(spaceMembers).values({ space_id: spaceId, user_id: humanId });
  await insertAt('oldest', '2026-01-01 00:00:00.100');
  // Five messages inside one millisecond: three share the exact instant, two
  // differ only in microseconds.
  await insertAt('tie-1', '2026-01-01 00:00:00.123');
  await insertAt('tie-2', '2026-01-01 00:00:00.123');
  await insertAt('tie-3', '2026-01-01 00:00:00.123');
  await insertAt('micro-1', '2026-01-01 00:00:00.123400');
  await insertAt('micro-2', '2026-01-01 00:00:00.123800');
  await insertAt('newest', '2026-01-01 00:00:00.200');
  const { messageRoutes } = await import('../src/routes/messages.js');
  app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: humanId, org_id: orgId, email: `hist-${humanId}@test.local`, role: 'owner' } as any);
    await next();
  });
  app.route('/messages', messageRoutes);
});

after(async () => {
  await db.delete(messages).where(eq(messages.space_id, spaceId));
  await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
  await db.delete(users).where(eq(users.id, humanId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

async function readPage(limit: number, cursor?: string): Promise<{ status: number; body: Page }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  const response = await app.request(`/messages/${spaceId}?${query.toString()}`);
  return { status: response.status, body: await response.json() as Page };
}

for (const limit of [1, 2, 3, 4]) {
  test(`W2-1: following next_cursor with page size ${limit} returns every message exactly once, newest page first`, async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const { status, body } = await readPage(limit, cursor);
      assert.equal(status, 200);
      // Each page is oldest first; pages run newest to oldest.
      seen.unshift(...body.messages.map((m) => m.id));
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }
    assert.equal(seen.length, inserted.length, 'no message skipped or repeated');
    assert.equal(new Set(seen).size, inserted.length);
    assert.deepEqual(new Set(seen), new Set(inserted));
    const first = seen.indexOf(inserted[0]!);
    const last = seen.indexOf(inserted[inserted.length - 1]!);
    assert.equal(first, 0, 'oldest message comes first');
    assert.equal(last, inserted.length - 1, 'newest message comes last');
  });
}

test('W2-1: next_cursor names the oldest message of the page', async () => {
  const { body } = await readPage(2);
  const oldestOnPage = body.messages[0]!;
  assert.ok(body.next_cursor?.endsWith(`|${oldestOnPage.id}`));
});

test('W2-1: a plain timestamp cursor is still accepted and pages to older messages', async () => {
  const { status, body } = await readPage(10, '2026-01-01T00:00:00.123Z');
  assert.equal(status, 200);
  assert.deepEqual(body.messages.map((m) => m.id), [inserted[0]]);
});

test('W2-1: an unreadable cursor is refused', async () => {
  const { status, body } = await readPage(10, 'not-a-time');
  assert.equal(status, 400);
  assert.equal((body as unknown as { code: string }).code, 'VALIDATION_ERROR');
});
