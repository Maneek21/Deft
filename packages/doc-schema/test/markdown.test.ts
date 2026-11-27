import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JSONContent } from '@tiptap/core';
import {
  BLOCK_ID_COMMENT,
  EMPTY_DOCUMENT,
  getDocumentSchema,
  jsonToMarkdown,
  markdownToJson,
  topLevelBlocks,
} from '../src/index.js';
import { ALL_NODES, blockId, paragraph, text } from './fixtures.js';

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const commentIds = (markdown: string) => markdown.split('\n').flatMap(line => BLOCK_ID_COMMENT.exec(line)?.[1] ?? []);

/** ProseMirror's own check: throws when the document does not fit the schema. */
function assertValid(json: JSONContent): void {
  assert.doesNotThrow(() => getDocumentSchema().nodeFromJSON(json).check());
}

test('a Markdown round trip with blockIds keeps every top-level id', () => {
  const markdown = jsonToMarkdown(ALL_NODES, { blockIds: true });
  const expected = topLevelBlocks(ALL_NODES).map(block => ({ id: block.id, type: block.node.type }));
  assert.deepEqual(commentIds(markdown), expected.map(block => block.id), 'one comment line per top-level block');
  const back = markdownToJson(markdown);
  assertValid(back);
  assert.deepEqual(topLevelBlocks(back).map(block => ({ id: block.id, type: block.node.type })), expected);
  assert.equal(back.content!.length, ALL_NODES.content!.length);
});

test('with blockIds every top-level block gets a comment, with or without an id, empty or not', () => {
  const source = doc(
    paragraph(blockId(1), [text('Kept')]),
    { type: 'paragraph', content: [text('No id yet')] },
    { type: 'paragraph' },
    { type: 'heading', attrs: { level: 2 } },
  );
  const markdown = jsonToMarkdown(source, { blockIds: true });
  const ids = commentIds(markdown);
  assert.equal(ids.length, 4);
  assert.equal(ids[0], blockId(1));
  assert.equal(new Set(ids).size, 4);
  const back = markdownToJson(markdown);
  assertValid(back);
  assert.deepEqual(topLevelBlocks(back).map(block => ({ id: block.id, type: block.node.type })), [
    { id: ids[0], type: 'paragraph' },
    { id: ids[1], type: 'paragraph' },
    { id: ids[2], type: 'paragraph' },
    { id: ids[3], type: 'heading' },
  ]);
  assert.equal(back.content![2]!.content, undefined, 'the empty paragraph stays empty');
  assert.equal(back.content![3]!.attrs!.level, 2);

  assert.match(jsonToMarkdown(EMPTY_DOCUMENT, { blockIds: true }), /^<!-- block:[0-9a-f-]{36} -->\n&nbsp;$/);
});

test('a stored id such as section-intro survives topLevelBlocks and Markdown unchanged', () => {
  const source = doc(
    paragraph('section-intro', [text('Intro')]),
    { type: 'heading', attrs: { id: 'has space', level: 2 }, content: [text('Next')] },
  );
  assert.equal(topLevelBlocks(source)[0]!.id, 'section-intro');
  assert.equal(topLevelBlocks(source)[0]!.id, 'section-intro', 'the same on a second call');
  const derived = topLevelBlocks(source)[1]!.id;
  assert.equal(topLevelBlocks(source)[1]!.id, derived, 'a malformed id is derived the same way each call');
  const markdown = jsonToMarkdown(source, { blockIds: true });
  assert.match(markdown, /^<!-- block:section-intro -->\nIntro$/m);
  assert.deepEqual(commentIds(markdown), ['section-intro', derived]);
  const back = markdownToJson(markdown);
  assertValid(back);
  assert.deepEqual(topLevelBlocks(back).map(block => block.id), ['section-intro', derived]);
});

test('without blockIds there are no block comments', () => {
  const markdown = jsonToMarkdown(doc(paragraph(blockId(1), [text('Hello')])));
  assert.equal(markdown, 'Hello');
});

test('headings deeper than level 3 become level 3', () => {
  const level = (markdown: string) => markdownToJson(markdown).content![0]!.attrs!.level;
  assert.equal(level('## Two'), 2);
  assert.equal(level('### Three'), 3);
  assert.equal(level('#### Four'), 3);
  assert.equal(level('###### Six'), 3);
  assertValid(markdownToJson('#### Four\n\n- ##### Five in a list'));
});

test('a list item that starts with an image keeps the paragraph the schema requires', () => {
  const image = { type: 'image', attrs: { id: null, src: null, alt: 'chart', title: null, fileId: 'f' } };
  const back = markdownToJson('- ![chart](deft-file:f)');
  assertValid(back);
  assert.deepEqual(back.content![0]!.content![0], { type: 'listItem', content: [paragraph(null), image] });
  for (const markdown of ['- ![chart](deft-file:f) after', '- [ ] ![chart](deft-file:f)', '1. See ![chart](deft-file:f) here']) {
    assertValid(markdownToJson(markdown));
  }
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

test('backslashes in an image alt, URL or title survive Markdown unchanged', () => {
  const images = [
    { alt: 'C:\\charts\\q3 [draft]', src: 'https://example.com/a\\b(1).png', title: 'say "hi" \\o/' },
    { alt: 'ends with \\', src: 'https://example.com/path with space\\x.png', title: 'trailing \\' },
    { alt: '\\[not a link\\]', src: 'https://example.com/\\)', title: null },
  ];
  for (const attrs of images) {
    const source = doc({ type: 'image', attrs: { id: blockId(1), fileId: null, ...attrs } });
    const back = markdownToJson(jsonToMarkdown(source, { blockIds: true }));
    assertValid(back);
    assert.deepEqual(back, source, JSON.stringify(attrs));
  }
});

test('an image round-trips as deft-file:<id>', () => {
  const source = doc({ type: 'image', attrs: { id: blockId(1), src: null, alt: 'Roadmap', title: null, fileId: 'file_123' } });
  const markdown = jsonToMarkdown(source, { blockIds: true });
  assert.equal(markdown, `<!-- block:${blockId(1)} -->\n![Roadmap](deft-file:file_123)`);
  assert.deepEqual(markdownToJson(markdown), source);
});
