import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assessDatabaseClock } from './selfhost-clock.js';

test('accepts a timestamp anywhere in a slow request interval', () => {
  assert.equal(assessDatabaseClock({ startedAtMs: 100_000, finishedAtMs: 130_000, databaseTimeMs: 110_000 }).ok, true);
});

test('detects database ahead and behind the API host', () => {
  const ahead = assessDatabaseClock({ startedAtMs: 100_000, finishedAtMs: 100_500, databaseTimeMs: 900_000 });
  assert.equal(ahead.ok, false);
  assert.match(ahead.detail, /ahead of/);
  const behind = assessDatabaseClock({ startedAtMs: 900_000, finishedAtMs: 900_500, databaseTimeMs: 100_000 });
  assert.equal(behind.ok, false);
  assert.match(behind.detail, /behind/);
});

test('allows small clock differences but flags skew beyond the tolerance', () => {
  assert.equal(assessDatabaseClock({ startedAtMs: 100_000, finishedAtMs: 100_500, databaseTimeMs: 105_500 }).ok, true);
  assert.equal(assessDatabaseClock({ startedAtMs: 100_000, finishedAtMs: 100_500, databaseTimeMs: 105_501 }).ok, false);
});

test('does not report success for malformed samples or a host clock moving backwards', () => {
  assert.equal(assessDatabaseClock({ startedAtMs: 100, finishedAtMs: 99, databaseTimeMs: 100 }).ok, false);
  assert.equal(assessDatabaseClock({ startedAtMs: 100, finishedAtMs: 101, databaseTimeMs: NaN }).ok, false);
});
