import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAttributes } from '@tiptap/core';

test('JSON-origin editor attributes cannot inject an inherited DOM attribute', () => {
  const input = JSON.parse('{"__proto__":{"data-inherited-canary":"unexpected"}}');
  const merged = mergeAttributes({ class: 'note-image' }, input);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(merged['data-inherited-canary'], undefined);
  assert.equal(merged.class, 'note-image');
});
