import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { appRunAttempts } from '@deft/db/schema';
import { APP_RUN_TRANSACTION_LIMITS, createBoundedAppRunDatabase } from '../src/lib/app-run-bounded-db.js';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';

type Query = { text: string; values?: unknown[]; rowMode?: string };
class Client {
  queries: Query[] = [];
  releases: boolean[] = [];
  fail = false;
  async query(value: string | Query, values?: unknown[]) {
    const query = typeof value === 'string' ? { text: value, values } : { ...value, values };
    this.queries.push(query);
    if (this.fail && /^select .*lease_expires_at/i.test(query.text)) throw Error('Statement failed');
    const rows = /^select .*lease_expires_at/i.test(query.text) ? [['2026-10-22 12:00:00.123']] : [];
    return { rows, fields: [], rowCount: rows.length, command: 'SELECT' };
  }
  release(discard = false) { this.releases.push(discard); }
}

async function fixture(work: (database: ReturnType<typeof createBoundedAppRunDatabase>, clients: Client[], options: Record<string, unknown>) => Promise<void>) {
  const original = pg.Pool;
  const clients: Client[] = [];
  let options: Record<string, unknown> = {};
  class Pool {
    constructor(value: Record<string, unknown>) { options = value; }
    on() { return this; }
    async connect() { const client = new Client(); clients.push(client); return client; }
    async end() {}
  }
  // Only the network transport is replaced; production Drizzle creates and
  // executes every transaction, table query, codec and savepoint below.
  (pg as unknown as { Pool: unknown }).Pool = Pool;
  const database = createBoundedAppRunDatabase('postgres://unused/isolated', { max: 1, application_name: 'bounded-test' });
  try { await work(database, clients, options); }
  finally { await database.close(); pg.Pool = original; }
}
const signal = () => new AbortController().signal;
const deadline = () => performance.now() + 5000;
const commands = (client: Client) => client.queries.map(query => query.text.toLowerCase());

test('three bounded transactions retain fresh clients, native Date codecs and heartbeat updates without relational metadata', async () => {
  await fixture(async (database, clients, options) => {
    const transactions = new Set<AppRunTransaction>();
    for (let index = 0; index < 3; index++) {
      await database.transaction(async tx => {
        transactions.add(tx);
        // The unsupported API must not reconstruct the complete schema merely
        // to populate relational query builders on every bounded transaction.
        assert.deepEqual(Object.keys((tx as unknown as { query: object }).query), []);
        const [row] = await tx.select({ lease: appRunAttempts.lease_expires_at }).from(appRunAttempts);
        assert.ok(row!.lease instanceof Date);
        assert.equal(row!.lease.toISOString(), '2026-10-22T12:00:00.123Z');
        await tx.update(appRunAttempts).set({ lease_expires_at: row!.lease, updated_at: row!.lease })
          .where(eq(appRunAttempts.id, '00000000-0000-0000-0000-000000000001'));
      }, signal(), deadline());
    }
    assert.equal(transactions.size, 3); assert.equal(clients.length, 3);
    for (const client of clients) {
      assert.equal(commands(client)[0], 'begin'); assert.equal(commands(client).at(-1), 'commit');
      assert.equal(commands(client).filter(command => command === 'begin').length, 1);
      assert.deepEqual(client.releases, [false]);
      const update = client.queries.find(query => /^update /i.test(query.text))!;
      assert.equal(update.values![0], '2026-10-22T12:00:00.123Z');
      assert.equal(update.values![1], '2026-10-22T12:00:00.123Z');
    }
    assert.equal(options.statement_timeout, APP_RUN_TRANSACTION_LIMITS.statement_ms);
    assert.equal(options.lock_timeout, APP_RUN_TRANSACTION_LIMITS.lock_ms);
    assert.equal(options.connectionTimeoutMillis, APP_RUN_TRANSACTION_LIMITS.acquisition_ms);
  });
});

test('core-only nested transactions retain savepoint rollback and parent commit', async () => {
  await fixture(async (database, clients) => {
    await database.transaction(async tx => {
      await assert.rejects(tx.transaction(async nested => { await nested.execute(sql`SELECT 1`); throw Error('Nested failure'); }), /Nested failure/);
      await tx.execute(sql`SELECT 2`);
    }, signal(), deadline());
    assert.equal(clients.length, 1);
    assert.deepEqual(commands(clients[0]!), ['begin', 'savepoint sp1', 'select 1', 'rollback to savepoint sp1', 'select 2', 'commit']);
    assert.deepEqual(clients[0]!.releases, [false]);
  });
});

test('callback failure rolls back the current transaction and never commits', async () => {
  await fixture(async (database, clients) => {
    await assert.rejects(database.transaction(async tx => { await tx.execute(sql`SELECT 1`); throw Error('Work failed'); }, signal(), deadline()), /Work failed/);
    assert.deepEqual(commands(clients[0]!), ['begin', 'select 1', 'rollback']);
    assert.deepEqual(clients[0]!.releases, [false]);
  });
});

test('pre-aborted and expired work cannot acquire a client', async () => {
  await fixture(async (database, clients) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(database.transaction(async () => { assert.fail('Aborted work'); }, controller.signal, deadline()));
    await assert.rejects(database.transaction(async () => { assert.fail('Expired work'); }, signal(), performance.now() - 1), /deadline/);
    assert.equal(clients.length, 0);
  });
});

test('abort after a statement discards the exact client once and blocks commit', async () => {
  await fixture(async (database, clients) => {
    const controller = new AbortController();
    await assert.rejects(database.transaction(async tx => { await tx.execute(sql`SELECT 1`); controller.abort(); }, controller.signal, deadline()));
    assert.ok(!commands(clients[0]!).includes('commit'));
    assert.deepEqual(clients[0]!.releases, [true]);
  });
});

test('a deadline reached during work discards the client and blocks the next statement', async context => {
  let now = performance.now();
  const clock = context.mock.method(performance, 'now', () => now);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await fixture(async (database, clients) => {
      await assert.rejects(database.transaction(async tx => {
        await tx.execute(sql`SELECT 1`);
        now += 10_001;
        context.mock.timers.tick(10_001);
        await tx.execute(sql`SELECT 2`);
      }, signal(), now + 10_000),
      (error: unknown) => error instanceof Error && error.cause instanceof Error && error.cause.message === 'App Run transaction deadline');
      assert.ok(!commands(clients[0]!).includes('select 2'));
      assert.ok(!commands(clients[0]!).includes('commit'));
      assert.deepEqual(clients[0]!.releases, [true]);
    });
  } finally { context.mock.timers.reset(); clock.mock.restore(); }
});

test('overlapping transactions keep independent clients and abort budgets', async () => {
  await fixture(async (database, clients) => {
    const controller = new AbortController();
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { resume = resolve; });
    const first = database.transaction(async tx => { await tx.execute(sql`SELECT 1`); enter(); await held; }, controller.signal, deadline());
    await entered;
    await database.transaction(async tx => { await tx.execute(sql`SELECT 2`); controller.abort(); }, signal(), deadline());
    const rejected = assert.rejects(first); resume(); await rejected;
    assert.equal(clients.length, 2);
    assert.ok(!commands(clients[0]!).includes('commit')); assert.deepEqual(clients[0]!.releases, [true]);
    assert.equal(commands(clients[1]!).at(-1), 'commit'); assert.deepEqual(clients[1]!.releases, [false]);
  });
});

test('a failed statement discards its current client without committing', async () => {
  await fixture(async (database, clients) => {
    await assert.rejects(database.transaction(async tx => {
      clients[0]!.fail = true;
      await tx.select({ lease: appRunAttempts.lease_expires_at }).from(appRunAttempts);
    }, signal(), deadline()));
    assert.ok(!commands(clients[0]!).includes('commit')); assert.deepEqual(clients[0]!.releases, [true]);
  });
});

test('remaining transaction budget still bounds statement and lock timeouts', async () => {
  await fixture(async (database, clients) => {
    await database.transaction(async tx => { await tx.execute(sql`SELECT 1`); }, signal(), performance.now() + 1000);
    const settings = clients[0]!.queries.filter(query => query.text.includes("set_config('statement_timeout'"));
    assert.ok(settings.length > 0);
    for (const setting of settings) {
      assert.ok(Number(setting.values![0]) > 0 && Number(setting.values![0]) <= 1000);
      assert.ok(Number(setting.values![1]) > 0 && Number(setting.values![1]) <= APP_RUN_TRANSACTION_LIMITS.lock_ms);
    }
    assert.equal(commands(clients[0]!).at(-1), 'commit');
  });
});

// Include this test in a TypeScript check to verify both unsupported APIs;
// the core column inference and codecs are exercised by the runtime test too.
function coreContract(tx: AppRunTransaction) {
  // @ts-expect-error Bounded Run transactions do not expose relational queries.
  void tx.query;
  return tx.transaction(async nested => {
    // @ts-expect-error A nested transaction has the same core-only contract.
    void nested.query;
  });
}
void coreContract;
