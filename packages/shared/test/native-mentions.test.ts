import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractNativeMentions, nativeMentionRef, nativeMentionToken, nativeMentionTokensToHtml,
  NativeMentionRefSchema, NativeMentionSourceSchema,
} from '../src/native-mentions.js';

test('source scope is limited to chat, tasks and knowledge while notes and calendar are excluded', () => {
  for (const kind of ['message', 'task', 'task_comment', 'wiki_page']) {
    assert(NativeMentionSourceSchema.safeParse({ kind, id: 'source-1' }).success);
  }
  for (const kind of ['note', 'calendar', 'calendar_event', 'canvas']) {
    assert.equal(NativeMentionSourceSchema.safeParse({ kind, id: 'source-1' }).success, false);
  }
});

test('HTML and Markdown share lossless native identities and deduplicate occurrences', () => {
  const task = nativeMentionRef('task', 'task-42');
  const wiki = nativeMentionRef('wiki_page', 'wiki-1');
  const person = nativeMentionRef('person', 'user-1');
  const body = `<p><span data-deft-ref-id="user-1" data-deft-ref-kind="person">@Stale name</span> ${nativeMentionToken(task)} ${nativeMentionToken(wiki)} ${nativeMentionToken(task)}</p>`;
  assert.deepEqual(extractNativeMentions(body), [task, wiki, person]);
  assert.deepEqual(extractNativeMentions(nativeMentionTokensToHtml(nativeMentionToken(wiki))), [wiki]);
  assert.equal(task.schema_version, 'deft.resource_ref.v1');
  assert.equal(person.schema_version, 'deft.resource_ref.v2');
});

test('quoted/code content and forged attributes do not become mention authority', () => {
  assert.deepEqual(extractNativeMentions([
    '<code>[[deft:person:quoted]]</code>',
    '<blockquote>[[deft:person:quoted2]]</blockquote>',
    '```\n[[deft:person:fenced]]\n```',
    '> [[deft:person:quote]]',
    '<span data-deft-ref-kind="person" data-deft-ref-id="a" data-deft-ref-id="b">',
    '[[deft:task:bad/id]]',
  ].join('\n')), []);
  assert.equal(NativeMentionRefSchema.safeParse({
    ...nativeMentionRef('task', 'one'), org_id: 'other',
  }).success, false);
});

test('bounded reference extraction rejects oversized recipient sets', () => {
  assert.throws(() => extractNativeMentions(
    Array.from({ length: 101 }, (_, i) => nativeMentionToken(nativeMentionRef('person', `p${i}`))).join(' '),
  ), /Too many native references/);
});
test('incomplete and nested literals, comments and attribute values cannot notify', () => {
  for (const body of [
    'Inline `[[deft:person:a]]`',
    'Inline `[[deft:person:a]]',
    '~~~js\n[[deft:person:a]]',
    '<blockquote><blockquote>[[deft:person:a]]</blockquote>[[deft:person:b]]</blockquote>',
    '<pre>[[deft:person:a]]',
    '<!-- [[deft:person:a]] -->',
    '<a title="[[deft:person:a]]">Hello</a>',
    '    [[deft:person:a]]',
    '\\[[deft:person:a]]',
    '[label [[deft:person:a]]](https://example.test)',
    '`across\n[[deft:person:a]]`',
  ]) assert.deepEqual(extractNativeMentions(body), []);
});

test('HTML rendering preserves literal reference examples and attribute values', () => {
  for (const body of [
    '<code>[[deft:person:a]]</code>', '<blockquote>[[deft:person:a]]</blockquote>',
    '```\n[[deft:person:a]]\n```', '> [[deft:person:a]]',
    '<a title="[[deft:person:a]]">Example</a>',
  ]) assert.equal(nativeMentionTokensToHtml(body), body);
});
