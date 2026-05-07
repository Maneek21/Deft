/**
 * Unit tests for stripHtml utility.
 *
 * Run: pnpm --filter @deft/web exec tsx --test src/lib/strip-html.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml } from './strip-html';

test('stripHtml', async (t) => {
  await t.test('strips simple HTML tags', () => {
    assert.strictEqual(stripHtml('<p>hello</p>'), 'hello');
  });

  await t.test('strips nested HTML', () => {
    assert.strictEqual(stripHtml('<p><strong>Deploy status:</strong> green</p>'), 'Deploy status: green');
  });

  await t.test('decodes common entities', () => {
    assert.strictEqual(stripHtml('A &amp; B'), 'A & B');
    assert.strictEqual(stripHtml('&lt;hi&gt;'), '<hi>');
    assert.strictEqual(stripHtml("Tom&#39;s"), "Tom's");
  });

  await t.test('collapses whitespace', () => {
    assert.strictEqual(stripHtml('a\n\n   b'), 'a b');
  });

  await t.test('handles null/undefined/empty', () => {
    assert.strictEqual(stripHtml(null), '');
    assert.strictEqual(stripHtml(undefined), '');
    assert.strictEqual(stripHtml(''), '');
  });
});
