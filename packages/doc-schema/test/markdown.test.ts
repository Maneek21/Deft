import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JSONContent } from '@tiptap/core';
import { BLOCK_ID_COMMENT, jsonToMarkdown, markdownToJson, topLevelBlocks } from '../src/index.js';
import { ALL_NODES, blockId, paragraph, text } from './fixtures.js';

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

test('a Markdown round trip with blockIds keeps every top-level id', () => {
  const markdown = jsonToMarkdown(ALL_NODES, { blockIds: true });
  const commentIds = markdown.split('\n').flatMap(line => BLOCK_ID_COMMENT.exec(line)?.[1] ?? []);
  const expected = topLevelBlocks(ALL_NODES).map(block => ({ id: block.id, type: block.node.type }));
  assert.deepEqual(commentIds, expected.map(block => block.id), 'one comment line per top-level block');
  const back = markdownToJson(markdown);
  assert.deepEqual(topLevelBlocks(back).map(block => ({ id: block.id, type: block.node.type })), expected);
  assert.equal(back.content!.length, ALL_NODES.content!.length);
});

test('without blockIds there are no block comments', () => {
  const markdown = jsonToMarkdown(doc(paragraph(blockId(1), [text('Hello')])));
  assert.equal(markdown, 'Hello');
});

test('a callout and a details block survive Markdown both ways', () => {
  const source = doc(
    {
      type: 'callout',
      attrs: { id: blockId(1), emoji: '⚠️' },
      content: [paragraph(blockId(2), [text('Mind the '), text('freeze', [{ type: 'bold' }])])],
    },
    {
      type: 'details',
      attrs: { id: blockId(3), open: true },
      content: [
        { type: 'detailsSummary', content: [text('More context')] },
        { type: 'detailsContent', content: [paragraph(blockId(4), [text('Hidden until opened.')])] },
      ],
    },
  );
  const markdown = jsonToMarkdown(source);
  assert.match(markdown, /^<div data-callout="" data-emoji="⚠️"[^>]*>.*Mind the.*<\/div>$/m);
  assert.match(markdown, /^<details[^>]*>.*More context.*<\/details>$/m);
  assert.deepEqual(markdownToJson(markdown), source);

  const written = markdownToJson('<div data-callout data-emoji="💡"><p>From an agent</p></div>');
  assert.deepEqual(written.content, [{
    type: 'callout',
    attrs: { id: null, emoji: '💡' },
    content: [paragraph(null, [text('From an agent')])],
  }]);
});

test('a native mention token survives Markdown both ways', () => {
  const source = doc(paragraph(blockId(1), [
    text('Ask '),
    { type: 'nativeMention', attrs: { kind: 'person', id: 'user_42' } },
    text(' today'),
  ]));
  const markdown = jsonToMarkdown(source);
  assert.equal(markdown, 'Ask [[deft:person:user_42]] today');
  assert.deepEqual(markdownToJson(markdown).content![0]!.content, source.content![0]!.content);
  assert.deepEqual(markdownToJson('See [[deft:task:task_9]].').content![0]!.content, [
    text('See '),
    { type: 'nativeMention', attrs: { kind: 'task', id: 'task_9' } },
    text('.'),
  ]);
  assert.deepEqual(markdownToJson('Not a ref: [[deft:planet:mars]]').content![0]!.content, [
    text('Not a ref: [[deft:planet:mars]]'),
  ]);
});

test('an image inside a sentence becomes its own block', () => {
  const back = markdownToJson(`<!-- block:${blockId(1)} -->\nSee ![Chart](deft-file:file_9) for details`);
  assert.deepEqual(back.content, [
    paragraph(blockId(1), [text('See ')]),
    { type: 'image', attrs: { id: null, src: null, alt: 'Chart', title: null, fileId: 'file_9' } },
    paragraph(null, [text(' for details')]),
  ]);
});

test('an image round-trips as deft-file:<id>', () => {
  const source = doc({ type: 'image', attrs: { id: blockId(1), src: null, alt: 'Roadmap', title: null, fileId: 'file_123' } });
  const markdown = jsonToMarkdown(source, { blockIds: true });
  assert.equal(markdown, `<!-- block:${blockId(1)} -->\n![Roadmap](deft-file:file_123)`);
  assert.deepEqual(markdownToJson(markdown), source);
});
