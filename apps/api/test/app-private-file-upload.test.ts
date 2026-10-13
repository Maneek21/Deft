import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parsePrivateFileUpload, withPrivateFileUpload } from '../src/lib/app-private-file-upload.js';
import { PRIVATE_FILE_LIMITS } from '../src/lib/app-private-file-contract.js';

const url = () => 'https://deft.test/files?' + new URLSearchParams({ expected_revision: '2',
  upload_operation_id: randomUUID(), filename: 'brief.pdf' });
const request = (body: BodyInit, extra: RequestInit = {}) => new Request(url(), {
  method: 'POST', headers: { 'content-type': 'application/pdf' }, body, ...extra });

test('raw upload validates one exact revision/operation/name and preserves exact bytes', async () => {
  const raw = request('test bytes');
  assert.equal(parsePrivateFileUpload(raw).expected_revision, 2);
  assert.equal(await withPrivateFileUpload('owner', raw, async bytes => Buffer.from(bytes).toString()), 'test bytes');
  for (const tail of ['&filename=second.pdf', '&owner_id=other']) {
    assert.throws(() => parsePrivateFileUpload(new Request(raw.url + tail, { method: 'POST', headers: raw.headers })));
  }
  assert.throws(() => parsePrivateFileUpload(new Request(raw.url.replace('expected_revision=2', 'expected_revision=2e0'), { method: 'POST', headers: raw.headers })));
  assert.throws(() => parsePrivateFileUpload(request('bytes', { headers: { 'content-type': 'application/pdf', 'content-length': '2097153' } })));
});

test('empty, oversized and declared-size mismatch never enter custody', async () => {
  let writes = 0;
  for (const raw of [request(''), request(new Uint8Array(PRIVATE_FILE_LIMITS.file_bytes + 1)),
    request('short', { headers: { 'content-type': 'application/pdf', 'content-length': '20' } })]) {
    await assert.rejects(withPrivateFileUpload('owner', raw, async () => { writes++; }));
  }
  assert.equal(writes, 0);
});

test('abort cancels stalled raw input and capacity covers the full custody mutation', async () => {
  const abort = new AbortController(); let cancelled = false, writes = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = withPrivateFileUpload('owner-abort', request(stream, { signal: abort.signal,
    duplex: 'half' } as RequestInit), async () => { writes++; });
  abort.abort(); await assert.rejects(pending); assert.equal(cancelled, true); assert.equal(writes, 0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = [withPrivateFileUpload('limited-owner', request('one'), async () => gate),
    withPrivateFileUpload('limited-owner', request('two'), async () => gate)];
  await assert.rejects(withPrivateFileUpload('limited-owner', request('three'), async () => {}), /busy/);
  release(); await Promise.all(held);
  await withPrivateFileUpload('limited-owner', request('four'), async () => {});
});
