/**
 * task-dates helper unit tests — timezone-aware "due today" / "overdue" /
 * "due within N days" predicates and day-boundary computation.
 *
 * Run: pnpm --filter @deft/api test -- task-dates
 *
 * These tests exercise pure JS only — no DB, no fixtures — so they run fast
 * and prove the tz math is correct across:
 *   1. A canonical case: task due at 23:00 UTC is "due today" for
 *      America/Los_Angeles (16:00 PDT local)
 *   2. Overdue detection across a tz boundary
 *   3. "Within N days" windows
 *   4. UTC day boundaries (sanity — should match simple UTC date math)
 *   5. Bad tz string falls back to UTC without throwing
 *   6. DST crossing — a 'now' just after a spring-forward still yields a
 *      correct 24-hour-ish boundary window
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDueToday,
  isOverdue,
  isDueWithinDays,
  getDayBoundaries,
} from '../src/lib/task-dates.ts';

test('isDueToday: task due at 23:00 UTC is due today in America/Los_Angeles (16:00 PDT)', () => {
  // 2025-07-15 is a PDT date (UTC-7). 23:00 UTC that day = 16:00 PDT same day.
  const now = new Date('2025-07-15T18:00:00.000Z'); // 11:00 PDT
  const due = new Date('2025-07-15T23:00:00.000Z'); // 16:00 PDT same day
  assert.equal(isDueToday(due, 'America/Los_Angeles', now), true);
});

test('isDueToday: task at 23:00 UTC on a day where LA is UTC-7 crossing forward (ahead-of-UTC tz)', () => {
  // Asia/Kolkata is UTC+5:30, no DST. 23:00 UTC on Jul 15 = 04:30 IST on Jul 16.
  const now = new Date('2025-07-16T10:00:00.000Z'); // 15:30 IST Jul 16
  const due = new Date('2025-07-15T23:00:00.000Z'); // 04:30 IST Jul 16
  assert.equal(isDueToday(due, 'Asia/Kolkata', now), true);
  // Same instant is *not* today for a user in UTC (where it was Jul 15).
  assert.equal(isDueToday(due, 'UTC', now), false);
});

test('isOverdue: task due at start of yesterday is overdue; due later today is not', () => {
  const now = new Date('2025-07-15T18:00:00.000Z'); // 11:00 PDT
  const yesterday = new Date('2025-07-14T20:00:00.000Z'); // 13:00 PDT Jul 14
  const laterToday = new Date('2025-07-15T23:00:00.000Z'); // 16:00 PDT Jul 15
  assert.equal(isOverdue(yesterday, 'America/Los_Angeles', now), true);
  assert.equal(isOverdue(laterToday, 'America/Los_Angeles', now), false);
});

test('isDueWithinDays: n=1 catches today and tomorrow but not day-after', () => {
  const now = new Date('2025-07-15T18:00:00.000Z'); // 11:00 PDT Jul 15
  const today = new Date('2025-07-15T23:00:00.000Z'); // 16:00 PDT Jul 15
  const tomorrow = new Date('2025-07-16T18:00:00.000Z'); // 11:00 PDT Jul 16
  const dayAfter = new Date('2025-07-17T18:00:00.000Z'); // 11:00 PDT Jul 17
  assert.equal(isDueWithinDays(today, 'America/Los_Angeles', 1, now), true);
  assert.equal(isDueWithinDays(tomorrow, 'America/Los_Angeles', 1, now), true);
  assert.equal(isDueWithinDays(dayAfter, 'America/Los_Angeles', 1, now), false);
});

test('null/undefined due dates are never due today, overdue, or within N days', () => {
  const now = new Date('2025-07-15T18:00:00.000Z');
  assert.equal(isDueToday(null, 'UTC', now), false);
  assert.equal(isOverdue(null, 'UTC', now), false);
  assert.equal(isDueWithinDays(null, 'UTC', 7, now), false);
  assert.equal(isDueToday(undefined, 'UTC', now), false);
});

test('getDayBoundaries: UTC day is exactly midnight-to-midnight', () => {
  const now = new Date('2025-07-15T18:00:00.000Z');
  const { start, end } = getDayBoundaries('UTC', 0, now);
  assert.equal(start.toISOString(), '2025-07-15T00:00:00.000Z');
  assert.equal(end.toISOString(), '2025-07-16T00:00:00.000Z');
});

test('getDayBoundaries: America/Los_Angeles day boundaries reflect PDT offset', () => {
  const now = new Date('2025-07-15T18:00:00.000Z'); // 11:00 PDT (UTC-7)
  const { start, end } = getDayBoundaries('America/Los_Angeles', 0, now);
  // Midnight PDT Jul 15 = 07:00 UTC; midnight PDT Jul 16 = 07:00 UTC Jul 16.
  assert.equal(start.toISOString(), '2025-07-15T07:00:00.000Z');
  assert.equal(end.toISOString(), '2025-07-16T07:00:00.000Z');
});

test('bad timezone string falls back to UTC without throwing', () => {
  const now = new Date('2025-07-15T18:00:00.000Z');
  const { start, end } = getDayBoundaries('Not/A_Real_Zone', 0, now);
  assert.equal(start.toISOString(), '2025-07-15T00:00:00.000Z');
  assert.equal(end.toISOString(), '2025-07-16T00:00:00.000Z');
  // And predicates still work — they just treat everything as UTC.
  assert.equal(isDueToday(new Date('2025-07-15T12:00:00.000Z'), 'Not/A_Real_Zone', now), true);
});

test('DST spring-forward: LA 2025-03-09 day window still spans ~midnight-to-midnight local', () => {
  // US DST started 2025-03-09. Midnight PST Mar 9 = 08:00 UTC; midnight PDT
  // Mar 10 = 07:00 UTC. The day is only 23 hours long locally.
  const now = new Date('2025-03-09T15:00:00.000Z'); // 08:00 PDT Mar 9
  const { start, end } = getDayBoundaries('America/Los_Angeles', 0, now);
  assert.equal(start.toISOString(), '2025-03-09T08:00:00.000Z');
  assert.equal(end.toISOString(), '2025-03-10T07:00:00.000Z');
  // A task due 20:00 UTC that day (13:00 PDT) is due today.
  assert.equal(isDueToday(new Date('2025-03-09T20:00:00.000Z'), 'America/Los_Angeles', now), true);
});
