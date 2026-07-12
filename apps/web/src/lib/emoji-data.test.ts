import test from 'node:test';
import assert from 'node:assert/strict';
import { EMOJI_DATA } from './emoji-data';

test('emoji picker data contains no replacement or mojibake characters', () => {
  const serialized = JSON.stringify(EMOJI_DATA);
  assert.equal(serialized.includes('�'), false);
  assert.equal(serialized.includes('ðŸ'), false);
  assert.equal(serialized.includes('ï¿½'), false);
});

test('emoji categories contain unique, selectable values', () => {
  for (const [name, category] of Object.entries(EMOJI_DATA)) {
    assert.ok(category.icon.length > 0, `${name} has an icon`);
    assert.equal(new Set(category.emoji).size, category.emoji.length, `${name} has no duplicate emoji`);
  }
});
