import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLegacyAttachmentIds,
  normalizeAttachmentIds,
} from '../src/lib/message-attachments.js';

test('extracts only marker ids and deduplicates them with structured ids', () => {
  const content = [
    'hello',
    '[[file:file-1:spoofed.csv:text/csv:12:/api/files/file-1]]',
    '[[file:file-2:anything:application/json:10:https://example.test/file]]',
  ].join('\n');
  assert.deepEqual(extractLegacyAttachmentIds(content), ['file-1', 'file-2']);
  assert.deepEqual(normalizeAttachmentIds(['file-2', 'file-3'], content), ['file-2', 'file-3', 'file-1']);
});

test('ignores malformed marker ids', () => {
  assert.deepEqual(extractLegacyAttachmentIds('[[file:bad id:name:text/plain:1:/file]]'), []);
  assert.deepEqual(extractLegacyAttachmentIds('[[file::name:text/plain:1:/file]]'), []);
});
