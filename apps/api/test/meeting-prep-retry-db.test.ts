/**
 * D09 (meeting prep) — a run that fails after its notification was written is
 * reclaimed and retried; the retry must not notify the user a second time.
 * The failure is injected with a test-only trigger on automation_runs scoped
 * to this org. No provider key is configured, so synthesis uses the
 * deterministic fallback and no model request is made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { automationRuns, events, meetingBriefs, notifications, orgMembers, orgs, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import { generateMeetingPrep } from '../src/lib/meeting-prep-automation.js';

const orgId = randomUUID();
const userId = randomUUID();
const eventId = randomUUID();
const failFn = `d09_fail_delivered_${orgId.replace(/-/g, '')}`;

before(async () => {
  await db.insert(orgs).values({ id: orgId, name: 'D09 meeting prep', slug: `d09-${orgId}` });
  await db.insert(users).values({ id: userId, name: 'D09 Human', email: `d09-${userId}@test.local`, kind: 'human', is_agent: false, email_verified: true });
  await db.insert(orgMembers).values({ org_id: orgId, user_id: userId, role: 'owner' });
  await db.insert(events).values({
    id: eventId, org_id: orgId, user_id: userId, source: 'ics', event_type: 'calendar_event',
    external_id: `d09-${eventId}`, title: 'Quarterly planning review', timestamp: new Date(Date.now() + 20 * 60_000), metadata: {},
  });
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION ${failFn}() RETURNS trigger AS $$
    BEGIN
      IF NEW.org_id = '${orgId}' AND NEW.status = 'delivered' THEN
        RAISE EXCEPTION 'D09 injected delivery bookkeeping failure';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `));
});

after(async () => {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${failFn} ON automation_runs`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${failFn}()`));
  await db.execute(sql`DELETE FROM attention_items WHERE user_id = ${userId}`).catch(() => undefined);
  await db.delete(notifications).where(eq(notifications.org_id, orgId));
  await db.delete(meetingBriefs).where(eq(meetingBriefs.org_id, orgId));
  await db.delete(automationRuns).where(eq(automationRuns.org_id, orgId));
  await db.delete(events).where(eq(events.id, eventId));
  await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

test('D09: a retried meeting-prep run does not notify the user twice', async () => {
  await db.execute(sql.raw(`CREATE TRIGGER ${failFn} BEFORE UPDATE ON automation_runs FOR EACH ROW EXECUTE FUNCTION ${failFn}()`));
  try {
    await assert.rejects(generateMeetingPrep(eventId), (err: any) => /D09 injected/.test(String(err?.cause?.message ?? err?.message)));
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${failFn} ON automation_runs`));
  }
  const retried = await generateMeetingPrep(eventId);
  assert.equal(retried.alreadyExisted, false, 'the failed run is reclaimed and retried');
  assert.equal(retried.run?.status, 'delivered');
  const sent = await db.select({ id: notifications.id }).from(notifications).where(and(
    eq(notifications.org_id, orgId), eq(notifications.user_id, userId),
    sql`${notifications.metadata}->>'event_id' = ${eventId}`,
  ));
  assert.equal(sent.length, 1, 'one meeting-prep notification per run');
  const briefs = await db.select({ id: meetingBriefs.id }).from(meetingBriefs).where(eq(meetingBriefs.event_id, eventId));
  assert.equal(briefs.length, 1);
});
