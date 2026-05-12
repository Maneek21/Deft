/**
 * Block 2.6 — decision link/implemented tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/decision-link.test.ts
 *
 * Note: decisions live on wikiPages WHERE type='decision' since the legacy
 * `decisions` table was retired 2026-05-12. `mark_decision_implemented` now
 * stamps the page with the `implemented` tag (returned as `implemented_at`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray, and } from 'drizzle-orm';
import {
  db, tasks, projects, wikiPages, spaces, messages, crossReferences,
  orgs, users, orgMembers,
} from '@deft/db';
import { executeActionDirect } from '../src/lib/agent-actions.js';

let testOrgId: string;
let testUserId: string;
let projectId: string;
let spaceId: string;
let parentMsgId: string;
let decisionId: string;
let taskA: string;
let taskB: string;

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b26', slug: 'b26' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b26-${Date.now()}@t.local`, name: 'b26' });

  const mem = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!mem) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  projectId = crypto.randomUUID();
  await db.insert(projects).values({
    id: projectId, org_id: testOrgId, name: 'b26-project',
    prefix: `B26${Date.now()}`.slice(0, 10), created_by: testUserId,
  });

  taskA = crypto.randomUUID();
  taskB = crypto.randomUUID();
  await db.insert(tasks).values([
    { id: taskA, org_id: testOrgId, project_id: projectId, number: 1, title: 'A', created_by: testUserId },
    { id: taskB, org_id: testOrgId, project_id: projectId, number: 2, title: 'B', created_by: testUserId },
  ]);

  // A decision needs an anchoring space+message (for the citation context).
  const existingSpace = await db.query.spaces.findFirst({ where: (s, { eq }) => eq(s.org_id, testOrgId) });
  if (existingSpace) {
    spaceId = existingSpace.id;
  } else {
    spaceId = crypto.randomUUID();
    await db.insert(spaces).values({
      id: spaceId, org_id: testOrgId, name: 'b26-space', type: 'public', created_by: testUserId,
    });
  }
  parentMsgId = crypto.randomUUID();
  await db.insert(messages).values({
    id: parentMsgId, org_id: testOrgId, space_id: spaceId, user_id: testUserId,
    content: 'Decision anchor message',
  });

  decisionId = crypto.randomUUID();
  await db.insert(wikiPages).values({
    id: decisionId,
    org_id: testOrgId,
    scope: 'space',
    space_id: spaceId,
    user_id: testUserId,
    type: 'decision',
    title: 'We will migrate to PostgreSQL 16.',
    slug: `b26-decision-${Date.now().toString(36)}`,
    content: 'We will migrate to PostgreSQL 16.',
    confidence: 1.0,
  });
});

after(async () => {
  await db.delete(crossReferences).where(eq(crossReferences.source_id, decisionId));
  await db.delete(wikiPages).where(eq(wikiPages.id, decisionId));
  await db.delete(messages).where(eq(messages.id, parentMsgId));
  await db.delete(tasks).where(inArray(tasks.id, [taskA, taskB]));
  await db.delete(projects).where(eq(projects.id, projectId));
});

test('link_decision_to_tasks creates cross_references for valid tasks', async () => {
  const r = await executeActionDirect(
    'link_decision_to_tasks',
    { decision_id: decisionId, task_ids: [taskA, taskB], context: 'Migration work items' },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.result.linked_task_ids.length, 2);

  const refs = await db
    .select()
    .from(crossReferences)
    .where(and(eq(crossReferences.source_type, 'decision'), eq(crossReferences.source_id, decisionId)));
  assert.equal(refs.length, 2);
  assert.ok(refs.every((r) => r.target_type === 'task'));
});

test('link_decision_to_tasks is idempotent on re-link', async () => {
  const r = await executeActionDirect(
    'link_decision_to_tasks',
    { decision_id: decisionId, task_ids: [taskA] },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, true);
  const refs = await db
    .select()
    .from(crossReferences)
    .where(and(eq(crossReferences.source_id, decisionId), eq(crossReferences.target_id, taskA)));
  assert.equal(refs.length, 1, 'no duplicate row created');
});

test('link_decision_to_tasks skips unknown task ids', async () => {
  const bogus = crypto.randomUUID();
  const r = await executeActionDirect(
    'link_decision_to_tasks',
    { decision_id: decisionId, task_ids: [taskA, bogus] },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, true);
  assert.ok(r.result.skipped.includes(bogus));
  assert.ok(r.result.linked_task_ids.includes(taskA));
});

test('link_decision_to_tasks rejects empty task_ids', async () => {
  const r = await executeActionDirect(
    'link_decision_to_tasks',
    { decision_id: decisionId, task_ids: [] },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, false);
});

test('mark_decision_implemented tags the wiki page as implemented', async () => {
  const r = await executeActionDirect(
    'mark_decision_implemented',
    { decision_id: decisionId },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(r.result.implemented_at);

  const [page] = await db.select().from(wikiPages).where(eq(wikiPages.id, decisionId));
  assert.ok(page, 'wiki page must exist');
  assert.ok((page!.tags ?? []).includes('implemented'), 'page must carry the implemented tag');
});

test('mark_decision_implemented is idempotent', async () => {
  const r = await executeActionDirect(
    'mark_decision_implemented',
    { decision_id: decisionId },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, true);
  assert.equal(r.result.already_implemented, true);
});

test('mark_decision_implemented rejects unknown id', async () => {
  const r = await executeActionDirect(
    'mark_decision_implemented',
    { decision_id: crypto.randomUUID() },
    testOrgId, testUserId, null, 'quick',
  );
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('not found'));
});
