import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProtectedFile, protectedFilePath } from './protected-file';

test('fetches file bytes through the protected API path derived only from the file id', async () => {
  let requestedPath = '';
  const expected = new Blob(['private attachment'], { type: 'text/plain' });

  const result = await fetchProtectedFile('file/id?spoofed=/evil', async (path) => {
    requestedPath = path;
    return new Response(expected, { status: 200 });
  });

  assert.equal(requestedPath, '/api/files/file%2Fid%3Fspoofed%3D%2Fevil');
  assert.equal(protectedFilePath('file/id?spoofed=/evil'), requestedPath);
  assert.equal(await result.text(), 'private attachment');
});

test('reports a protected file failure without returning an unusable blob', async () => {
  await assert.rejects(
    fetchProtectedFile('missing-file', async () => new Response(
      JSON.stringify({ error: 'File not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )),
    /File not found/,
  );
});
