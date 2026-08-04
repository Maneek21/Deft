import test from 'node:test';
import assert from 'node:assert/strict';
import { toPlainText } from '../src/lib/plain-text.js';

test('toPlainText decodes one entity layer without reactivating nested markup', () => {
  assert.equal(
    toPlainText('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
  assert.equal(toPlainText('A &amp;amp; B'), 'A &amp; B');
  assert.equal(toPlainText('A &#x26;lt;b&#x26;gt; B'), 'A &lt;b&gt; B');
});

test('toPlainText structurally extracts text and ignores executable element bodies', () => {
  assert.equal(
    toPlainText('<p data-note="1 > 0">Hello <strong>team</strong></p><script>alert(1)</script><p>Next</p>'),
    'Hello team Next',
  );
});

test('toPlainText requires an exact omitted-element closing tag', () => {
  assert.equal(
    toPlainText('<script>ignore</scripture><b>still ignored</b></script><p>Safe</p>'),
    'Safe',
  );
  assert.equal(
    toPlainText('<style>.ignore{}</stylesheet><b>still ignored</b></style><p>Safe</p>'),
    'Safe',
  );
  assert.equal(
    toPlainText('İ<script>ignore</scripture><b>still ignored</b></script><p>Safe</p>'),
    'İ Safe',
  );
});

test('toPlainText preserves inline word boundaries and canonical mentions', () => {
  assert.equal(
    toPlainText('PRO<strong>J</strong>-42 says hi to <@user-1|Riya> [[file:abc]]'),
    'PROJ-42 says hi to @Riya [[file:abc]]',
  );
  assert.equal(toPlainText('hel<em>lo</em>'), 'hello');
});
