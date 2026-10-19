import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { NativeMentionMarkdown } from './native-mention-markdown';
import { ThreadMessageContent } from './thread-panel';

test('real shared renderer preserves GFM tables, strong and line breaks outside code', () => {
  const html = renderToStaticMarkup(<NativeMentionMarkdown content={'| Owner | Role |\n| --- | --- |\n| **Noah** | Review<br>Ready |\n\n`<br>`\n\n```html\n<br>\n```'} />);
  assert.match(html, /<table>/); assert.match(html, /<strong>Noah<\/strong>/);
  assert.match(html, /Review<br\s*\/>\s*Ready/);
  assert.match(html, /<code>&lt;br&gt;<\/code>/);
  assert.match(html, /language-html[^>]*>&lt;br&gt;/);
});
test('actual thread consumer renders a table without weakening citation links', () => {
  const html = renderToStaticMarkup(<ThreadMessageContent content={'| Owner |\n| --- |\n| **Noah** |\n\n[Claim](/tasks?task=FAKE-1)'} metadata={{ is_agent_reply: true, citations: [] }} />);
  assert.match(html, /<table>/); assert.doesNotMatch(html, /href="\/tasks/);
});
test('shared renderer does not execute HTML or unsafe links', () => {
  const html = renderToStaticMarkup(<NativeMentionMarkdown content={'<script>alert(1)</script>\n\n[x](javascript:alert)\n\n<img src=x onerror=alert(1)>'} />);
  assert.doesNotMatch(html, /<script|<img|javascript:|onerror=/);
});

test('legacy chat mentions, task links and broadcasts stay readable while code stays literal', () => {
  const html = renderToStaticMarkup(<NativeMentionMarkdown chat linkifyTasks content={'<@person|Noah> @here CRM-7 `CRM-8 @all <br>`'} />);
  assert.match(html, />@Noah<\/span>/); assert.match(html, />@here<\/span>/);
  assert.match(html, /href="\/tasks\?task=CRM-7"/);
  assert.doesNotMatch(html, /href="[^"]*CRM-8/);
  assert.match(html, /<code>CRM-8 @all &lt;br&gt;<\/code>/);
});

test('native reference tokens keep the same atom wrapper as the HTML renderer', () => {
  const id = '3c508e88-4431-4b7c-8e41-22ab1f702275';
  const html = renderToStaticMarkup(<NativeMentionMarkdown chat content={'Ask @[[deft:person:' + id + ']] to review'} />);
  assert.match(html, new RegExp('<span data-deft-ref-kind="person" data-deft-ref-id="' + id + '">'));
});

test('ordinary chat soft newlines remain visible without altering code', () => {
  const html = renderToStaticMarkup(<NativeMentionMarkdown chat content={'First line\nSecond line\n\n```text\nFirst\nSecond\n```'} />);
  assert.match(html, /First line<br\/?>\s*Second line/);
  assert.match(html, /<code class="language-text">First\nSecond\n<\/code>/);
});
test('wiki fragments remain links and external chat links retain safe new-tab behavior', () => {
  const wiki = renderToStaticMarkup(<NativeMentionMarkdown content={'[Section](#section)'} />);
  assert.match(wiki, /href="#section"/);
  const chat = renderToStaticMarkup(<NativeMentionMarkdown chat content={'[Reference](https:\/\/example.test/page) [Bad](//example.test)'} />);
  assert.match(chat, /href="https:\/\/example.test\/page" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(chat, /href="\/\/example.test"/);
});
