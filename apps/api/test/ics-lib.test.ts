import assert from 'node:assert/strict';
import test from 'node:test';
import { extractICSCalendarName, generateICS, parseICS } from '../src/lib/ics.js';

test('extractICSCalendarName returns a cleaned feed name', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'X-WR-CALNAME:Tomatoes\\, Launch\\; Ops',
    'END:VCALENDAR',
  ].join('\r\n');

  assert.equal(extractICSCalendarName(text), 'Tomatoes, Launch; Ops');
});

test('generateICS round-trips Deft tasks and native event URLs', () => {
  const calendar = generateICS(
    [
      {
        uid: 'task-1@deft',
        summary: '[task] Prepare tomato launch plan',
        description: 'Finalize the launch checklist.',
        start: new Date('2026-06-15T00:00:00Z'),
        all_day: true,
        url: 'http://localhost:3000/tasks?task=MAR-12',
      },
      {
        uid: 'native-event-1@deft',
        summary: 'Route capacity check',
        start: new Date('2026-06-15T14:00:00Z'),
        end: new Date('2026-06-15T14:30:00Z'),
        url: 'http://localhost:3000/calendar',
      },
    ],
    { name: 'Deft - Diego', description: 'Your tasks and synced events from Deft' },
  );

  assert.match(calendar, /X-WR-CALNAME:Deft - Diego/);
  assert.match(calendar, /URL:http:\/\/localhost:3000\/tasks\?task=MAR-12/);
  assert.match(calendar, /UID:native-event-1@deft/);

  const events = parseICS(calendar);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.summary, '[task] Prepare tomato launch plan');
  assert.equal(events[1]?.summary, 'Route capacity check');
});
