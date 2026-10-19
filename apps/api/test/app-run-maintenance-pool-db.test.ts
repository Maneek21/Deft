import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { createAppRunMaintenanceDatabase } from '../src/lib/app-run-maintenance-db.js';

const frame = (tag: string, payload: Buffer) => {
  const length = Buffer.alloc(4); length.writeInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(tag), length, payload]);
};

test('maintenance retains its one budgeted connection across idle passes instead of timing out on a cold handshake', { timeout: 20_000 }, async () => {
  const sockets = new Set<net.Socket>(); let accepted = 0; let transactionOpen = false;
  // A real pg client/pool and wire protocol exercise the startup/idle boundary
  // without a provider, DB fixture, or scheduler-dependent server load.
  const server = net.createServer(client => {
    const ordinal = ++accepted; sockets.add(client);
    client.on('close', () => sockets.delete(client)); client.on('error', () => {});
    let startup = true, pending = Buffer.alloc(0);
    client.on('data', bytes => {
      pending = Buffer.concat([pending, bytes]);
      if (startup) {
        if (pending.length < 4 || pending.length < pending.readInt32BE()) return;
        pending = pending.subarray(pending.readInt32BE()); startup = false;
        const ready = () => { if (!client.destroyed) client.write(Buffer.concat([
          frame('R', Buffer.alloc(4)), frame('Z', Buffer.from('I')),
        ])); };
        if (ordinal === 1) ready();
        else { const timer = setTimeout(ready, 350); client.once('close', () => clearTimeout(timer)); }
      }
      while (pending.length >= 5 && pending.length >= pending.readInt32BE(1) + 1) {
        const size = pending.readInt32BE(1) + 1, tag = String.fromCharCode(pending[0]!);
        const command = pending.subarray(5, size - 1).toString().toUpperCase(); pending = pending.subarray(size);
        if (tag === 'X') { client.end(); return; }
        assert.equal(tag, 'Q');
        if (command === 'BEGIN') transactionOpen = true;
        if (command === 'COMMIT' || command === 'ROLLBACK') transactionOpen = false;
        client.write(Buffer.concat([frame('C', Buffer.from(`${command.startsWith('SELECT') ? 'SELECT 0' : command}\0`)),
          frame('Z', Buffer.from(transactionOpen ? 'T' : 'I'))]));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  const database = createAppRunMaintenanceDatabase(`postgresql://synthetic@127.0.0.1:${address.port}/synthetic`);
  let closed = false;
  const transaction = () => database.transaction(tx => tx.execute(sql`SELECT 1`),
    new AbortController().signal, performance.now() + 10_000);
  try {
    await transaction(); assert.equal(transactionOpen, false);
    await delay(10_200); // pg idle eviction is 10 seconds; recovery cadence is 30 seconds.
    await transaction();
    assert.equal(accepted, 1, 'no replacement startup or retry should occur between maintenance passes');
    assert.equal(transactionOpen, false, 'idle connection must carry no open transaction');
    await database.close(); closed = true;
    for (let i = 0; i < 100 && sockets.size; i++) await delay(5);
    assert.equal(sockets.size, 0, 'shutdown must close the retained connection');
  } finally {
    if (!closed) await database.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('an unavailable first maintenance handshake remains bounded and does not retry', { timeout: 3_000 }, async () => {
  const sockets = new Set<net.Socket>(); let accepted = 0;
  const server = net.createServer(client => { accepted++; sockets.add(client); client.resume();
    client.on('close', () => sockets.delete(client)); client.on('error', () => {}); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  const database = createAppRunMaintenanceDatabase(`postgresql://synthetic@127.0.0.1:${address.port}/synthetic`);
  const at = performance.now(); let ran = false;
  try {
    await assert.rejects(database.transaction(async () => { ran = true; }, new AbortController().signal,
      performance.now() + 10_000), /Connection terminated due to connection timeout/);
    assert.equal(ran, false); assert.equal(accepted, 1); assert.ok(performance.now() - at < 2_000);
  } finally {
    await database.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a dropped idle maintenance socket cannot terminate the process and the next pass uses a fresh connection', { timeout: 10_000 }, async () => {
  const sockets = new Set<net.Socket>(); let accepted = 0; let transactionOpen = false;
  const server = net.createServer(client => {
    const ordinal = ++accepted; sockets.add(client); client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
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
        assert.equal(tag, 'Q');
        if (command === 'BEGIN') transactionOpen = true;
        if (command === 'COMMIT' || command === 'ROLLBACK') transactionOpen = false;
        client.write(Buffer.concat([frame('C', Buffer.from(`${command.startsWith('SELECT') ? 'SELECT 0' : command}\0`)),
          frame('Z', Buffer.from(transactionOpen ? 'T' : 'I'))]));
        if (ordinal === 1 && command === 'COMMIT') setTimeout(() => client.destroy(), 20);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  const module = new URL('../src/lib/app-run-maintenance-db.ts', import.meta.url).href;
  const code = `import {sql} from 'drizzle-orm';import {createAppRunMaintenanceDatabase} from ${JSON.stringify(module)};
    const database=createAppRunMaintenanceDatabase('postgresql://synthetic@127.0.0.1:${address.port}/synthetic');
    const pass=()=>database.transaction(tx=>tx.execute(sql.raw('SELECT 1')),new AbortController().signal,performance.now()+10000);
    await pass();await new Promise(resolve=>setTimeout(resolve,100));await pass();await database.close();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString(); }); child.stdout.resume();
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(exit, 0, stderr);
    assert.equal(stderr.trim(), '[app-runs] bounded database idle connection closed');
    assert.equal(accepted, 2, 'pg must remove the dead idle client before the next pass checks out a replacement');
    assert.equal(transactionOpen, false);
    for (let i = 0; i < 100 && sockets.size; i++) await delay(5);
    assert.equal(sockets.size, 0);
  } finally {
    child.kill(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
