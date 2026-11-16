import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// A real TCP peer that can stall either startup or every SQL response. No
// PostgreSQL data is written, and no live database or shared pool is needed.
let mode: 'connect' | 'query' = 'connect';
const sockets = new Set<Socket>();
let peak = 0;
let queries = 0;
const server = createServer((socket) => {
  const phase = mode;
  sockets.add(socket);
  peak = Math.max(peak, sockets.size);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  let startup = true;
  let buffered = Buffer.alloc(0);
  socket.on('data', (data) => {
    if (phase === 'connect') return;
    buffered = Buffer.concat([buffered, data]);
    if (startup) {
      if (buffered.length < 4 || buffered.length < buffered.readInt32BE(0)) return;
      buffered = buffered.subarray(buffered.readInt32BE(0));
      startup = false;
      // AuthenticationOk, then ReadyForQuery. Deliberately never answer SQL.
      socket.write(Buffer.from('5200000008000000005a0000000549', 'hex'));
    }
    if (buffered.length) { queries++; buffered = Buffer.alloc(0); }
  });
});
let api: typeof import('../src/lib/schema-applied.js');

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  process.env.DATABASE_URL = `postgres://health:test@127.0.0.1:${port}/deft_test_c6?sslmode=disable`;
  api = await import('../src/lib/schema-applied.js');
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  for (let i = 0; i < 50 && sockets.size; i++) await delay(10);
  peak = 0;
  queries = 0;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeDb } = await import('../src/lib/db.js');
  await closeDb();
});

for (const phase of ['connect', 'query'] as const) {
  test(`repeated health probes close stalled ${phase} sockets before retrying`, { timeout: 15_000 }, async () => {
    mode = phase;
    let clock = 0;
    const get = api.createSchemaAppliedCache(api.readLedgerFromDatabase, () => clock);
    for (let i = 0; i < 4; i++) {
      const started = performance.now();
      assert.deepEqual(await get(), { value: null, state: 'unavailable' });
      assert.ok(performance.now() - started < 2_500, 'the full database operation must be bounded');
      clock += 6_000;
    }
    for (let i = 0; i < 50 && sockets.size; i++) await delay(10);
    assert.equal(sockets.size, 0, 'a timed-out health read left a database socket occupied');
    assert.equal(peak, 1, 'replacement probes must not accumulate connections');
    if (phase === 'query') assert.ok(queries >= 4, 'the test must reach SQL after successful authentication');
  });
}
