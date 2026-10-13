import { writeFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { users, orgs, orgMembers, onboardingState, messages } from '@deft/db/schema';
import { nativeMentionRef, nativeMentionToken } from '@deft/shared';
import { db, closeDb } from '../../src/lib/db.js';
import { createWebSession } from '../../src/lib/web-sessions.js';
import { createNativeMentionFixture } from './native-mentions.js';
import { safeTestDatabaseUrl } from './safe-test-database.js';
if (!safeTestDatabaseUrl()) throw new Error('Evidence fixtures require an explicitly disposable test database');
const output = process.env.DEFT_MENTION_FIXTURE_PATH;
if (!output) throw new Error('DEFT_MENTION_FIXTURE_PATH is required');
try {
  const fixture = await createNativeMentionFixture();
  // Reproduce the optional @ prefix observed in actual live model output.
  const modelFormat = [nativeMentionRef('person', fixture.samId), nativeMentionRef('person', fixture.agent2Id),
    nativeMentionRef('task', fixture.taskId), nativeMentionRef('wiki_page', fixture.wikiId)].map(ref => '@' + nativeMentionToken(ref)).join(' ');
  await db.insert(messages).values({ org_id: fixture.orgId, space_id: fixture.publicSpaceId,
    user_id: fixture.agentId, content: 'Agent format example: ' + modelFormat });
  // The browser lab models the supported one-workspace deployment.
  await db.delete(orgMembers).where(eq(orgMembers.org_id, fixture.otherOrgId));
  await db.delete(orgs).where(eq(orgs.id, fixture.otherOrgId));
  const password = 'mentions-demo-only';
  await db.update(users).set({ password_hash: await bcrypt.hash(password, 10), email_verified: true }).where(eq(users.id, fixture.ownerId));
  await db.update(users).set({ password_hash: await bcrypt.hash(password, 10), email_verified: true }).where(eq(users.id, fixture.samId));
  await db.update(orgs).set({ settings: { onboarding_completed: true } }).where(eq(orgs.id, fixture.orgId));
  await db.insert(onboardingState).values([{ user_id: fixture.ownerId, completed: true }, { user_id: fixture.samId, completed: true }]);
  const [owner] = await db.select().from(users).where(eq(users.id, fixture.ownerId));
  const [sam] = await db.select().from(users).where(eq(users.id, fixture.samId));
  const ownerSession = await createWebSession({ id: owner!.id, org_id: fixture.orgId, email: owner!.email! });
  const samSession = await createWebSession({ id: sam!.id, org_id: fixture.orgId, email: sam!.email! });
  await writeFile(output, JSON.stringify({ ...fixture, ownerEmail: owner!.email, samEmail: sam!.email, password,
    ownerSession, samSession, wikiSlug: 'launch-checklist-' + fixture.wikiId }, null, 2));
  console.log('Synthetic native mention evidence fixture saved; no real workspace used.');
} finally { await closeDb(); }
