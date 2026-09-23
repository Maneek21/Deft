import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatChatInline, isSafeChatHref, linkifyChatTaskReferences } from './chat-links';

test('local module and task Markdown links remain clickable and undamaged by task chips', () => {
  const html = linkifyChatTaskReferences(formatChatInline('[CRM-3 follow-up](/tasks?task=CRM-3) and [Queue](/modules/demo?workspace=follow-ups)'));
  assert.equal((html.match(/<a /g) ?? []).length, 2);
  assert.ok(html.includes('href="/tasks?task=CRM-3"'));
  assert.ok(html.includes('>CRM-3 follow-up</a>'));
});

test('chat links reject executable, protocol-relative and backslash URLs', () => {
  for (const href of ['javascript:alert(1)', '//evil.test', '/\\evil.test', '/\nevil.test', 'data:text/html,test']) assert.equal(isSafeChatHref(href), false);
  assert.equal(formatChatInline('[bad](javascript:alert) ').includes('<a '), false);
  assert.equal(isSafeChatHref('/modules/demo/items/1'), true);
});

test('formatting cannot inject markup and code does not become a task link', () => {
  const html = linkifyChatTaskReferences(formatChatInline('`CRM-3` **verified** <script>alert(1)</script>'));
  assert.ok(html.includes('<code>CRM-3</code>'));
  assert.ok(html.includes('<strong>verified</strong>'));
  assert.ok(!html.includes('<script>'));
});

test('link resolvers receive the original URL with exactly one escaping layer removed', () => {
  for (const href of [
    '/search?q=&quot;',
    '/search?q=&amp;quot;',
    '/search?q="quoted"&other=<value>',
    '/search?q=&#34;&other=&#x22;',
  ]) {
    let resolved: string | undefined;
    const html = formatChatInline(`[Search](${href})`, (value) => {
      resolved = value;
      return value;
    });
    assert.equal(resolved, href);
    assert.ok(html.includes('<a href='));
    assert.ok(!html.includes('<value>'));
  }
});

test('nested entities remain literal in link attributes and cannot create attributes', () => {
  const html = formatChatInline('[Search](/search?q=&quot;onmouseover=&quot;alert)');
  assert.ok(html.includes('href="/search?q=&amp;quot;onmouseover=&amp;quot;alert"'));
  assert.equal(formatChatInline('[bad](javascript&#58;alert)').includes('<a '), false);
});
