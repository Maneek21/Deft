/**
 * Verifies ensureDeftyMembership is idempotent and creates Defty correctly.
 * Phase 1 of agent-chat unification.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/ensure-defty-membership.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { ensureDeftyMembership, DEFTY_EMAIL, DEFTY_NAME } from '../src/lib/ensure-defty-membership.js';

let orgIdA: string;
let orgIdB: string;
// Track the Defty user id so we can clean up only org_members rows we created
// (we MUST NOT delete the Defty user row itself if it pre-existed in the DB).
let deftyExistedBefore = false;
let preExistingDeftyUserId: string | null = null;

before(async () => {
  // Detect whether Defty already exists (e.g. from prior @deft mentions).
  const [existing] = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEFTY_EMAIL))
    .limit(1);
  if (existing) {
    deftyExistedBefore = true;
    preExistingDeftyUserId = existing.id;
  }

  const [a] = await db.insert(orgs).values({ name: 'Defty Test A', slug: `dt-a-${Date.now()}` }).returning();
  orgIdA = a!.id;
  const [b] = await db.insert(orgs).values({ name: 'Defty Test B', slug: `dt-b-${Date.now()}` }).returning();
  orgIdB = b!.id;
});

after(async () => {
  try {
    // Delete org_members for our test orgs only.
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgIdA));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgIdB));
    await db.delete(orgs).where(eq(orgs.id, orgIdA));
    await db.delete(orgs).where(eq(orgs.id, orgIdB));
    // Only delete Defty user if it didn't pre-exist (we created it).
    if (!deftyExistedBefore) {
      await db.delete(users).where(eq(users.email, DEFTY_EMAIL));
    }
  } catch (err) {
    console.error('cleanup error', err);
  }
});

test('ensureDeftyMembership creates Defty user with kind=agent', async () => {
  const userId = await ensureDeftyMembership(orgIdA);
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  assert.equal(u?.email, DEFTY_EMAIL);
  assert.equal(u?.kind, 'agent');
  assert.equal(u?.is_agent, true);
  assert.equal(u?.name, DEFTY_NAME);
});

test('ensureDeftyMembership creates org_members row in target org', async () => {
  const userId = await ensureDeftyMembership(orgIdA);
  const [m] = await db.select()
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgIdA), eq(orgMembers.user_id, userId)))
    .limit(1);
  assert.ok(m, 'org_members row should exist');
  assert.equal(m?.role, 'member');
});

test('ensureDeftyMembership is idempotent — second call same userId, no duplicate org_members', async () => {
  const id1 = await ensureDeftyMembership(orgIdA);
  const id2 = await ensureDeftyMembership(orgIdA);
  assert.equal(id1, id2);

  const memberRows = await db.select()
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, orgIdA), eq(orgMembers.user_id, id1)));
  assert.equal(memberRows.length, 1);
});

test('ensureDeftyMembership reuses Defty user across orgs', async () => {
  const id1 = await ensureDeftyMembership(orgIdA);
  const id2 = await ensureDeftyMembership(orgIdB);
  assert.equal(id1, id2);

  const allMemberships = await db.select().from(orgMembers).where(eq(orgMembers.user_id, id1));
  // At least 2 (orgA + orgB); could be more if Defty was previously joined to other orgs.
  assert.ok(allMemberships.length >= 2, `expected >=2 memberships, got ${allMemberships.length}`);
});
