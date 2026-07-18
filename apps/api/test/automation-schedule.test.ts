import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isStandupDue,
  localClockAt,
  meetingPrepRunKey,
  meetingPrepWindow,
  standupRunKey,
} from '../src/lib/automation-schedule.js';

test('standup due time follows the organization timezone', () => {
  const before = new Date('2026-07-18T03:29:00.000Z'); // 08:59 in Kolkata
  const due = new Date('2026-07-18T03:30:00.000Z'); // 09:00 in Kolkata
  assert.equal(isStandupDue(before, 'Asia/Kolkata').due, false);
  assert.deepEqual(isStandupDue(due, 'Asia/Kolkata'), {
    due: true,
    dateKey: '2026-07-18',
  });
});

test('a delayed worker catches up later in the same local day', () => {
  const noon = new Date('2026-07-18T06:30:00.000Z');
  assert.equal(isStandupDue(noon, 'Asia/Kolkata').due, true);
});

test('invalid timezone is a clean no-op', () => {
  assert.equal(localClockAt(new Date(), 'Mars/Olympus_Mons'), null);
});

test('automation keys are stable and scoped to their intended output', () => {
  assert.equal(
    standupRunKey('org-1', '2026-07-18'),
    'standup:org-1:2026-07-18',
  );
  assert.equal(
    meetingPrepRunKey('event-1', new Date('2026-07-18T10:00:00.000Z')),
    'meeting-prep:event-1:2026-07-18T10:00:00.000Z',
  );
});

test('meeting prep scan has no cadence gap', () => {
  const now = new Date('2026-07-18T10:00:00.000Z');
  const { from, to } = meetingPrepWindow(now);
  assert.equal(from.toISOString(), '2026-07-18T10:00:00.000Z');
  assert.equal(to.toISOString(), '2026-07-18T10:30:00.000Z');
});
