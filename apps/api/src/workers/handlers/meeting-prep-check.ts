import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { events } from '@deft/db/schema';
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import { meetingPrepWindow } from '../../lib/automation-schedule.js';
import { generateMeetingPrep } from '../../lib/meeting-prep-automation.js';

export async function handleMeetingPrepCheck(_job: JobData): Promise<void> {
  const now = new Date();
  const window = meetingPrepWindow(now);
  const upcoming = await db.select({ id: events.id }).from(events).where(and(
    inArray(events.source, ['google_calendar', 'ics', 'native']),
    eq(events.event_type, 'calendar_event'),
    gte(events.timestamp, window.from),
    lt(events.timestamp, window.to),
  ));

  console.log(`[meeting-prep-check] Found ${upcoming.length} meeting(s) in the next 30 minutes`);
  for (const meeting of upcoming) {
    try {
      await generateMeetingPrep(meeting.id, now);
    } catch (error) {
      console.error(`[meeting-prep-check] Failed for event ${meeting.id}:`, error);
    }
  }
}
