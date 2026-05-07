/**
 * Block 2.3 — canvas agent tools tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/canvas-tools.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { db, canvases, spaces, orgs, users, orgMembers } from '@deft/db';
import { executeActionDirect } from '../src/lib/agent-actions.js';

let testOrgId: string;
let testUserId: string;
let spaceId: string;
let spaceName: string;

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b23', slug: 'b23' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b23-${Date.now()}@t.local`, name: 'b23' });

  const member = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!member) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  // Dedicated space with a unique name for this test run so the canvas row is
  // clean.
  spaceId = crypto.randomUUID();
  spaceName = `b23-canvas-${Date.now()}`;
  await db.insert(spaces).values({
    id: spaceId,
    org_id: testOrgId,
    name: spaceName,
    type: 'public',
    created_by: testUserId,
  });
});

after(async () => {
  await db.delete(canvases).where(eq(canvases.space_id, spaceId));
  await db.delete(spaces).where(eq(spaces.id, spaceId));
});

test('read_canvas returns exists=false for a space with no canvas', async () => {
  const r = await executeActionDirect(
    'read_canvas',
    { space_name: spaceName },
    testOrgId, testUserId, null, 'auto',
  );
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.result.exists, false);
});

test('write_canvas upserts with HTML string content', async () => {
  const r = await executeActionDirect(
    'write_canvas',
    { space_name: spaceName, content: 'Hello canvas world' },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(r.result.canvas_id);

  const [row] = await db.select().from(canvases).where(eq(canvases.id, r.result.canvas_id));
  assert.ok(row);
  assert.equal(row!.space_id, spaceId);
  // string wrapped into TipTap doc
  const content = row!.content as any;
  assert.equal(content.type, 'doc');
  assert.ok(Array.isArray(content.content));
});

test('write_canvas updates existing row, not inserts a duplicate', async () => {
  const r1 = await executeActionDirect(
    'write_canvas',
    { space_name: spaceName, content: 'first write' },
    testOrgId, testUserId, null, 'quick',
  );
  const r2 = await executeActionDirect(
    'write_canvas',
    { space_name: spaceName, content: 'second write', title: 'Updated title' },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r1.result.canvas_id, r2.result.canvas_id, 'same canvas row');

  const rows = await db.select().from(canvases).where(eq(canvases.space_id, spaceId));
  assert.equal(rows.length, 1, 'only one canvas row per space');
  assert.equal(rows[0]!.title, 'Updated title');
});

test('read_canvas returns content after write', async () => {
  const r = await executeActionDirect(
    'read_canvas',
    { space_name: spaceName },
    testOrgId, testUserId, null, 'auto',
  );
  assert.equal(r.result.exists, true);
  assert.ok(r.result.canvas);
  assert.equal(r.result.canvas.title, 'Updated title');
});

test('write_canvas rejects missing content', async () => {
  const r = await executeActionDirect(
    'write_canvas',
    { space_name: spaceName } as any,
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('content is required'));
});

test('read_canvas rejects missing space_name', async () => {
  const r = await executeActionDirect(
    'read_canvas',
    {} as any,
    testOrgId, testUserId, null, 'auto',
  );
  assert.equal(r.success, false);
});

test('write_canvas rejects unknown space', async () => {
  const r = await executeActionDirect(
    'write_canvas',
    { space_name: `definitely-missing-${Date.now()}`, content: 'x' },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('not found'));
});
