/**
 * Block 2.9 — heartbeat checklist builder round-trip tests.
 *
 * Pure unit tests on parse/serialize — no DOM, no React. Exercises
 * the markdown ↔ rows round-trip so both the builder UI and the
 * heartbeat worker's parser stay in sync with the expected format.
 *
 * Run: pnpm --filter @deft/web exec tsx --test test/heartbeat-checklist-builder.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHeartbeatMarkdown,
  serializeHeartbeatMarkdown,
  type ChecklistRow,
} from '../src/components/heartbeat-checklist-builder.js';

test('parse canonical markdown', () => {
  const md = [
    '- [ ] every 30min: Check unread mentions',
    '- [ ] every 60min: Summarize new PRs',
    '',
  ].join('\n');
  const rows = parseHeartbeatMarkdown(md);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { interval_min: 30, instruction: 'Check unread mentions' });
  assert.deepEqual(rows[1], { interval_min: 60, instruction: 'Summarize new PRs' });
});

test('parse handles case-insensitive EVERY + extra whitespace', () => {
  const md = '  -  [ ]  EVERY   45min:   Review overdue tasks  ';
  const rows = parseHeartbeatMarkdown(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.interval_min, 45);
  assert.equal(rows[0]!.instruction, 'Review overdue tasks');
});

test('parse ignores malformed lines', () => {
  const md = [
    '# This is not a checklist',
    'Just prose.',
    '- [ ] every 30min: valid one',
    '- [x] every 60min: wrong checkbox state',
    '- [ ] nope no interval',
    '',
  ].join('\n');
  const rows = parseHeartbeatMarkdown(md);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.instruction, 'valid one');
});

test('serialize produces canonical output', () => {
  const rows: ChecklistRow[] = [
    { interval_min: 15, instruction: 'Ping #oncall if any alert is red' },
    { interval_min: 120, instruction: 'Summarize blockers' },
  ];
  const md = serializeHeartbeatMarkdown(rows);
  assert.equal(
    md,
    '- [ ] every 15min: Ping #oncall if any alert is red\n- [ ] every 120min: Summarize blockers',
  );
});

test('serialize drops empty / zero-interval rows', () => {
  const rows: ChecklistRow[] = [
    { interval_min: 0, instruction: 'bad zero' },
    { interval_min: 30, instruction: '' },
    { interval_min: 30, instruction: '   ' },
    { interval_min: 60, instruction: 'valid' },
  ];
  const md = serializeHeartbeatMarkdown(rows);
  assert.equal(md, '- [ ] every 60min: valid');
});

test('round-trip is stable for canonical input', () => {
  const original = [
    '- [ ] every 30min: Check unread mentions',
    '- [ ] every 60min: Summarize new PRs',
  ].join('\n');
  const rows = parseHeartbeatMarkdown(original);
  const reserialized = serializeHeartbeatMarkdown(rows);
  assert.equal(reserialized, original);
});

test('empty input returns empty array / empty string', () => {
  assert.equal(parseHeartbeatMarkdown('').length, 0);
  assert.equal(serializeHeartbeatMarkdown([]), '');
});
