/**
 * Task 4.11 — unit test for resolveTemplateDueDate.
 *
 * The apply-template endpoint parses each template task's `due_date` field
 * into a concrete Date. Supported formats:
 *   - "+Nd"        → apply-date + N days
 *   - ISO date     → literal
 *   - empty/null   → null
 *
 * Full DB-integration coverage lives elsewhere (this repo's integration
 * tests seed a real PG). This file pins the parsing edge-cases that drive
 * every template's cadence semantics, so a regression shows up in
 * `node --test` without needing a DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemplateDueDate } from '../src/routes/task-templates.js';

test('resolveTemplateDueDate: undefined / null / empty string → null', () => {
  const apply = new Date('2026-04-16T12:00:00Z');
  assert.equal(resolveTemplateDueDate(undefined, apply), null);
  assert.equal(resolveTemplateDueDate(null, apply), null);
  assert.equal(resolveTemplateDueDate('', apply), null);
  assert.equal(resolveTemplateDueDate('   ', apply), null);
});

test('resolveTemplateDueDate: "+Nd" → apply-date + N days', () => {
  const apply = new Date('2026-04-16T00:00:00Z');
  const plus7 = resolveTemplateDueDate('+7d', apply);
  assert.ok(plus7 instanceof Date);
  assert.equal(plus7!.getUTCDate(), 23);
  assert.equal(plus7!.getUTCMonth(), 3); // April (0-indexed)

  const plus14 = resolveTemplateDueDate('+14d', apply);
  assert.equal(plus14!.getUTCDate(), 30);

  // Month wrap-around.
  const plus30 = resolveTemplateDueDate('+30d', apply);
  assert.equal(plus30!.getUTCMonth(), 4); // May
  assert.equal(plus30!.getUTCDate(), 16);
});

test('resolveTemplateDueDate: zero days → apply-date', () => {
  const apply = new Date('2026-04-16T00:00:00Z');
  const zero = resolveTemplateDueDate('+0d', apply);
  assert.ok(zero instanceof Date);
  assert.equal(zero!.getUTCDate(), 16);
});

test('resolveTemplateDueDate: ISO date string is parsed literally', () => {
  const apply = new Date('2026-04-16T00:00:00Z');
  const iso = resolveTemplateDueDate('2026-12-25', apply);
  assert.ok(iso instanceof Date);
  assert.equal(iso!.getUTCMonth(), 11); // December
  assert.equal(iso!.getUTCDate(), 25);
});

test('resolveTemplateDueDate: garbage input → null', () => {
  const apply = new Date('2026-04-16T00:00:00Z');
  assert.equal(resolveTemplateDueDate('not a date', apply), null);
  assert.equal(resolveTemplateDueDate('+abcd', apply), null);
});

test('resolveTemplateDueDate: case-insensitive "+Nd"', () => {
  const apply = new Date('2026-04-16T00:00:00Z');
  const plus3 = resolveTemplateDueDate('+3D', apply);
  assert.ok(plus3 instanceof Date);
  assert.equal(plus3!.getUTCDate(), 19);
});
