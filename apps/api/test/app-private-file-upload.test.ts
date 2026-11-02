import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parsePrivateFileUpload, withPrivateFileUpload } from '../src/lib/app-private-file-upload.js';
import { PRIVATE_FILE_LIMITS } from '../src/lib/app-private-file-contract.js';

const url = () => 'https://deft.test/files?' + new URLSearchParams({ expected_revision: '2', upload_operation_id: randomUUID(), filename: 'brief.pdf' });
const request = (body: BodyInit, extra: RequestInit = {}) => new Request(url(), { method: 'POST', headers: { 'content-type': 'application/pdf' }, body, ...extra });

test('raw upload validates one exact revision/operation/name and preserves exact bytes', async () => {
  const raw = request('test bytes');
  assert.equal(parsePrivateFileUpload(raw).expected_revision, 2);
  assert.equal(await withPrivateFileUpload('owner', raw, async bytes => Buffer.from(bytes).toString()), 'test bytes');
  for (const tail of ['&filename=second.pdf', '&owner_id=other']) {
    assert.throws(() => parsePrivateFileUpload(new Request(raw.url + tail, { method: 'POST', headers: raw.headers })));
  }
  assert.throws(() => parsePrivateFileUpload(new Request(raw.url.replace('expected_revision=2', 'expected_revision=2e0'), { method: 'POST', headers: raw.headers })));
});

test('the advertised upload budget is 8 MiB and a 30 s transfer window', () => {
  assert.equal(PRIVATE_FILE_LIMITS.file_bytes, 8388608);
  assert.equal(PRIVATE_FILE_LIMITS.payload_bytes, 8388608);
  assert.equal(PRIVATE_FILE_LIMITS.transfer_ms, 30000);
});

test('declared content-length beyond 8 MiB is rejected 413 before any body byte is read', () => {
  assert.throws(
    () => parsePrivateFileUpload(request('bytes', { headers: { 'content-type': 'application/pdf', 'content-length': '8388609' } })),
    (error: unknown) => error instanceof Error && 'status' in error && (error as { status: number }).status === 413 && 'code' in error && (error as { code: string }).code === 'APP_ACTION_INVALID',
  );
});

test('an 8 MiB body is accepted while an 8 MiB + 1 body and a size mismatch never enter custody', async () => {
  const full = new Uint8Array(PRIVATE_FILE_LIMITS.file_bytes).fill(7);
  assert.equal(await withPrivateFileUpload('full', request(full), async bytes => bytes.byteLength), PRIVATE_FILE_LIMITS.file_bytes);
  let writes = 0;
  for (const raw of [request(''), request(new Uint8Array(PRIVATE_FILE_LIMITS.file_bytes + 1)),
    request('short', { headers: { 'content-type': 'application/pdf', 'content-length': '20' } })]) {
    await assert.rejects(withPrivateFileUpload('owner', raw, async () => { writes++; }));
  }
  assert.equal(writes, 0);
});

test('a body that stalls within the 30 s transfer window completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let releaseStream!: () => void;
  const gate = new Promise<void>(resolve => { releaseStream = resolve; });
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(new Uint8Array([1, 2, 3])); return; }
      await gate;
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  });
  const pending = withPrivateFileUpload('slow-ok', request(stream, { duplex: 'half' } as RequestInit), async bytes => Buffer.from(bytes).toString('hex'));
  t.mock.timers.tick(12000);
  releaseStream();
  assert.equal(await pending, '010203040506');
});

test('a body that stalls past the 30 s transfer window is rejected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = new Promise<void>(() => {});
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(new Uint8Array([1])); return; }
      await never;
    },
  });
  const pending = withPrivateFileUpload('slow-timeout', request(stream, { duplex: 'half' } as RequestInit), async () => 'never');
  t.mock.timers.tick(31000);
  await assert.rejects(pending);
});

test('abort cancels stalled raw input and four-per-owner capacity covers the full custody mutation', async () => {
  const abort = new AbortController(); let cancelled = false, writes = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = withPrivateFileUpload('owner-abort', request(stream, { signal: abort.signal, duplex: 'half' } as RequestInit), async () => { writes++; });
  abort.abort(); await assert.rejects(pending); assert.equal(cancelled, true); assert.equal(writes, 0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = [withPrivateFileUpload('limited-owner', request('one'), async () => gate),
    withPrivateFileUpload('limited-owner', request('two'), async () => gate),
    withPrivateFileUpload('limited-owner', request('three'), async () => gate),
    withPrivateFileUpload('limited-owner', request('four'), async () => gate)];
  await assert.rejects(withPrivateFileUpload('limited-owner', request('five'), async () => {}), /busy/);
  release(); await Promise.all(held);
  await withPrivateFileUpload('limited-owner', request('six'), async () => {});
});
