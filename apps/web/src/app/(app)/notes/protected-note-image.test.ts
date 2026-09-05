import test from 'node:test';
import assert from 'node:assert/strict';
import { noteImageAttributes } from './protected-note-image';

test('persists only the protected file id and never an API URL or bearer token', () => {
  const attrs = noteImageAttributes({ id: 'file-123', name: 'diagram.png' });

  assert.deepEqual(attrs, {
    fileId: 'file-123',
    alt: 'diagram.png',
    title: 'diagram.png',
  });
  assert.equal('src' in attrs, false);
  assert.equal(JSON.stringify(attrs).includes('Bearer'), false);
  assert.equal(JSON.stringify(attrs).includes('/api/files/'), false);
});
