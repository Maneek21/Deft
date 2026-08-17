/**
 * Block 0.4 — reminder-fire handler unit tests.
 *
 * Exercises the no-op paths (missing row + already-fired) against the real
 * dev DB. Uses Alex PM org (1d7d869a-5e68-48d5-832e-11d8f3bb1dd6) and
 * maneek's user id. Creates + cleans up its own rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { jobQueue, reminders, notifications } from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import {
  reminderFireHandler,
  rehydratePendingReminders,
} from '../src/workers/handlers/reminder-fire.js';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'd4f985f6-6c37-4102-a7e8-32e22cfbe962';

function fakeJob(reminderId: string) {
  return {
    id: 'test-job-' + Math.random().toString(36).slice(2, 8),
    name: 'reminder-fire',
    data: { reminderId },
    attempts: 1,
  };
}

test('reminderFireHandler no-ops on missing reminder row', async () => {
  await reminderFireHandler(fakeJob('does-not-exist-' + Date.now()));
  // If we got here without throwing, the no-op path works.
  assert.ok(true);
});

test('reminderFireHandler fires once, then no-ops on second call', async () => {
  const [inserted] = await db
    .insert(reminders)
    .values({
      org_id: ORG_ID,
      user_id: USER_ID,
      message: 'test-reminder-' + Date.now(),
      remind_at: new Date(Date.now() - 1000), // past
    })
    .returning();
  if (!inserted) throw new Error('failed to insert test reminder');

  try {
    // First fire — should produce a notification + flip is_sent.
    await reminderFireHandler(fakeJob(inserted.id));

    const [fired] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.id, inserted.id))
      .limit(1);
    assert.equal(fired?.is_sent, true, 'reminder should be marked is_sent after fire');

    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.user_id, USER_ID),
          eq(notifications.type, 'reminder'),
        ),
      );
    const match = notifs.find(
      (n) =>
        n.metadata &&
        typeof n.metadata === 'object' &&
        (n.metadata as Record<string, unknown>)['reminder_id'] === inserted.id,
    );
    assert.ok(match, 'notification with matching reminder_id should exist');

    // Second fire — idempotent; no new notification, no error.
    await reminderFireHandler(fakeJob(inserted.id));
    const notifsAfter = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.user_id, USER_ID),
          eq(notifications.type, 'reminder'),
        ),
      );
    const sameCount =
      notifsAfter.filter(
        (n) =>
          n.metadata &&
          typeof n.metadata === 'object' &&
          (n.metadata as Record<string, unknown>)['reminder_id'] === inserted.id,
      ).length;
    assert.equal(sameCount, 1, 'second fire must not produce a duplicate notification');
  } finally {
    await db.delete(notifications).where(and(
      eq(notifications.user_id, USER_ID),
      eq(notifications.type, 'reminder'),
      sql`${notifications.metadata}->>'reminder_id' = ${inserted.id}`,
    ));
    await db.delete(reminders).where(eq(reminders.id, inserted.id));
  }
});

test('concurrent reminder delivery creates exactly one durable notification', async () => {
  const [inserted] = await db.insert(reminders).values({
    org_id: ORG_ID,
    user_id: USER_ID,
    message: `concurrent-reminder-${crypto.randomUUID()}`,
    remind_at: new Date(Date.now() - 1_000),
  }).returning();
  if (!inserted) throw new Error('failed to insert concurrent reminder fixture');

  try {
    await Promise.all(Array.from({ length: 12 }, () =>
      reminderFireHandler(fakeJob(inserted.id))));

    const rows = await db.select({ id: notifications.id })
      .from(notifications)
      .where(and(
        eq(notifications.org_id, ORG_ID),
        eq(notifications.type, 'reminder'),
        sql`${notifications.metadata}->>'reminder_id' = ${inserted.id}`,
      ));
    assert.equal(rows.length, 1);

    const [fired] = await db.select({ isSent: reminders.is_sent })
      .from(reminders)
      .where(eq(reminders.id, inserted.id));
    assert.equal(fired?.isSent, true);
  } finally {
    await db.delete(notifications).where(and(
      eq(notifications.org_id, ORG_ID),
      eq(notifications.type, 'reminder'),
      sql`${notifications.metadata}->>'reminder_id' = ${inserted.id}`,
    ));
    await db.delete(reminders).where(eq(reminders.id, inserted.id));
  }
});

test('rehydratePendingReminders scans and returns a count without throwing', async () => {
  const count = await rehydratePendingReminders();
  assert.ok(typeof count === 'number' && count >= 0);
});

test('concurrent reminder rehydration leaves one deduplicated queue row', async () => {
  const [inserted] = await db.insert(reminders).values({
    org_id: ORG_ID,
    user_id: USER_ID,
    message: `rehydrate-dedupe-${crypto.randomUUID()}`,
    // Deliberately beyond the old 30-day horizon: every durable pending
    // reminder must be recoverable after restart.
    remind_at: new Date(Date.now() + 45 * 24 * 60 * 60_000),
  }).returning();
  if (!inserted) throw new Error('failed to insert reminder rehydration fixture');
  const dedupeKey = `reminder:${inserted.id}`;

  try {
    await Promise.all([
      rehydratePendingReminders(),
      rehydratePendingReminders(),
      rehydratePendingReminders(),
    ]);

    const rows = await db.select({
      id: jobQueue.id,
      orgId: jobQueue.org_id,
      status: jobQueue.status,
    })
      .from(jobQueue)
      .where(eq(jobQueue.dedupe_key, dedupeKey));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.orgId, ORG_ID);
    assert.equal(rows[0]?.status, 'pending');
  } finally {
    await db.delete(jobQueue).where(eq(jobQueue.dedupe_key, dedupeKey));
    await db.delete(reminders).where(eq(reminders.id, inserted.id));
  }
});
