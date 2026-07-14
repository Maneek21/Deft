import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMonthCells, isInCursorMonth, parseLocalISO, toLocalISO } from './task-calendar-helpers';

test('builds complete month rows including leap day', () => {
  const cells = buildMonthCells(new Date(2028, 1, 1));
  assert.equal(cells.length % 7, 0);
  assert.equal(cells.filter((cell) => cell.date).length, 29);
  assert.ok(cells.some((cell) => cell.iso === '2028-02-29'));
});

test('parses date-only values in local time and rejects impossible dates', () => {
  assert.equal(toLocalISO(parseLocalISO('2026-07-14')!), '2026-07-14');
  assert.equal(parseLocalISO('2026-02-30'), null);
});

test('checks cursor month across year boundaries', () => {
  assert.equal(isInCursorMonth('2026-12-31', new Date(2026, 11, 1)), true);
  assert.equal(isInCursorMonth('2027-01-01', new Date(2026, 11, 1)), false);
});
