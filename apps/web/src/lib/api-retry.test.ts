/**
 * Run: pnpm --filter @deft/web exec tsx --test src/lib/api-retry.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, open, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { api } from './api';

test('does not replay a POST when the server commits before the response is lost', async (t) => {
  const originalFetch = globalThis.fetch;
  let transportCalls = 0;
  const directory = await mkdtemp(path.join(tmpdir(), 'deft-retry-proof-'));
  const journal = path.join(directory, 'committed-events.jsonl');
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const file = await open(journal, 'a');
    try {
      await file.writeFile(`${Buffer.concat(chunks).toString()}\n`);
      await file.sync();
    } finally { await file.close(); }
    // Commit is durable before destroying the real HTTP response transport.
    request.socket.destroy();
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  globalThis.fetch = (async (_input, init) => {
    transportCalls += 1;
    return originalFetch(`http://127.0.0.1:${port}/api/events`, init);
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(journal);
    await rmdir(directory);
  });

  let observedError: unknown;
  try {
    await api.post('/api/events', { title: 'Launch review' });
  } catch (error) {
    observedError = error;
  }

  const durableCreates = (await readFile(journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(durableCreates, [{ title: 'Launch review' }], 'one user action must produce one durable create');
  assert.equal(transportCalls, 1, 'an unsafe request must not be replayed automatically');
  assert.ok(observedError instanceof TypeError, 'the ambiguous network failure must reach the caller');
});

test('retries a GET after a transient network failure', async (t) => {
  const originalFetch = globalThis.fetch;
  let transportCalls = 0;

  globalThis.fetch = (async () => {
    transportCalls += 1;
    if (transportCalls === 1) {
      throw new TypeError('temporary network failure');
    }
    return new Response(JSON.stringify({ events: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await api.get('/api/events');

  assert.equal(response.status, 200);
  assert.equal(transportCalls, 2, 'safe reads should retain bounded network retries');
});
