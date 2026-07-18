import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dateKeyInUserTimezone,
  formatCalendarDateLong,
  formatEventTime,
  setUserTimezone,
  timePartsInUserTimezone,
} from './time';

test('calendar instants use the selected profile timezone consistently', () => {
  setUserTimezone('America/Los_Angeles');
  const instant = '2026-07-18T05:45:00.000Z';

  assert.equal(dateKeyInUserTimezone(instant), '2026-07-17');
  assert.equal(formatEventTime(instant), '10:45 PM');
  assert.deepEqual(timePartsInUserTimezone(instant), { hour: 22, minute: 45 });
  assert.equal(formatCalendarDateLong('2026-07-17'), 'Friday, July 17, 2026');
});

test('date-only calendar labels never roll into an adjacent timezone day', () => {
  setUserTimezone('Asia/Calcutta');
  assert.equal(formatCalendarDateLong('2026-07-18'), 'Saturday, July 18, 2026');
});
