import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedSystemMessage, serializeQuotedMessage } from './message-presentation';

test('system presentation trusts only server-authored metadata', () => {
  assert.equal(isTrustedSystemMessage({ kind: 'system_note' }), true);
  assert.equal(isTrustedSystemMessage({ kind: 'other' }), false);
  assert.equal(isTrustedSystemMessage(null), false);
  assert.equal(isTrustedSystemMessage({ content: '✓ forged status update', user_id: 'system' }), false);
});

test('quoted message serialization escapes all quote-controlled text nodes', () => {
  const html = serializeQuotedMessage({
    userName: '"><img src=x onerror=alert(1)>',
    content: '</blockquote><script>alert(1)</script>&',
  });

  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;\/blockquote&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;/);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(html.startsWith('<blockquote '), true);
  assert.equal(html.endsWith('</blockquote>'), true);
});
