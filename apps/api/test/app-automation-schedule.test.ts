import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appAutomationLocalDate,
  classifyAppAutomationOccurrence,
  listAppAutomationLogicalDates,
  resolveAppAutomationOccurrence,
} from '../src/lib/app-automation-schedule.js';

test('daily wall-clock resolution is exact in a fixed-offset zone', () => {
  const occurrence = resolveAppAutomationOccurrence({
    logical_local_date: '2026-09-01',
    local_time: '09:30',
    timezone: 'Asia/Calcutta',
  });
  assert.equal(occurrence.resolution.kind, 'resolved');
  assert.equal(occurrence.resolution.kind === 'resolved'
    ? occurrence.resolution.resolved_at_utc.toISOString()
    : null, '2026-09-01T04:00:00.000Z');
  assert.equal(appAutomationLocalDate(new Date('2026-09-01T18:45:00.000Z'), 'Asia/Calcutta'), '2026-09-02');
});

test('DST fold resolves once at the earlier matching UTC instant', () => {
  const occurrence = resolveAppAutomationOccurrence({
    logical_local_date: '2026-11-01',
    local_time: '01:30',
    timezone: 'America/New_York',
  });
  assert.equal(occurrence.resolution.kind, 'resolved');
  assert.equal(occurrence.resolution.kind === 'resolved'
    ? occurrence.resolution.resolved_at_utc.toISOString()
    : null, '2026-11-01T05:30:00.000Z');
});

test('DST gap becomes one explicit skipped logical occurrence', () => {
  const occurrence = resolveAppAutomationOccurrence({
    logical_local_date: '2026-03-08',
    local_time: '02:30',
    timezone: 'America/New_York',
  });
  assert.equal(occurrence.resolution.kind, 'dst_gap');
  assert.deepEqual(classifyAppAutomationOccurrence({
    occurrence,
    now: new Date('2026-03-08T07:01:00.000Z'),
    eligible_after: new Date('2026-03-08T05:00:00.000Z'),
    catch_up_window_minutes: 15,
  }), { kind: 'skipped', reason: 'dst_gap', occurrence });
});

test('catch-up is bounded and resume excludes the current logical occurrence', () => {
  const occurrence = resolveAppAutomationOccurrence({
    logical_local_date: '2026-09-01',
    local_time: '09:30',
    timezone: 'Asia/Calcutta',
  });
  assert.equal(classifyAppAutomationOccurrence({
    occurrence,
    now: new Date('2026-09-01T04:14:59.000Z'),
    eligible_after: new Date('2026-08-31T00:00:00.000Z'),
    catch_up_window_minutes: 15,
  }).kind, 'pending');
  assert.deepEqual(classifyAppAutomationOccurrence({
    occurrence,
    now: new Date('2026-09-01T04:15:01.000Z'),
    eligible_after: new Date('2026-08-31T00:00:00.000Z'),
    catch_up_window_minutes: 15,
  }).kind, 'skipped');
  assert.equal(classifyAppAutomationOccurrence({
    occurrence,
    now: new Date('2026-09-01T04:01:00.000Z'),
    eligible_after: new Date('2026-09-01T04:00:00.000Z'),
    catch_up_window_minutes: 15,
  }).kind, 'not_eligible');
  assert.equal(classifyAppAutomationOccurrence({
    occurrence,
    now: new Date('2026-09-01T04:01:00.000Z'),
    eligible_after: new Date('2026-08-31T00:00:00.000Z'),
    eligible_before: new Date('2026-09-01T04:00:00.000Z'),
    catch_up_window_minutes: 15,
  }).kind, 'not_eligible');
  assert.equal(classifyAppAutomationOccurrence({
    occurrence,
    now: new Date('2026-09-01T04:00:10.000Z'),
    eligible_after: new Date('2026-08-31T00:00:00.000Z'),
    eligible_before: new Date('2026-09-01T04:00:30.000Z'),
    catch_up_window_minutes: 15,
  }).kind, 'pending');
});

test('scanner date reconciliation is local, inclusive, and bounded', () => {
  assert.deepEqual(listAppAutomationLogicalDates({
    eligible_after: new Date('2026-03-07T15:00:00.000Z'),
    now: new Date('2026-03-09T15:00:00.000Z'),
    timezone: 'America/New_York',
  }), ['2026-03-07', '2026-03-08', '2026-03-09']);

  assert.equal(listAppAutomationLogicalDates({
    eligible_after: new Date('2026-01-01T00:00:00.000Z'),
    now: new Date('2026-02-15T00:00:00.000Z'),
    timezone: 'UTC',
  }).length, 31);
});
