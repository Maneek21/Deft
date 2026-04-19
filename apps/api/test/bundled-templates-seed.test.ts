/**
 * Structure test — the bundled-templates array has exactly the templates
 * the spec calls for, each with a non-empty tasks array.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_TEMPLATES } from '../src/lib/bundled-templates.js';

test('BUNDLED_TEMPLATES ships launch-campaign and re-engage-sequence', () => {
  const slugs = BUNDLED_TEMPLATES.map((t) => t.slug).sort();
  assert.deepEqual(slugs, ['launch-campaign', 're-engage-sequence']);
});

test('every bundled template has a non-empty tasks array', () => {
  for (const tpl of BUNDLED_TEMPLATES) {
    assert.ok(Array.isArray(tpl.tasks), `${tpl.slug} tasks must be array`);
    assert.ok(tpl.tasks.length > 0, `${tpl.slug} tasks must be non-empty`);
    for (const t of tpl.tasks) {
      assert.ok(typeof t.title === 'string' && t.title.length > 0, `${tpl.slug}: task title required`);
    }
  }
});

test('launch-campaign has exactly 7 tasks', () => {
  const tpl = BUNDLED_TEMPLATES.find((t) => t.slug === 'launch-campaign');
  assert.ok(tpl);
  assert.equal(tpl.tasks.length, 7);
});

test('re-engage-sequence has exactly 14 tasks', () => {
  const tpl = BUNDLED_TEMPLATES.find((t) => t.slug === 're-engage-sequence');
  assert.ok(tpl);
  assert.equal(tpl.tasks.length, 14);
});
