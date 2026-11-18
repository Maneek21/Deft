import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { handleDatabaseConnectionErrors } from '../src/lib/database-connection-errors.js';

const frame = (tag: string, payload: Buffer) => {
  const length = Buffer.alloc(4); length.writeInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(tag), length, payload]);
};

test('a stalled BEGIN followed by a connection reset releases the failed checkout', async () => {
  const sockets = new Set<net.Socket>();
  let stalled!: () => void;
  const began = new Promise<void>(resolve => { stalled = resolve; });
  let first = true;
  let stalledSocket: net.Socket | undefined;
  const server = net.createServer(client => {
    sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {});
    const stall = first; first = false;
    let startup = true, pending = Buffer.alloc(0);
    client.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      if (startup) {
        if (pending.length < 4 || pending.length < pending.readInt32BE()) return;
        pending = pending.subarray(pending.readInt32BE()); startup = false;
        client.write(Buffer.concat([frame('R', Buffer.alloc(4)), frame('Z', Buffer.from('I'))]));
      }
      while (pending.length >= 5 && pending.length >= pending.readInt32BE(1) + 1) {
        const size = pending.readInt32BE(1) + 1, tag = String.fromCharCode(pending[0]!);
        const command = pending.subarray(5, size - 1).toString().toUpperCase(); pending = pending.subarray(size);
        if (tag === 'X') { client.end(); return; }
        if (stall && command === 'BEGIN') { stalledSocket = client; stalled(); continue; }
        client.write(Buffer.concat([frame('C', Buffer.from(command + '\0')), frame('Z', Buffer.from(command === 'BEGIN' ? 'T' : 'I'))]));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const pool = new pg.Pool({ connectionString: `postgres://synthetic@127.0.0.1:${(server.address() as net.AddressInfo).port}/synthetic`, max: 1, connectionTimeoutMillis: 500 });
  let acquiredClient: pg.PoolClient | undefined;
  pool.on('acquire', client => { acquiredClient = client; });
  handleDatabaseConnectionErrors(pool);
  const database = drizzle(pool);
  try {
    const failed = assert.rejects(database.transaction(async () => {}));
    await began;
    assert.equal(pool.idleCount, 0);
    stalledSocket!.destroy();
    await failed;
    assert.equal(pool.totalCount, 0, 'failed BEGIN must not leak the only checkout');
    await database.transaction(async () => {});
    assert.equal(pool.idleCount, 1);
  } finally {
    if (pool.totalCount > 0 && pool.idleCount === 0) acquiredClient?.release(true);
    await pool.end(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
