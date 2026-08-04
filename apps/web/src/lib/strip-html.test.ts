/**
 * Unit tests for stripHtml utility.
 *
 * Run: pnpm --filter @deft/web exec tsx --test src/lib/strip-html.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, stripHtml } from './strip-html';

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

  await t.test('decodes nested entities exactly once', () => {
    assert.strictEqual(
      stripHtml('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;'),
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    assert.strictEqual(stripHtml('A &amp;amp; B'), 'A &amp; B');
  });

  await t.test('handles quoted tag delimiters and omits executable element bodies', () => {
    assert.strictEqual(
      stripHtml('<p data-note="1 > 0">Hello <strong>team</strong></p><style>.hidden{}</style><p>Next</p>'),
      'Hello team Next',
    );
  });

  await t.test('does not accept longer tag names as omitted-element closers', () => {
    assert.strictEqual(
      stripHtml('<script>ignore</scripture><b>still ignored</b></script><p>Safe</p>'),
      'Safe',
    );
  });

  await t.test('keeps inline formatting inside words and presents Deft mentions', () => {
    assert.strictEqual(stripHtml('hel<strong>lo</strong>'), 'hello');
    assert.strictEqual(stripHtml('Hi <@user-1|Riya>'), 'Hi @Riya');
  });

  await t.test('preserves block boundaries for line-oriented consumers', () => {
    assert.strictEqual(
      htmlToText('<p>First</p><p>Second<br>line</p>', {
        blockSeparator: '\n',
        inlineSeparator: '',
      }),
      'First\nSecond\nline\n',
    );
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
