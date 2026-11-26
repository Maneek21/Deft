/**
 * After a removal commits, each live effect runs on its own (consult S-F9):
 * a huddle eviction that throws never skips finishing drive and document
 * access, the handover, or the new holder's notice, and the request still
 * answers 200. The socket module is mocked so the eviction fails.
 *
 * A committed owner's handover answers 200 with the caller's role and pin
 * even when finishing it afterwards fails (consult Sol-C2): lib/drives.ts is
 * mocked so finishDriveHandover throws while `failHandoverFinish` is set.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/drives-departure-post-commit-db.test.ts
 */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { after, before, mock, test } from 'node:test';

let evictions = 0;
const actualSocket = await import('../src/socket.js');
mock.module(new URL('../src/socket.ts', import.meta.url).href, { namedExports: {
  ...actualSocket,
  evictActiveHuddleParticipants: async () => {
    evictions += 1;
    throw new Error('huddle eviction failed');
  },
} });

let failHandoverFinish = false;
let handoverFinishes = 0;
const actualDrives = await import('../src/lib/drives.js');
mock.module(new URL('../src/lib/drives.ts', import.meta.url).href, { namedExports: {
  ...actualDrives,
  finishDriveHandover: async (handover: Parameters<typeof actualDrives.finishDriveHandover>[0]) => {
    handoverFinishes += 1;
    if (failHandoverFinish) throw new Error('finishing the handover failed');
    return actualDrives.finishDriveHandover(handover);
  },
} });

const { closeDb } = await import('../src/lib/db.js');
const { onDocumentAccessChanged } = await import('../src/lib/document-access-events.js');
const { driveRoutes } = await import('../src/routes/drives.js');
const { memberRoutes } = await import('../src/routes/members.js');
const { setupDrivesFixture } = await import('./fixtures/drives-fixture.js');
const { safeTestDatabaseUrl } = await import('./fixtures/safe-test-database.js');

type Change = { orgId: string; driveId?: string; documentIds?: string[]; spaceId?: string; userIds?: string[] };

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let fx: Awaited<ReturnType<typeof setupDrivesFixture>> | undefined;
const accessChanges: Change[] = [];
let unsubscribe: (() => void) | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('drives-post-commit', {
    routes: [{ path: '/api/drives', app: driveRoutes }, { path: '/api/members', app: memberRoutes }],
  });
  unsubscribe = onDocumentAccessChanged((change) => { accessChanges.push(change); });
});

after(async () => {
  unsubscribe?.();
  try {
    await fx?.teardown();
  } finally {
    await closeDb();
  }
});

async function person(name: string): Promise<string> {
  const id = await fx!.addPerson({ role: 'member' });
  await fx!.client.query('UPDATE users SET name = $2 WHERE id = $1', [id, name]);
  return id;
}

const emitted = (change: Change) => accessChanges.some((seen) => isDeepStrictEqual(seen, change));

test('a removal whose huddle eviction fails still finishes drive access, the handover and the notice, and answers 200', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member2, owner } = fx.people;
  const leaver = await person('Leaves Mid Huddle');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: leaver, name: 'My drive' });
  const doc = await fx.insertDocument({ driveId: drive, title: 'Notes' });
  accessChanges.length = 0;
  const before = evictions;

  const res = await fx.request(owner, 'DELETE', `/api/members/${leaver}`, { replacement_user_id: member2 });
  assert.equal(res.status, 200, await res.text());
  assert.equal(evictions, before + 1, 'the eviction ran, and failed');
  assert.ok(emitted({ orgId: fx.orgId, driveId: drive, documentIds: [doc] }), 'the handover finished');
  assert.ok(emitted({ orgId: fx.orgId, userIds: [leaver] }), 'the departure finished');
  const { rows } = await fx.client.query(`SELECT count(*)::int AS n FROM notifications
    WHERE org_id = $1 AND user_id = $2 AND metadata->>'drive_id' = $3 AND metadata->>'subtype' = 'handover'`, [fx.orgId, member2, drive]);
  assert.equal(rows[0].n, 1, 'the new holder was told');

  // Without a replacement: the freeze finishes too.
  const second = await person('Also Leaves Mid Huddle');
  const frozen = await fx.insertDrive({ kind: 'personal', ownerUserId: second, name: 'My drive' });
  accessChanges.length = 0;
  const again = await fx.request(owner, 'DELETE', `/api/members/${second}`, {});
  assert.equal(again.status, 200, await again.text());
  assert.ok(emitted({ orgId: fx.orgId, driveId: frozen, documentIds: [] }), 'the freeze finished');
  assert.ok(emitted({ orgId: fx.orgId, userIds: [second] }));
});

test('a committed handover answers 200 with the caller’s role and pin even when finishing it fails afterwards (Sol-C2)', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { owner } = fx.people;
  const departed = await person('Leaves It With The Owner');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: departed, name: 'My drive' });
  await fx.insertDocument({ driveId: drive, title: 'Left behind' });
  const removed = await fx.request(owner, 'DELETE', `/api/members/${departed}`, {});
  assert.equal(removed.status, 200, await removed.text());
  const before = handoverFinishes;
  failHandoverFinish = true;
  let res: Response;
  try {
    res = await fx.request(owner, 'POST', `/api/drives/${drive}/handover`, { user_id: owner });
  } finally {
    failHandoverFinish = false;
  }
  const body = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(handoverFinishes, before + 1, 'the finish ran, and failed');
  assert.equal(body.drive.id, drive);
  assert.equal(body.drive.kind, 'private');
  assert.equal(body.drive.role, 'full', 'read inside the handover’s transaction');
  assert.equal(body.drive.pinned, false);
  const { rows: [state] } = await fx.client.query('SELECT kind, frozen_at FROM drives WHERE id = $1', [drive]);
  assert.deepEqual(state, { kind: 'private', frozen_at: null }, 'committed');
});
