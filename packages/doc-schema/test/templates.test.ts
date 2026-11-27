import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JSONContent } from '@tiptap/core';
import { BUILT_IN_TEMPLATES, getDocumentSchema, templateJson, topLevelBlocks, type BuiltInTemplateKey } from '../src/index.js';

const SECTIONS: Record<BuiltInTemplateKey, string[]> = {
  meeting_notes: ['Attendees', 'Agenda', 'Notes', 'Decisions', 'Action items'],
  spec: ['Summary', 'Problem', 'Goals', 'Non-goals', 'Design', 'Open questions'],
  one_on_one: ['Check-in', 'Topics', 'Feedback', 'Action items'],
  retro: ['What went well', "What didn't", 'Ideas', 'Action items'],
  proposal: ['Overview', 'Scope', 'Timeline', 'Pricing', 'Next steps'],
  handbook_page: ['Purpose', 'How it works', 'Who to ask', 'Related pages'],
};

const headingText = (node: JSONContent) => (node.content ?? []).map((child) => child.text ?? '').join('');
const ids = (json: JSONContent) => topLevelBlocks(json).map((block) => block.id);

test('every built-in template converts to JSON with fresh block ids and the listed headings', () => {
  assert.deepEqual(BUILT_IN_TEMPLATES.map((t) => t.key).sort(), Object.keys(SECTIONS).sort());
  for (const template of BUILT_IN_TEMPLATES) {
    const json = templateJson(template.key);
    assert.doesNotThrow(() => getDocumentSchema().nodeFromJSON(json).check(), template.key);
    const headings = (json.content ?? []).filter((node) => node.type === 'heading').map(headingText);
    assert.deepEqual(headings, SECTIONS[template.key], template.key);
    const blockIds = ids(json);
    assert.ok(blockIds.length > 0 && blockIds.every((id) => typeof id === 'string' && id.length > 0), template.key);
    assert.equal(new Set(blockIds).size, blockIds.length, `${template.key}: ids are unique`);
    const again = ids(templateJson(template.key));
    assert.ok(again.every((id) => !blockIds.includes(id)), `${template.key}: every call gives new ids`);
  }
  for (const key of ['meeting_notes', 'one_on_one', 'retro'] as const) {
    const types = (templateJson(key).content ?? []).map((node) => node.type);
    assert.equal(types.at(-1), 'taskList', `${key}: Action items is a task list`);
  }
  assert.equal(templateJson('handbook_page').content![0]!.type, 'tableOfContents');
});
