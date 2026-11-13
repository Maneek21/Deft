import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from '@tiptap/pm/model';
import { mentionQueryAtCursor, suggestionTextBefore, taskQueryAtCursor, taskSelectionContent } from './mention-suggestions';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    mention: { group: 'inline', inline: true, atom: true },
  },
});

function paragraph(...inline: (string | 'BR' | 'CHIP')[]) {
  const nodes = inline.map((part) => part === 'BR' ? schema.nodes.hardBreak!.create()
    : part === 'CHIP' ? schema.nodes.mention!.create() : schema.text(part));
  return schema.node('doc', null, [schema.node('paragraph', null, nodes)]);
}

function textAtEnd(doc: ReturnType<typeof paragraph>) {
  return suggestionTextBefore(doc, doc.content.size - 1);
}

test('an @ or # query at the cursor opens a suggestion', () => {
  assert.equal(mentionQueryAtCursor(textAtEnd(paragraph('edge @RC')))?.query, 'RC');
  assert.equal(taskQueryAtCursor(textAtEnd(paragraph('edge #key')))?.query, 'key');
});

test('a query never spans a line break', () => {
  assert.equal(mentionQueryAtCursor(textAtEnd(paragraph('edge @RC', 'BR'))), null);
  assert.equal(taskQueryAtCursor(textAtEnd(paragraph('edge #key', 'BR'))), null);
  assert.equal(mentionQueryAtCursor(textAtEnd(paragraph('edge @RC', 'BR', 'next'))), null);
  // A new @ on the next line is its own query.
  assert.equal(mentionQueryAtCursor(textAtEnd(paragraph('edge', 'BR', '@Ow')))?.query, 'Ow');
});

test('a mention chip before the cursor adds no text', () => {
  assert.equal(textAtEnd(paragraph('hi ', 'CHIP', ' @RC')), 'hi  @RC');
});

test('a picked task is inserted as its readable identifier', () => {
  assert.deepEqual(taskSelectionContent({ project_prefix: 'RC', number: 1001 }), [{ type: 'text', text: 'RC-1001 ' }]);
  // Inserted as text, so markup-like prefixes stay literal.
  assert.deepEqual(taskSelectionContent({ project_prefix: '<B>', number: 1 }), [{ type: 'text', text: '<B>-1 ' }]);
});
