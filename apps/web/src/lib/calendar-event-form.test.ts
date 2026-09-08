import assert from 'node:assert/strict';
import test from 'node:test';
import { eventFormDefaults, eventSaveTarget } from './calendar-event-form';
import { setUserTimezone } from './time';

test('native event edit defaults preserve content, attendees, and profile-local times', () => {
  setUserTimezone('Asia/Calcutta');
  const defaults = eventFormDefaults({
    id: 'event-1',
    title: 'Planning',
    body: 'Keep the agenda',
    event_type: 'calendar_event',
    url: null,
    source: 'native',
    timestamp: '2026-09-09T03:30:00.000Z',
    metadata: {
      start: '2026-09-09T03:30:00.000Z',
      end: '2026-09-09T04:30:00.000Z',
      location: 'Room 3',
      attendees: [{ email: 'sam@example.com', displayName: 'Sam' }],
      status: 'confirmed',
    },
  });

  assert.deepEqual(defaults, {
    title: 'Planning',
    date: '2026-09-09',
    endDate: '2026-09-09',
    startTime: '09:00',
    endTime: '10:00',
    description: 'Keep the agenda',
    location: 'Room 3',
    attendees: [{ id: 'event-attendee:sam@example.com', name: 'Sam', email: 'sam@example.com', avatar_url: null }],
  });
});

test('overnight event edit defaults retain the end calendar date', () => {
  setUserTimezone('Asia/Calcutta');
  const defaults = eventFormDefaults({
    id: 'overnight', title: 'Overnight', body: null, event_type: 'calendar_event', url: null,
    source: 'native', timestamp: '2026-09-09T17:30:00.000Z',
    metadata: { start: '2026-09-09T17:30:00.000Z', end: '2026-09-09T19:30:00.000Z' },
  });
  assert.equal(defaults.date, '2026-09-09');
  assert.equal(defaults.endDate, '2026-09-10');
  assert.equal(defaults.startTime, '23:00');
  assert.equal(defaults.endTime, '01:00');
});

test('editing targets the existing native event while creation uses the collection route', () => {
  assert.deepEqual(eventSaveTarget('event-1'), { method: 'patch', path: '/api/events/event-1' });
  assert.deepEqual(eventSaveTarget(), { method: 'post', path: '/api/events' });
});
