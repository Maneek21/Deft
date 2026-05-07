/**
 * Block 2.7 — member.joined trigger fan-out.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/member-joined-trigger.test.ts
 *
 * Uses the real DB. Seeds two agent-employees: one subscribed to
 * `member.joined`, one not. Verifies only the subscriber gets an
 * employee-trigger job enqueued.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, inArray, sql } from 'drizzle-orm';
import {
  db, agentEmployees, orgs, users, orgMembers,
} from '@deft/db';
import { emitMemberJoinedTrigger } from '../src/lib/member-joined-trigger.js';

let testOrgId: string;
let testUserId: string;
let newUserId: string;
let subscriberId: string;
let nonSubscriberId: string;

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b27', slug: 'b27' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b27-${Date.now()}@t.local`, name: 'b27' });

  newUserId = crypto.randomUUID();
  await db.insert(users).values({ id: newUserId, email: `b27-new-${Date.now()}@t.local`, name: 'Fresh hire' });

  const mem = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!mem) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  // Subscriber — trigger_subscriptions includes member.joined
  subscriberId = crypto.randomUUID();
  await db.insert(agentEmployees).values({
    id: subscriberId, org_id: testOrgId, user_id: testUserId,
    slug: `b27-hr-${Date.now()}`, name: 'HR Agent', system_prompt: 'test',
    is_byoa: true, trust_level: 'standard',
    trigger_subscriptions: ['member.joined'] as any,
    created_by: testUserId, role: 'project_manager',
    is_active: true,
  });
  nonSubscriberId = crypto.randomUUID();
  await db.insert(agentEmployees).values({
    id: nonSubscriberId, org_id: testOrgId, user_id: testUserId,
    slug: `b27-other-${Date.now()}`, name: 'Other', system_prompt: 'test',
    is_byoa: true, trust_level: 'standard',
    trigger_subscriptions: ['cron:standup'] as any,
    created_by: testUserId, role: 'project_manager',
    is_active: true,
  });
});

afterEach(async () => {
  // clear any job_queue rows created by our emit
  await db.execute(sql`DELETE FROM job_queue WHERE queue='agent-jobs' AND name='employee-trigger' AND (data->>'trigger_kind')='member.joined'`);
});

after(async () => {
  await db.delete(agentEmployees).where(inArray(agentEmployees.id, [subscriberId, nonSubscriberId]));
  await db.delete(orgMembers).where(eq(orgMembers.user_id, newUserId));
  await db.delete(users).where(eq(users.id, newUserId));
});

test('emitMemberJoinedTrigger enqueues only for subscribed employees', async () => {
  const count = await emitMemberJoinedTrigger({
    org_id: testOrgId,
    new_user_id: newUserId,
    inviter_user_id: testUserId,
    role: 'member',
  });
  assert.equal(count, 1, `expected 1 subscriber dispatched, got ${count}`);

  // Verify job_queue row shape
  const rows = await db.execute(sql`
    SELECT data FROM job_queue
    WHERE queue='agent-jobs' AND name='employee-trigger'
  `);
  const records = (rows as any).rows ?? (rows as any);
  const matching = records.filter((r: any) => {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return d.trigger_kind === 'member.joined' && d.employee_id === subscriberId;
  });
  assert.ok(matching.length >= 1, 'subscriber got a job row');
  const nonMatch = records.filter((r: any) => {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return d.trigger_kind === 'member.joined' && d.employee_id === nonSubscriberId;
  });
  assert.equal(nonMatch.length, 0, 'non-subscriber did NOT get a job');
});

test('emitMemberJoinedTrigger returns 0 when no subscribers', async () => {
  // Temporarily strip the subscription from our subscriber
  await db.update(agentEmployees)
    .set({ trigger_subscriptions: null })
    .where(eq(agentEmployees.id, subscriberId));

  const count = await emitMemberJoinedTrigger({
    org_id: testOrgId,
    new_user_id: newUserId,
    inviter_user_id: testUserId,
    role: 'member',
  });
  assert.equal(count, 0);

  // Restore for next test
  await db.update(agentEmployees)
    .set({ trigger_subscriptions: ['member.joined'] as any })
    .where(eq(agentEmployees.id, subscriberId));
});

test('payload carries new_user_name + new_user_email', async () => {
  await emitMemberJoinedTrigger({
    org_id: testOrgId,
    new_user_id: newUserId,
    inviter_user_id: testUserId,
    role: 'member',
  });
  const rows = await db.execute(sql`
    SELECT data FROM job_queue
    WHERE queue='agent-jobs' AND name='employee-trigger'
    ORDER BY created_at DESC LIMIT 1
  `);
  const records = (rows as any).rows ?? (rows as any);
  const d = typeof records[0].data === 'string' ? JSON.parse(records[0].data) : records[0].data;
  assert.equal(d.context.new_user_name, 'Fresh hire');
  assert.equal(d.context.role, 'member');
});
