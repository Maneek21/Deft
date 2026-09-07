import type { CalEvent } from './calendar';
import { wallTimePartsInUserTimezone } from './time';

export type CalendarFormMember = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

export function eventSaveTarget(eventId?: string): { method: 'post' | 'patch'; path: string } {
  return eventId
    ? { method: 'patch', path: `/api/events/${eventId}` }
    : { method: 'post', path: '/api/events' };
}

export function eventFormDefaults(event: CalEvent) {
  const metadata = event.metadata ?? {};
  const startValue = metadata.start || event.timestamp;
  const start = wallTimePartsInUserTimezone(startValue);
  const end = wallTimePartsInUserTimezone(metadata.end || new Date(new Date(startValue).getTime() + 3_600_000));
  const attendees: CalendarFormMember[] = (metadata.attendees ?? [])
    .filter((attendee: { email?: unknown }) => typeof attendee.email === 'string' && attendee.email)
    .map((attendee: { email: string; displayName?: string; name?: string }) => ({
      id: `event-attendee:${attendee.email}`,
      name: attendee.displayName || attendee.name || attendee.email.split('@')[0],
      email: attendee.email,
      avatar_url: null,
    }));

  return {
    title: event.title,
    date: start.date,
    endDate: end.date,
    startTime: start.time,
    endTime: end.time,
    description: event.body ?? '',
    location: typeof metadata.location === 'string' ? metadata.location : '',
    attendees,
  };
}
