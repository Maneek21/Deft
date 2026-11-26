/**
 * The privileged drive reads run their authorization and their data reads in
 * one read-only, repeatable-read transaction, so both see one snapshot
 * (consult S-F7): the members panel (GET /api/drives/:id/members, members and
 * admin changes), drives without a manager and frozen drives.
 *
 * A race between the authorization and a data read can't be placed inside
 * one request from here, so this is the unit-level check: the database
 * client is wrapped to record the options each transaction is opened with,
 * and each endpoint must open one with { isolationLevel: 'repeatable read',
 * accessMode: 'read only' } and still answer as before. Inside such a
 * transaction PostgreSQL takes one snapshot at its first statement.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/drives-read-snapshot-db.test.ts
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { sql } from 'drizzle-orm';

const opened: Array<{ config: unknown; isolation: string | null }> = [];
const actualDb = await import('../src/lib/db.js');
const realDb = actualDb.db;
const recordingDb = new Proxy(realDb, {
  get(target, prop) {
    if (prop === 'transaction') {
      return (run: (tx: any) => Promise<unknown>, config?: unknown) => target.transaction(async (tx: any) => {
        const result = await tx.execute(sql`SHOW transaction_isolation`);
        opened.push({ config: config ?? null, isolation: (result.rows[0] as { transaction_isolation?: string } | undefined)?.transaction_isolation ?? null });
        return run(tx);
      }, config as any);
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { ...actualDb, db: recordingDb } });

const { driveRoutes } = await import('../src/routes/drives.js');
const { setupDrivesFixture } = await import('./fixtures/drives-fixture.js');
const { safeTestDatabaseUrl } = await import('./fixtures/safe-test-database.js');

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' };
let fx: Awaited<ReturnType<typeof setupDrivesFixture>> | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('drives-read-snapshot', { routes: [{ path: '/api/drives', app: driveRoutes }] });
});

after(async () => {
  try {
    await fx?.teardown();
  } finally {
    await actualDb.closeDb();
  }
});

async function read(userId: string, path: string): Promise<any> {
  opened.length = 0;
  const res = await fx!.request(userId, 'GET', path);
  const body = await res.json();
  assert.equal(res.status, 200, `${path}: ${JSON.stringify(body)}`);
  return body;
}

function assertOneSnapshot(path: string) {
  assert.equal(opened.length, 1, `${path} opens one transaction`);
  assert.deepEqual(opened[0]!.config, SNAPSHOT, `${path}: read only, repeatable read`);
  assert.equal(opened[0]!.isolation, 'repeatable read', `${path}: PostgreSQL ran it at repeatable read`);
}

test('the members panel, drives without a manager and frozen drives each read in one repeatable-read snapshot (S-F7)', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2, owner } = fx.people;
  const drive = await fx.insertDrive({ kind: 'private', name: 'Snapshot drive' });
  await fx.addDriveMember(drive, { user: member }, 'full');
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  const orphan = await fx.insertDrive({ kind: 'private', name: 'Nobody manages this' });
  await fx.addDriveMember(orphan, { user: member2 }, 'edit');
  const departed = await fx.addPerson({ active: false });
  const frozen = await fx.insertDrive({ kind: 'personal', ownerUserId: departed, frozen: true, name: 'My drive' });

  const panel = await read(member, `/api/drives/${drive}/members`);
  assertOneSnapshot('GET /:id/members');
  assert.deepEqual(panel.members.map((row: any) => [row.principal_id, row.role]).sort(), [[member, 'full'], [member2, 'view']].sort());
  assert.deepEqual(panel.admin_changes, []);

  const withoutManager = await read(admin, '/api/drives/without-manager');
  assertOneSnapshot('GET /without-manager');
  assert.ok(withoutManager.drives.some((row: any) => row.id === orphan));

  const frozenList = await read(owner, '/api/drives/frozen');
  assertOneSnapshot('GET /frozen');
  assert.ok(frozenList.drives.some((row: any) => row.id === frozen));

  // Refusals come from the same snapshot.
  opened.length = 0;
  const refused = await fx.request(member2, 'GET', `/api/drives/${drive}/members`);
  assert.equal(refused.status, 403);
  assertOneSnapshot('GET /:id/members (refused)');
});
