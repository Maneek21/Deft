import { and, eq } from 'drizzle-orm';
import { events } from '@deft/db/schema';
import { db } from './db.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CalendarInput = {
  title: string; start: string; end: string; description?: string; location?: string;
  attendees?: { email: string; displayName?: string; name?: string }[];
};

/** Authorization and validation belong to the caller. No notifications or external effects. */
export async function createNativeCalendarEventInTransaction(tx: Transaction, options: {
  orgId: string; userId: string; email: string | null; input: CalendarInput;
}) {
  const { input } = options;
  const start = new Date(input.start);
  const [created] = await tx.insert(events).values({
    org_id: options.orgId, source: 'native', event_type: 'calendar_event', external_id: null,
    title: input.title, body: input.description || null, url: null, actor: options.email,
    timestamp: start, user_id: options.userId, connected_account_id: null,
    metadata: {
      start: start.toISOString(), end: new Date(input.end).toISOString(), location: input.location || null,
      attendees: (input.attendees ?? []).map(attendee => ({ email: attendee.email,
        displayName: attendee.displayName ?? attendee.name ?? attendee.email.split('@')[0] })),
      hangoutLink: null, status: 'confirmed', allDay: false,
    },
  }).returning();
  return created!;
}

export async function loadNativeCalendarEventInTransaction(tx: Transaction, options: { orgId: string; userId: string; eventId: string }) {
  return (await tx.select().from(events).where(and(eq(events.id, options.eventId), eq(events.org_id, options.orgId),
    eq(events.user_id, options.userId), eq(events.source, 'native'), eq(events.event_type, 'calendar_event'))).limit(1))[0];
}

/** Invoke only after exact succeeded create-Run ancestry is verified in the same transaction. */
export async function cancelNativeCalendarEventInTransaction(tx: Transaction, options: { orgId: string; userId: string; eventId: string }) {
  const [event] = await tx.select().from(events).where(and(eq(events.id, options.eventId), eq(events.org_id, options.orgId),
    eq(events.user_id, options.userId), eq(events.source, 'native'), eq(events.event_type, 'calendar_event'))).limit(1).for('update');
  if (!event) return undefined;
  const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata as Record<string, unknown> : {};
  const [updated] = await tx.update(events).set({ metadata: { ...metadata, status: 'canceled' } })
    .where(and(eq(events.id, event.id), eq(events.org_id, options.orgId), eq(events.user_id, options.userId))).returning();
  return updated;
}
