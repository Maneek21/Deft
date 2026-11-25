import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import {
  BLOCK_ID_COMMENT,
  DOCUMENT_FRAGMENT,
  EMPTY_DOCUMENT,
  applyJsonToYDoc,
  blockHash,
  ensureBlockIds,
  getDocumentSchema,
  jsonToText,
  jsonToYDoc,
  topLevelBlocks,
  yDocToJson,
} from '../src/index.js';
import { ALL_NODES, blockId, paragraph, text } from './fixtures.js';

/** A random version-4 UUID, as `crypto.randomUUID()` gives. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Any UUID-shaped id, such as one derived from a malformed id. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the schema has every fixed node and mark name', () => {
  const schema = getDocumentSchema();
  for (const name of [
    'doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
    'blockquote', 'codeBlock', 'horizontalRule', 'hardBreak', 'image', 'table', 'tableRow', 'tableCell',
    'tableHeader', 'callout', 'details', 'detailsSummary', 'detailsContent', 'nativeMention', 'taskView',
    'tableOfContents',
  ]) assert.ok(schema.nodes[name], `node ${name}`);
  for (const name of ['bold', 'italic', 'strike', 'code', 'underline', 'highlight', 'link']) {
    assert.ok(schema.marks[name], `mark ${name}`);
  }
  assert.equal(getDocumentSchema(), schema, 'the schema is cached');
  assert.equal(DOCUMENT_FRAGMENT, 'default');
  assert.deepEqual(EMPTY_DOCUMENT, { type: 'doc', content: [{ type: 'paragraph' }] });
  assert.ok(BLOCK_ID_COMMENT.test(`<!-- block:${blockId(1)} -->`));
  assert.equal(BLOCK_ID_COMMENT.exec('<!-- block:section-intro -->')?.[1], 'section-intro');
  assert.ok(!BLOCK_ID_COMMENT.test('<!-- block:has space -->'));
  assert.ok(!BLOCK_ID_COMMENT.test(`<!-- block:${'a'.repeat(65)} -->`));
});

test('json → Yjs → json is identical for a document using every node and mark', () => {
  assert.deepEqual(yDocToJson(jsonToYDoc(ALL_NODES)), ALL_NODES);
});

test('an empty Yjs document reads as one empty paragraph', () => {
  assert.deepEqual(yDocToJson(new Y.Doc()), { type: 'doc', content: [{ type: 'paragraph', attrs: { id: null } }] });
});

test('applyJsonToYDoc replaces the content in one transaction', () => {
  const doc = jsonToYDoc(ALL_NODES);
  const next: JSONContent = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: blockId(2), level: 1 }, content: [text('Launch plan, revised')] },
      paragraph(blockId(90), [text('A new paragraph.')]),
      paragraph(blockId(33), [text('The end.')]),
    ],
  };
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT);
  const unchanged = fragment.get(fragment.length - 1);
  let updates = 0;
  doc.on('update', () => { updates += 1; });
  applyJsonToYDoc(doc, next);
  assert.equal(updates, 1);
  assert.deepEqual(yDocToJson(doc), next);
  assert.equal(fragment.length, 3);
  assert.equal(fragment.get(2), unchanged, 'an unchanged block keeps its Yjs element, and cursors in it');
});

test('jsonToText separates blocks with a blank line', () => {
  assert.equal(jsonToText({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
      { type: 'paragraph', content: [text('Body')] },
    ],
  }), 'Title\n\nBody');
  assert.equal(jsonToText({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [text('Ask '), { type: 'nativeMention', attrs: { kind: 'task', id: 'task_7' } }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [text('one')] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [text('two')] }] },
      ] },
    ],
  }), 'Ask [[deft:task:task_7]]\n\none\ntwo');
});

test('ensureBlockIds keeps existing ids and fills missing ones', () => {
  const input: JSONContent = {
    type: 'doc',
    content: [
      paragraph(blockId(1), [text('Kept')]),
      { type: 'paragraph', content: [text('Ask '), { type: 'nativeMention', attrs: { kind: 'person', id: 'user_1' } }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('Nested')] }] }] },
    ],
  };
  const before = JSON.stringify(input);
  const out = ensureBlockIds(input);
  assert.equal(JSON.stringify(input), before, 'the input is not changed');
  const [kept, filled, list] = out.content!;
  assert.equal(kept!.attrs!.id, blockId(1));
  assert.match(String(filled!.attrs!.id), UUID);
  assert.equal(filled!.content![1]!.attrs!.id, 'user_1', 'a mention keeps the id of what it names');
  assert.match(String(list!.attrs!.id), UUID);
  assert.match(String(list!.content![0]!.content![0]!.attrs!.id), UUID);
  assert.equal(list!.content![0]!.attrs, undefined, 'a list item is not a block-id type');
  assert.deepEqual(topLevelBlocks(out).map(block => block.index), [0, 1, 2]);
  assert.equal(topLevelBlocks(out)[0]!.id, blockId(1));
});

test('ensureBlockIds keeps id tokens, derives a malformed or repeated id the same way every time, and gives a missing one a UUID', () => {
  const input: JSONContent = {
    type: 'doc',
    content: [
      paragraph('section-intro', [text('Kept')]),
      paragraph('has space', [text('Malformed')]),
      paragraph('section-intro', [text('Repeated')]),
      { type: 'paragraph', content: [text('Missing')] },
      paragraph('', [text('Empty')]),
    ],
  };
  const ids = () => ensureBlockIds(input).content!.map(node => String(node.attrs!.id));
  const first = ids();
  const second = ids();
  assert.equal(first[0], 'section-intro');
  assert.match(first[1]!, UUID_SHAPE);
  assert.equal(second[1], first[1], 'a malformed id maps to the same id on every call');
  assert.match(first[2]!, UUID_SHAPE);
  assert.equal(second[2], first[2], 'a repeated id maps to the same id on every call');
  assert.match(first[3]!, UUID);
  assert.match(first[4]!, UUID);
  assert.notEqual(second[3], first[3], 'only a missing id is random');
  assert.equal(new Set(first).size, 5);
});

test('topLevelBlocks gives a malformed id the same derived id on two calls', () => {
  const input: JSONContent = { type: 'doc', content: [paragraph('has space', [text('Malformed')])] };
  const [once] = topLevelBlocks(input);
  const [twice] = topLevelBlocks(input);
  assert.match(once!.id, UUID_SHAPE);
  assert.equal(twice!.id, once!.id);
});

test('topLevelBlocks lists every top-level block, giving a copy ids where they are missing', () => {
  const input: JSONContent = {
    type: 'doc',
    content: [
      paragraph(blockId(1), [text('Kept')]),
      { type: 'paragraph', content: [text('No id')] },
      { type: 'paragraph' },
      { type: 'heading', attrs: { level: 2 } },
    ],
  };
  const before = JSON.stringify(input);
  const blocks = topLevelBlocks(input);
  assert.equal(JSON.stringify(input), before, 'the input is not changed');
  assert.deepEqual(blocks.map(block => block.index), [0, 1, 2, 3]);
  assert.deepEqual(blocks.map(block => block.node.type), ['paragraph', 'paragraph', 'paragraph', 'heading']);
  assert.equal(blocks[0]!.id, blockId(1));
  for (const block of blocks.slice(1)) {
    assert.match(block.id, UUID);
    assert.equal(block.node.attrs!.id, block.id);
  }
});

test('blockHash ignores the id attribute', () => {
  const one = paragraph(blockId(1), [text('Same words')]);
  const two = paragraph(blockId(2), [text('Same words')]);
  assert.match(blockHash(one), /^[0-9a-f]{64}$/);
  assert.equal(blockHash(one), blockHash(two));
  assert.equal(
    blockHash({ type: 'bulletList', attrs: { id: blockId(3) }, content: [{ type: 'listItem', content: [one] }] }),
    blockHash({ type: 'bulletList', attrs: { id: blockId(4) }, content: [{ type: 'listItem', content: [two] }] }),
  );
  assert.notEqual(blockHash(one), blockHash(paragraph(blockId(1), [text('Other words')])));
  const mention = (id: string) => paragraph(blockId(1), [{ type: 'nativeMention', attrs: { kind: 'person', id } }]);
  assert.notEqual(blockHash(mention('user_1')), blockHash(mention('user_2')), 'a mention id is content, not a block id');
});

test('blockHash is pinned: block id removed, mention id kept, null attribute and empty marks dropped', () => {
  const node: JSONContent = {
    type: 'paragraph',
    attrs: { id: blockId(1), textAlign: null },
    content: [
      { type: 'text', text: 'Ask ', marks: [] },
      { type: 'nativeMention', attrs: { kind: 'person', id: 'user_1' } },
    ],
  };
  // sha256 of {"content":[{"text":"Ask ","type":"text"},{"attrs":{"id":"user_1","kind":"person"},"type":"nativeMention"}],"type":"paragraph"}
  assert.equal(blockHash(node), 'e21004a33f5a39ca9bf036a53aef5b0e34a6de1b4e904cc1345373c960b55d6a');
});
