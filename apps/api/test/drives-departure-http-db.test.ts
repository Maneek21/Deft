/**
 * Departed members and their drives (spec 5.2; plan Task F6; consult rules
 * C3, C4 and C5), over HTTP:
 * - every way out of the workspace (removal, the deactivation an invite
 *   revocation makes, deleting an agent employee) freezes the person's
 *   personal drive, through the one departure seam
 *   (lib/drives.ts endDriveAccessOnDepartureInTx);
 * - removal with a replacement hands the drive to the replacement instead;
 * - only the owner lists frozen drives (GET /api/drives/frozen) and hands one
 *   on (POST /api/drives/:id/handover); the new holder is told;
 * - owners and admins list the private drives no active member holds full on
 *   in their own name (GET /api/drives/without-manager).
 *
 * Fix round 1 adds: a freeze survives a later removal with a replacement; a
 * removal that waited for another hands nothing over; the replacement's
 * eligibility is read with its rows locked, and refused with
 * PRINCIPAL_CANNOT_HOLD_ACCESS whenever there is a drive to hand over; the
 * remover's choice to freeze; the preview's personal-drive flag; the pilot
 * seed's cleanup freezes; and linking a chat never deadlocks with the
 * linker's own removal.
 *
 * Freezing and handing over are access changes (rule C3): an
 * `onAccessLossInTx` hook registered once for the file records each change
 * with the id of the transaction it ran in (`txid_current_if_assigned()`, set
 * only inside a transaction that has already written). Their documents'
 * current viewers are told with `document:updated` (rule C4).
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/drives-departure-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import test, { after, before } from 'node:test';
import { sql } from 'drizzle-orm';
import { closeDb } from '../src/lib/db.js';
import { documentRoleFor, driveRoleFor } from '../src/lib/document-access.js';
import { onDocumentAccessChanged, type DocumentAccessChange } from '../src/lib/document-access-events.js';
import { currentAccessGeneration, onAccessLossInTx } from '../src/lib/document-access-change.js';
import { agentEmployeeRoutes } from '../src/routes/agent-employees.js';
import { driveRoutes } from '../src/routes/drives.js';
import { memberRoutes } from '../src/routes/members.js';
import { cleanDuplicatePilotAgents } from '../src/scripts/seed-pilot-workspace.js';
import { setupSocket } from '../src/socket.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const ROUTES = [
  { path: '/api/drives', app: driveRoutes },
  { path: '/api/members', app: memberRoutes },
  { path: '/api/agent-employees', app: agentEmployeeRoutes },
];
let fx: DrivesFixture | undefined;

/** Every change seen by the in-transaction hook, with the id of the transaction it ran in. */
const lossesInTx: Array<{ change: DocumentAccessChange; txid: string | null }> = [];
/** Every access change emitted after commit. */
const accessChanges: DocumentAccessChange[] = [];
const unsubscribe: Array<() => void> = [];

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('drives-departure', { routes: ROUTES });
  onAccessLossInTx(async (tx, change) => {
    const result = await tx.execute(sql`SELECT txid_current_if_assigned()::text AS txid`);
    lossesInTx.push({ change, txid: (result.rows[0] as { txid: string | null }).txid });
    return [];
  });
  unsubscribe.push(onDocumentAccessChanged((change) => { accessChanges.push(change); }));
});

after(async () => {
  for (const stop of unsubscribe) stop();
  try {
    await fx?.teardown();
  } finally {
    await closeDb();
  }
});

function resetEvents() {
  lossesInTx.length = 0;
  accessChanges.length = 0;
}

async function json(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `request` that asserts the status and returns the parsed body. */
async function call(userId: string, method: string, path: string, body: unknown, status: number): Promise<any> {
  const res = await fx!.request(userId, method, path, body);
  const parsed = await json(res);
  assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(parsed)}`);
  return parsed;
}

/** A new active human member named `name`. */
async function person(name: string, role: 'admin' | 'member' | 'guest' = 'member'): Promise<string> {
  const id = await fx!.addPerson({ role });
  await fx!.client.query('UPDATE users SET name = $2 WHERE id = $1', [id, name]);
  return id;
}

type DriveState = { kind: string; owner_user_id: string | null; frozen: boolean; name: string; is_deleted: boolean; xmin: string };

async function driveState(driveId: string): Promise<DriveState> {
  const { rows: [row] } = await fx!.client.query(`SELECT kind, owner_user_id, frozen_at IS NOT NULL AS frozen, name, is_deleted, xmin::text AS xmin
    FROM drives WHERE id = $1`, [driveId]);
  assert.ok(row, `drive ${driveId}`);
  return row;
}

async function membersOf(driveId: string): Promise<Array<[string, string]>> {
  const { rows } = await fx!.client.query('SELECT principal_id, role FROM drive_members WHERE drive_id = $1 ORDER BY principal_id', [driveId]);
  return rows.map((row) => [row.principal_id, row.role]);
}

async function auditsOf(driveId: string, action: string): Promise<Array<Record<string, any>>> {
  const { rows } = await fx!.client.query(`SELECT actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, metadata,
      xmin::text AS xmin
    FROM audit_log WHERE org_id = $1 AND entity_id = $2 AND action = $3 ORDER BY created_at`, [fx!.orgId, driveId, action]);
  return rows;
}

async function isActiveMember(userId: string): Promise<boolean> {
  const { rows: [row] } = await fx!.client.query('SELECT is_active FROM org_members WHERE org_id = $1 AND user_id = $2', [fx!.orgId, userId]);
  return row?.is_active === true;
}

/** A transaction id (txid_current_if_assigned, with its epoch) as the 32-bit xid a row's xmin shows. */
const xid = (txid: string) => (BigInt(txid) % 4294967296n).toString();

/** The recorded in-transaction change equal to `expected`, which must have run in a transaction. */
function lossRecorded(expected: DocumentAccessChange): { txid: string } {
  const found = lossesInTx.find((loss) => isDeepStrictEqual(loss.change, expected));
  assert.ok(found, `applyAccessLossInTx ran for ${JSON.stringify(expected)}; saw ${JSON.stringify(lossesInTx)}`);
  assert.ok(found.txid, 'the hook ran inside the transaction that made the change');
  assert.ok(accessChanges.some((change) => isDeepStrictEqual(change, expected)), `finishAccessLoss emitted ${JSON.stringify(expected)}`);
  return { txid: found.txid };
}

const withoutManager = async (userId: string) => call(userId, 'GET', '/api/drives/without-manager', undefined, 200) as Promise<{
  drives: Array<Record<string, any>>;
}>;

const frozenList = async (userId: string) => (await call(userId, 'GET', '/api/drives/frozen', undefined, 200)).drives as Array<Record<string, any>>;

/** The handover notices `userId` holds for `driveId`. */
async function handoverNotices(userId: string, driveId: string): Promise<Array<Record<string, any>>> {
  const { rows } = await fx!.client.query(`SELECT type::text AS type, title, link,
      jsonb_build_object('subtype', metadata->>'subtype', 'drive_id', metadata->>'drive_id') AS metadata FROM notifications
    WHERE org_id = $1 AND user_id = $2 AND metadata->>'drive_id' = $3 AND metadata->>'subtype' = 'handover'`, [fx!.orgId, userId, driveId]);
  return rows;
}

test('removing a member with a replacement hands their personal drive to the replacement as a private drive with full access, audited', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member2, owner } = fx.people;
  const leaver = await person('Priya Leaver');
  const replacement = await person('Rahul Replacement');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: leaver, name: 'My drive' });
  await fx.addDriveMember(drive, { user: member2 }, 'comment');
  const doc = await fx.insertDocument({ driveId: drive, title: 'Plans' });
  const departedPrivate = await fx.insertDrive({ kind: 'private', name: 'Their private drive' });
  await fx.addDriveMember(departedPrivate, { user: leaver }, 'full');

  resetEvents();
  const generation = currentAccessGeneration();
  await call(owner, 'DELETE', `/api/members/${leaver}`, { replacement_user_id: replacement }, 200);

  const state = await driveState(drive);
  assert.equal(state.kind, 'private');
  assert.equal(state.owner_user_id, null);
  assert.equal(state.frozen, false);
  assert.equal(state.name, "Priya Leaver's drive");
  assert.equal(state.is_deleted, false);
  assert.deepEqual(await membersOf(drive), [[member2, 'comment'], [replacement, 'full']].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    'the departed person’s row is gone; the replacement holds full; other members stay');
  assert.equal(await driveRoleFor(replacement, fx.orgId, drive), 'full');
  assert.equal(await documentRoleFor(replacement, fx.orgId, doc), 'full');
  assert.equal(await driveRoleFor(leaver, fx.orgId, drive), null);
  assert.equal(await driveRoleFor(member2, fx.orgId, drive), 'comment');
  assert.equal((await driveState(departedPrivate)).frozen, false, 'only the personal drive is handed on');
  const notices = await handoverNotices(replacement, drive);
  assert.equal(notices.length, 1, 'the replacement is told');
  assert.equal(notices[0]!.type, 'document_shared');
  assert.deepEqual(notices[0]!.metadata, { subtype: 'handover', drive_id: drive });
  assert.equal(notices[0]!.link, `/drive/${drive}`);

  const audits = await auditsOf(drive, 'drive_handed_over');
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actor_type, 'user');
  assert.equal(audits[0]!.actor_id, owner);
  assert.equal(audits[0]!.entity_type, 'drive');
  assert.equal(audits[0]!.metadata.from_user_id, leaver);
  assert.equal(audits[0]!.metadata.to_user_id, replacement);
  assert.equal(audits[0]!.metadata.via, 'removal');
  assert.equal(audits[0]!.before_state.kind, 'personal');
  assert.equal(audits[0]!.after_state.kind, 'private');
  assert.equal(audits[0]!.xmin, state.xmin, 'the audit row commits with the handover');

  // Rule C3: the handover and the departure, both in the removal's transaction.
  const handover = lossRecorded({ orgId: fx.orgId, driveId: drive, documentIds: [doc] });
  const departure = lossRecorded({ orgId: fx.orgId, userIds: [leaver] });
  assert.equal(handover.txid, departure.txid, 'one transaction');
  assert.equal(xid(handover.txid), state.xmin, 'the transaction that changed the drive');
  assert.ok(currentAccessGeneration() > generation);
});

test('a removal whose replacement can’t hold access fails with 400 PRINCIPAL_CANNOT_HOLD_ACCESS and commits nothing', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { owner } = fx.people;
  const leaver = await person('Stays For Now');
  const noEmployeeAgent = await fx.addPerson({ kind: 'agent' }); // an active member that can never hold access, as Defty's own user
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: leaver });
  const teamId = randomUUID();
  await fx.client.query('INSERT INTO teams (id, org_id, name, handle, lead_user_id) VALUES ($1, $2, $3, $4, $5)',
    [teamId, fx.orgId, 'Led by the leaver', `led-${teamId.slice(0, 8)}`, leaver]);
  try {
    const before = await driveState(drive);
    resetEvents();
    const refused = await call(owner, 'DELETE', `/api/members/${leaver}`, { replacement_user_id: noEmployeeAgent }, 400);
    assert.equal(refused.code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
    assert.equal(typeof refused.error, 'string');
    assert.equal(await isActiveMember(leaver), true, 'still a member');
    assert.deepEqual(await driveState(drive), before, 'the drive is untouched');
    assert.deepEqual(await membersOf(drive), [[leaver, 'full']]);
    const { rows: [team] } = await fx.client.query('SELECT lead_user_id FROM teams WHERE id = $1', [teamId]);
    assert.equal(team.lead_user_id, leaver, 'their work did not move');
    assert.deepEqual(await auditsOf(drive, 'drive_handed_over'), []);
    assert.deepEqual(accessChanges, [], 'nothing finished after a rollback');
  } finally {
    await fx.client.query('DELETE FROM team_members WHERE team_id = $1', [teamId]);
    await fx.client.query('DELETE FROM teams WHERE id = $1', [teamId]);
  }
});

test('removing a member with no replacement freezes their personal drive', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { owner } = fx.people;
  const leaver = await person('Frozen Leaver');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: leaver, name: 'My drive' });
  const doc = await fx.insertDocument({ driveId: drive, title: 'Notes' });
  const otherDrive = await fx.insertDrive({ kind: 'private', name: 'Not theirs alone' });
  await fx.addDriveMember(otherDrive, { user: leaver }, 'full');

  resetEvents();
  const generation = currentAccessGeneration();
  await call(owner, 'DELETE', `/api/members/${leaver}`, {}, 200);

  const state = await driveState(drive);
  assert.equal(state.kind, 'personal');
  assert.equal(state.owner_user_id, leaver);
  assert.equal(state.frozen, true);
  assert.equal(state.name, 'My drive');
  assert.deepEqual(await membersOf(drive), [[leaver, 'full']], 'the rows stay; the freeze is what ends them');
  assert.equal((await driveState(otherDrive)).frozen, false, 'only personal drives freeze');
  assert.deepEqual(await auditsOf(drive, 'drive_handed_over'), []);

  const freeze = lossRecorded({ orgId: fx.orgId, driveId: drive, documentIds: [doc] });
  const departure = lossRecorded({ orgId: fx.orgId, userIds: [leaver] });
  assert.equal(freeze.txid, departure.txid, 'one transaction');
  assert.equal(xid(freeze.txid), state.xmin, 'the transaction that froze the drive');
  assert.ok(currentAccessGeneration() > generation);
});

test('nobody can browse or edit a frozen drive, owners and admins included', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2, owner } = fx.people;
  const departed = await person('Long Gone');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: departed, name: 'My drive' });
  await fx.addDriveMember(drive, { user: member2 }, 'edit');
  const doc = await fx.insertDocument({ driveId: drive, title: 'Inside' });
  await call(owner, 'DELETE', `/api/members/${departed}`, {}, 200);
  assert.equal((await driveState(drive)).frozen, true);

  for (const who of [owner, admin, member2, member]) {
    assert.equal(await driveRoleFor(who, fx.orgId, drive), null, who);
    assert.equal(await documentRoleFor(who, fx.orgId, doc), null, who);
    const listed = (await call(who, 'GET', '/api/drives', undefined, 200)).drives as Array<Record<string, any>>;
    assert.equal(listed.find((row) => row.id === drive), undefined, 'not listed');
    for (const [method, path, body] of [
      ['GET', '', undefined],
      ['PATCH', '', { name: 'Renamed' }],
      ['DELETE', '', undefined],
      ['GET', '/members', undefined],
      ['POST', '/members', { principal_type: 'user', principal_id: member, role: 'view' }],
      ['POST', '/link-space', { space_id: fx.spaces.team, role: 'view' }],
      ['POST', '/pin', undefined],
    ] as const) {
      assert.equal((await call(who, method, `/api/drives/${drive}${path}`, body, 404)).code, 'NOT_FOUND', `${method} ${path}`);
    }
  }
  const state = await driveState(drive);
  assert.equal(state.name, 'My drive');
  assert.equal(state.is_deleted, false);
  assert.deepEqual(await membersOf(drive), [[departed, 'full'], [member2, 'edit']].sort((a, b) => a[0]!.localeCompare(b[0]!)));
});

test('a document shared out of a frozen drive stays readable, view-only, even if the share said edit', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2, owner } = fx.people;
  const departed = await person('Shared Before Leaving');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: departed });
  const sharedWithPerson = await fx.insertDocument({ driveId: drive, title: 'Shared with a person' });
  const sharedWithChat = await fx.insertDocument({ driveId: drive, title: 'Shared with a chat' });
  const notShared = await fx.insertDocument({ driveId: drive, title: 'Not shared' });
  await fx.share(sharedWithPerson, { user: member }, 'edit');
  await fx.share(sharedWithChat, { space: fx.spaces.team }, 'edit');
  assert.equal(await documentRoleFor(member, fx.orgId, sharedWithPerson), 'edit');

  await call(owner, 'DELETE', `/api/members/${departed}`, {}, 200);
  assert.equal(await documentRoleFor(member, fx.orgId, sharedWithPerson), 'view');
  for (const inChat of [member, member2, guest]) assert.equal(await documentRoleFor(inChat, fx.orgId, sharedWithChat), 'view', inChat);
  for (const who of [member, owner]) assert.equal(await documentRoleFor(who, fx.orgId, notShared), null, who);
  assert.equal(await driveRoleFor(member, fx.orgId, drive), null, 'a share gives no role on the drive');
});

test('an owner hands a frozen drive to someone; an admin gets 403 OWNER_ONLY', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, guest, member, owner } = fx.people;
  const departed = await person('Asha Departed');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: departed });
  const doc = await fx.insertDocument({ driveId: drive, title: 'Handed on' });
  await fx.share(doc, { user: guest }, 'edit');
  await call(owner, 'DELETE', `/api/members/${departed}`, {}, 200);
  const frozen = await driveState(drive);
  assert.equal(frozen.frozen, true);
  assert.equal(await documentRoleFor(guest, fx.orgId, doc), 'view');

  // Only the owner sees the frozen drive listed, with the departed person.
  const listed = (await frozenList(owner)).find((row) => row.id === drive);
  assert.ok(listed, 'listed as frozen');
  assert.deepEqual(listed.former_owner, { id: departed, name: 'Asha Departed' });
  assert.equal(typeof listed.frozen_at, 'string');
  assert.deepEqual(Object.keys(listed).sort(), ['former_owner', 'frozen_at', 'id']);
  for (const who of [admin, member, guest]) {
    assert.equal((await call(who, 'GET', '/api/drives/frozen', undefined, 403)).code, 'OWNER_ONLY', who);
  }
  assert.equal('frozen_drives' in (await withoutManager(owner)), false, 'not in the admins’ list');

  for (const who of [admin, member, guest]) {
    assert.equal((await call(who, 'POST', `/api/drives/${drive}/handover`, { user_id: member }, 403)).code, 'OWNER_ONLY', who);
  }
  assert.deepEqual(await driveState(drive), frozen, 'untouched');
  const noEmployeeAgent = await fx.addPerson({ kind: 'agent' });
  assert.equal((await call(owner, 'POST', `/api/drives/${drive}/handover`, { user_id: noEmployeeAgent }, 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  assert.equal((await call(owner, 'POST', `/api/drives/${drive}/handover`, { user_id: departed }, 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS',
    'someone who left can’t hold it');
  assert.equal((await call(owner, 'POST', `/api/drives/${drive}/handover`, {}, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await call(owner, 'POST', `/api/drives/${randomUUID()}/handover`, { user_id: member }, 404)).code, 'NOT_FOUND');
  assert.equal((await call(owner, 'POST', `/api/drives/${fx.workspaceDriveId}/handover`, { user_id: member }, 409)).code, 'DRIVE_NOT_FROZEN');
  const livePersonal = await fx.insertDrive({ kind: 'personal', ownerUserId: fx.people.member2 });
  assert.equal((await call(owner, 'POST', `/api/drives/${livePersonal}/handover`, { user_id: member }, 409)).code, 'DRIVE_NOT_FROZEN');
  assert.deepEqual(await driveState(drive), frozen, 'still untouched');

  resetEvents();
  const generation = currentAccessGeneration();
  const handed = await call(owner, 'POST', `/api/drives/${drive}/handover`, { user_id: member }, 200);
  assert.equal(handed.drive.id, drive);
  assert.equal(handed.drive.kind, 'private');
  assert.equal(handed.drive.name, "Asha Departed's drive");
  assert.equal(handed.drive.frozen, false);

  const state = await driveState(drive);
  assert.equal(state.kind, 'private');
  assert.equal(state.owner_user_id, null);
  assert.equal(state.frozen, false);
  assert.equal(state.name, "Asha Departed's drive");
  assert.deepEqual(await membersOf(drive), [[member, 'full']]);
  assert.equal(await driveRoleFor(member, fx.orgId, drive), 'full');
  assert.equal(await documentRoleFor(member, fx.orgId, doc), 'full');
  assert.equal(await documentRoleFor(guest, fx.orgId, doc), 'edit', 'the share gives its own role again');
  assert.equal(await driveRoleFor(owner, fx.orgId, drive), null, 'the owner who handed it on holds nothing');
  assert.equal((await frozenList(owner)).find((row) => row.id === drive), undefined);
  assert.deepEqual((await handoverNotices(member, drive)).map((row) => row.metadata), [{ subtype: 'handover', drive_id: drive }],
    'the new holder is told');

  const audits = await auditsOf(drive, 'drive_handed_over');
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actor_id, owner);
  assert.equal(audits[0]!.metadata.from_user_id, departed);
  assert.equal(audits[0]!.metadata.to_user_id, member);
  assert.equal(audits[0]!.metadata.via, 'handover');
  assert.equal(audits[0]!.xmin, state.xmin, 'the audit row commits with the handover');
  const handover = lossRecorded({ orgId: fx.orgId, driveId: drive, documentIds: [doc] });
  assert.equal(xid(handover.txid), state.xmin);
  assert.ok(currentAccessGeneration() > generation);

  // Only once: it is no longer a frozen personal drive.
  assert.equal((await call(owner, 'POST', `/api/drives/${drive}/handover`, { user_id: fx.people.member2 }, 409)).code, 'DRIVE_NOT_FROZEN');
});

test('a private drive whose last full member leaves is listed under drives without a manager; an admin makes a member the manager, audited', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2, owner } = fx.people;
  const leaver = await person('Last Manager');
  const created = await call(leaver, 'POST', '/api/drives', { name: 'Orphaned plans', kind: 'private' }, 201);
  const drive = created.drive.id as string;
  await call(leaver, 'POST', `/api/drives/${drive}/members`, { principal_type: 'user', principal_id: member2, role: 'edit' }, 201);
  const managed = await fx.insertDrive({ kind: 'private', name: 'Still managed' });
  await fx.addDriveMember(managed, { user: member }, 'full');

  const before = await withoutManager(admin);
  assert.equal(before.drives.find((row) => row.id === drive), undefined, 'managed while its full member is here');

  await call(owner, 'DELETE', `/api/members/${leaver}`, {}, 200);
  for (const who of [owner, admin]) {
    const { drives } = await withoutManager(who);
    const listed = drives.find((row) => row.id === drive);
    assert.ok(listed, `listed for ${who}`);
    assert.equal(listed.name, 'Orphaned plans');
    assert.equal(listed.member_count, 2);
    assert.equal(drives.find((row) => row.id === managed), undefined);
    assert.equal(drives.find((row) => row.id === fx!.workspaceDriveId), undefined, 'open drives are managed by owners and admins');
  }
  for (const who of [member, member2, fx.people.guest]) {
    assert.equal((await call(who, 'GET', '/api/drives/without-manager', undefined, 403)).code, 'FORBIDDEN', who);
  }
  assert.equal(await driveRoleFor(member2, fx.orgId, drive), 'edit', 'it keeps working for its other members');

  const { rows: [row] } = await fx.client.query('SELECT id FROM drive_members WHERE drive_id = $1 AND principal_id = $2', [drive, member2]);
  const promoted = await call(admin, 'PATCH', `/api/drives/${drive}/members/${row.id}`, { role: 'full' }, 200);
  assert.equal(promoted.member.role, 'full');
  assert.equal(await driveRoleFor(member2, fx.orgId, drive), 'full');
  const audits = await auditsOf(drive, 'drive_member_changed_by_admin');
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actor_id, admin);
  assert.equal(audits[0]!.metadata.change, 'role_changed');
  assert.equal(audits[0]!.metadata.principal_id, member2);
  assert.equal(audits[0]!.metadata.role, 'full');
  assert.equal((await withoutManager(admin)).drives.find((listed) => listed.id === drive), undefined, 'no longer listed');
});

test('revoking a not-yet-accepted invite that deactivates its user freezes that user\'s personal drive', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { owner } = fx.people;
  const invitee = await person('Never Joined');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: invitee });
  const doc = await fx.insertDocument({ driveId: drive, title: 'Draft' });
  const { rows: [account] } = await fx.client.query('SELECT email, password_hash FROM users WHERE id = $1', [invitee]);
  assert.equal(account.password_hash, null, 'an invitee who has not set a password yet');
  const inviteId = randomUUID();
  await fx.client.query(`INSERT INTO invites (id, org_id, email, token, invited_by, expires_at)
    VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`, [inviteId, fx.orgId, account.email, `not-a-jwt-${inviteId}`, owner]);
  try {
    resetEvents();
    const generation = currentAccessGeneration();
    await call(owner, 'DELETE', `/api/members/invites/${inviteId}`, undefined, 200);
    assert.equal(await isActiveMember(invitee), false, 'the revocation deactivated them');
    const state = await driveState(drive);
    assert.equal(state.frozen, true);
    assert.equal(state.kind, 'personal');
    const freeze = lossRecorded({ orgId: fx.orgId, driveId: drive, documentIds: [doc] });
    const departure = lossRecorded({ orgId: fx.orgId, userIds: [invitee] });
    assert.equal(freeze.txid, departure.txid);
    assert.equal(xid(freeze.txid), state.xmin);
    assert.ok(currentAccessGeneration() > generation);
  } finally {
    await fx.client.query('DELETE FROM invites WHERE id = $1', [inviteId]);
  }
});

test('a private drive whose only full member was deactivated is listed without a manager', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member2, owner } = fx.people;
  const manager = await person('Deactivated Manager');
  const drive = await fx.insertDrive({ kind: 'private', name: 'Deactivated manager’s drive' });
  await fx.addDriveMember(drive, { user: manager }, 'full');
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  // A chat holding full, with someone active in it, is not a manager (rule C5).
  const chatOnly = await fx.insertDrive({ kind: 'private', name: 'Only a chat holds full' });
  await fx.addDriveMember(chatOnly, { space: fx.spaces.other }, 'full');
  // An agent whose employee is paused manages nothing.
  const employeeId = randomUUID();
  const agent = await fx.addPerson({ kind: 'agent', agentEmployeeId: employeeId });
  const agentManaged = await fx.insertDrive({ kind: 'private', name: 'Paused agent’s drive' });
  await fx.addDriveMember(agentManaged, { user: agent }, 'full');

  let listed = (await withoutManager(admin)).drives.map((row) => row.id);
  assert.equal(listed.includes(drive), false);
  assert.equal(listed.includes(agentManaged), false, 'an active agent employee manages its drive');
  assert.ok(listed.includes(chatOnly), 'a chat holding full manages nothing, even with member2 active in it');

  await fx.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx.orgId, manager]);
  await fx.client.query('UPDATE agent_employees SET is_active = false WHERE id = $1', [employeeId]);
  listed = (await withoutManager(owner)).drives.map((row) => row.id);
  assert.ok(listed.includes(drive), 'the full row stays, but its holder is no longer an active member');
  assert.ok(listed.includes(agentManaged), 'the agent is paused');
  assert.ok(listed.includes(chatOnly));
});

test('deleting an agent employee freezes its personal drive', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { owner } = fx.people;
  const employeeId = randomUUID();
  const agent = await fx.addPerson({ kind: 'agent', agentEmployeeId: employeeId });
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: agent });
  assert.equal(await driveRoleFor(agent, fx.orgId, drive), 'full');
  resetEvents();
  await call(owner, 'DELETE', `/api/agent-employees/${employeeId}`, undefined, 200);
  const state = await driveState(drive);
  assert.equal(state.frozen, true);
  const freeze = lossRecorded({ orgId: fx.orgId, driveId: drive, documentIds: [] });
  const departure = lossRecorded({ orgId: fx.orgId, userIds: [agent] });
  assert.equal(freeze.txid, departure.txid);
});

type Received = Array<{ event: string; data: any }>;

/** Sockets for people of the fixture's workspace, through the real socket server (as drives-http-db.test.ts). */
async function socketHarness(people: string[]) {
  const server = createServer();
  const principals = new Map(people.map((id) => [`token-${id}`, { id, email: `${id}@drives.test`, org_id: fx!.orgId, sid: `sid-${id}`, exp: Math.floor(Date.now() / 1000) + 600 }]));
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => {
      const principal = principals.get(token);
      if (!principal) throw new Error('unknown token');
      return principal as any;
    },
    getSpaceAccess: async () => undefined,
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const clients: any[] = [];
  const received = new Map<string, Received>();
  for (const id of people) {
    const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token: `token-${id}` }, transports: ['websocket'], reconnection: false });
    clients.push(client);
    const events: Received = [];
    received.set(id, events);
    client.onAny((event: string, data: unknown) => events.push({ event, data }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`presence:init timed out for ${id}`)), 5_000);
      client.once('presence:init', () => { clearTimeout(timer); resolve(); });
    });
  }
  return {
    updates: (id: string) => received.get(id)!.filter((entry) => entry.event === 'document:updated').map((entry) => entry.data),
    close: async () => {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `timed out: ${label}`);
}

test('freezing and handing over send document:updated to the documents’ current viewers only', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, guest, member, member2, owner } = fx.people;
  const departed = await person('Told Of');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: departed });
  const doc = await fx.insertDocument({ driveId: drive, title: 'Watched' });
  await fx.share(doc, { user: guest }, 'comment');
  const harness = await socketHarness([owner, admin, member, member2, guest]);
  try {
    const expected = { id: doc, drive_id: drive };
    await call(owner, 'DELETE', `/api/members/${departed}`, {}, 200);
    await waitFor(() => harness.updates(guest).length > 0, 'the share holder is told of the freeze');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(harness.updates(guest), [expected]);
    for (const outside of [owner, admin, member, member2]) assert.deepEqual(harness.updates(outside), [], 'nobody else can view it');

    await call(owner, 'POST', `/api/drives/${drive}/handover`, { user_id: member }, 200);
    await waitFor(() => harness.updates(member).length > 0, 'the new holder is told');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(harness.updates(member), [expected]);
    assert.deepEqual(harness.updates(guest), [expected, expected]);
    for (const outside of [owner, admin, member2]) assert.deepEqual(harness.updates(outside), [], 'still nobody else');
  } finally {
    await harness.close();
  }
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────

/** A second connection, for holding locks while a request runs. */
async function lockHolder(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url!, connectionTimeoutMillis: 3000 });
  await client.connect();
  return client;
}

/** Waits until at least `n` backends of this database wait on a lock (a row, a transaction or an advisory lock). */
async function waitForLockWaiters(n: number, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows: [row] } = await fx!.client.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (row.n >= n) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${n} lock waiter(s): ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The room-access lock key (lib/room-access-lock.ts), as SQL text and its one parameter. */
const ROOM_LOCK = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const roomLockKey = (orgId: string, userId: string) => `deft-room-access:${orgId}:${userId}`;

test('a returning member’s frozen drive stays frozen when an admin removes them with a replacement', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member2, owner } = fx.people;
  const returning = await person('Came Back');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: returning, name: 'My drive' });
  const doc = await fx.insertDocument({ driveId: drive, title: 'Old work' });
  await call(owner, 'DELETE', `/api/members/${returning}`, {}, 200);
  const frozen = await driveState(drive);
  assert.equal(frozen.frozen, true);
  // They come back (as accepting a new invite does); the old drive is still frozen.
  await fx.client.query('UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2', [fx.orgId, returning]);
  const preview = await call(admin, 'GET', `/api/members/${returning}/offboarding-preview`, undefined, 200);
  assert.equal(preview.personal_drive_with_documents, false, 'a frozen drive is not offered for a handover');

  resetEvents();
  await call(admin, 'DELETE', `/api/members/${returning}`, { replacement_user_id: member2 }, 200);
  assert.equal(await isActiveMember(returning), false);
  assert.deepEqual(await driveState(drive), frozen, 'still frozen, still theirs: only the owner unfreezes it');
  assert.deepEqual(await membersOf(drive), [[returning, 'full']]);
  assert.equal(await driveRoleFor(member2, fx.orgId, drive), null);
  assert.equal(await documentRoleFor(member2, fx.orgId, doc), null);
  assert.deepEqual(await auditsOf(drive, 'drive_handed_over'), []);
  assert.deepEqual(await handoverNotices(member2, drive), []);
  assert.equal(lossesInTx.some((loss) => loss.change.driveId === drive), false, 'nothing to freeze or hand over');
  // The owner still can.
  await call(owner, 'POST', `/api/drives/${drive}/handover`, { user_id: member2 }, 200);
  assert.equal(await driveRoleFor(member2, fx.orgId, drive), 'full');
});

test('a removal that waited for another finds the member gone and hands nothing over', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member2, owner } = fx.people;
  const leaver = await person('Removed Twice');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: leaver, name: 'My drive' });
  await fx.insertDocument({ driveId: drive, title: 'Work' });
  const holder = await lockHolder();
  try {
    // Hold the leaver's room-access lock, so both removals queue behind it in order.
    await holder.query('BEGIN');
    await holder.query(ROOM_LOCK, [roomLockKey(fx.orgId, leaver)]);
    const first = fx.request(owner, 'DELETE', `/api/members/${leaver}`, {});
    await waitForLockWaiters(1, 'the first removal waits');
    const second = fx.request(admin, 'DELETE', `/api/members/${leaver}`, { replacement_user_id: member2 });
    await waitForLockWaiters(2, 'the second removal waits behind it');
    await holder.query('COMMIT');
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.status, 200, await one.clone().text());
    const refused = await json(two);
    assert.equal(two.status, 404, JSON.stringify(refused));
    assert.equal(refused.code, 'NOT_FOUND');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
  const state = await driveState(drive);
  assert.equal(state.frozen, true, 'the first removal froze it');
  assert.equal(state.kind, 'personal');
  assert.equal(await driveRoleFor(member2, fx.orgId, drive), null, 'the second handed nothing over');
  assert.deepEqual(await auditsOf(drive, 'drive_handed_over'), []);
});

test('with a drive to hand over, an inactive or outside replacement gets 400 PRINCIPAL_CANNOT_HOLD_ACCESS; without one, VALIDATION_ERROR as before', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { outsider, owner } = fx.people;
  const inactive = await fx.addPerson({ active: false });
  const withDrive = await person('Has A Drive');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: withDrive, name: 'My drive' });
  const before = await driveState(drive);
  for (const replacement of [inactive, outsider, randomUUID()]) {
    const refused = await call(owner, 'DELETE', `/api/members/${withDrive}`, { replacement_user_id: replacement }, 400);
    assert.equal(refused.code, 'PRINCIPAL_CANNOT_HOLD_ACCESS', replacement);
  }
  assert.equal(await isActiveMember(withDrive), true);
  assert.deepEqual(await driveState(drive), before);

  // Freezing it instead needs no eligible holder: the old rule answers.
  const frozenChoice = await call(owner, 'DELETE', `/api/members/${withDrive}`, { replacement_user_id: inactive, personal_drive: 'freeze' }, 400);
  assert.equal(frozenChoice.code, 'VALIDATION_ERROR');
  const noDrive = await person('Has No Drive');
  assert.equal((await call(owner, 'DELETE', `/api/members/${noDrive}`, { replacement_user_id: inactive }, 400)).code, 'VALIDATION_ERROR');
  assert.equal(await isActiveMember(noDrive), true);
});

test('a replacement deactivated, or an agent replacement paused, while the removal waits is refused: their rows are locked before the check', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { owner } = fx.people;
  const employeeId = randomUUID();
  const agent = await fx.addPerson({ kind: 'agent', agentEmployeeId: employeeId });
  const human = await person('About To Leave Too');
  const cases: Array<[string, string, string, unknown[]]> = [
    ['a person deactivated', human, 'UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx.orgId, human]],
    ['an agent paused', agent, 'UPDATE agent_employees SET is_active = false WHERE id = $1', [employeeId]],
  ];
  for (const [label, replacement, change, values] of cases) {
    const leaver = await person(`Leaving, ${label}`);
    const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: leaver, name: 'My drive' });
    const holder = await lockHolder();
    try {
      await holder.query('BEGIN');
      await holder.query(change, values);
      let settled = false;
      const removal = fx.request(owner, 'DELETE', `/api/members/${leaver}`, { replacement_user_id: replacement }).finally(() => { settled = true; });
      await waitForLockWaiters(1, `${label}: the removal waits on the replacement's row`);
      assert.equal(settled, false, `${label}: still waiting`);
      await holder.query('COMMIT');
      const res = await removal;
      const body = await json(res);
      assert.equal(res.status, 400, `${label}: ${JSON.stringify(body)}`);
      assert.equal(body.code, 'PRINCIPAL_CANNOT_HOLD_ACCESS', label);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
    assert.equal(await isActiveMember(leaver), true, label);
    assert.equal((await driveState(drive)).kind, 'personal', label);
    assert.deepEqual(await membersOf(drive), [[leaver, 'full']], label);
  }
});

test('the remover chooses: personal_drive freeze keeps it from the replacement; hand_over needs a replacement', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member2, owner } = fx.people;
  const leaver = await person('Chose Freeze');
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: leaver, name: 'My drive' });
  await fx.insertDocument({ driveId: drive, title: 'Private thoughts' });
  assert.equal((await call(owner, 'DELETE', `/api/members/${leaver}`, { personal_drive: 'hand_over' }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await call(owner, 'DELETE', `/api/members/${leaver}`, { replacement_user_id: member2, personal_drive: 'elsewhere' }, 400)).code,
    'VALIDATION_ERROR');
  assert.equal(await isActiveMember(leaver), true);
  await call(owner, 'DELETE', `/api/members/${leaver}`, { replacement_user_id: member2, personal_drive: 'freeze' }, 200);
  const state = await driveState(drive);
  assert.equal(state.frozen, true);
  assert.equal(state.kind, 'personal');
  assert.equal(await driveRoleFor(member2, fx.orgId, drive), null);
  assert.deepEqual(await auditsOf(drive, 'drive_handed_over'), []);
});

test('the offboarding preview says whether the member has a personal drive with a document in it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin } = fx.people;
  const preview = async (userId: string) => (await call(admin, 'GET', `/api/members/${userId}/offboarding-preview`, undefined, 200))
    .personal_drive_with_documents;
  const noDrive = await person('No Drive At All');
  assert.equal(await preview(noDrive), false);
  const emptyDrive = await person('Empty Drive');
  const empty = await fx.insertDrive({ kind: 'personal', ownerUserId: emptyDrive, name: 'My drive' });
  await fx.insertDocument({ driveId: empty, title: 'Binned', deleted: true });
  assert.equal(await preview(emptyDrive), false, 'deleted documents don’t count');
  const busy = await person('Busy Drive');
  const busyDrive = await fx.insertDrive({ kind: 'personal', ownerUserId: busy, name: 'My drive' });
  await fx.insertDocument({ driveId: busyDrive, title: 'Live' });
  assert.equal(await preview(busy), true);
});

test('archiving a duplicate pilot agent (the pilot seed) freezes its personal drive through the departure seam', async (t) => {
  if (!fx) return t.skip(SKIP);
  const employeeId = randomUUID();
  const agent = await fx.addPerson({ kind: 'agent', agentEmployeeId: employeeId });
  await fx.client.query(`UPDATE agent_employees SET name = 'Tom 1' WHERE id = $1`, [employeeId]);
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: agent, name: 'My drive' });
  const doc = await fx.insertDocument({ driveId: drive, title: 'Agent notes' });
  resetEvents();
  await cleanDuplicatePilotAgents(fx.orgId);
  const { rows: [employee] } = await fx.client.query('SELECT is_active, is_deleted FROM agent_employees WHERE id = $1', [employeeId]);
  assert.deepEqual(employee, { is_active: false, is_deleted: true });
  assert.equal(await isActiveMember(agent), false);
  const state = await driveState(drive);
  assert.equal(state.frozen, true);
  const freeze = lossRecorded({ orgId: fx.orgId, driveId: drive, documentIds: [doc] });
  const departure = lossRecorded({ orgId: fx.orgId, userIds: [agent] });
  assert.equal(freeze.txid, departure.txid, 'one transaction');
  assert.equal(xid(freeze.txid), state.xmin);
});

test('linking a chat takes the linker’s room-access lock first, so it never deadlocks with their removal', async (t) => {
  if (!fx) return t.skip(SKIP);
  const linker = await person('Links While Leaving');
  await fx.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), fx.spaces.team, linker]);
  const drive = await fx.insertDrive({ kind: 'private', name: 'To be linked' });
  await fx.addDriveMember(drive, { user: linker }, 'full');
  const holder = await lockHolder();
  try {
    // As a removal does (routes/members.ts): the room-access lock, the chat
    // seats deleted, then the person's drive row updated.
    await holder.query('BEGIN');
    await holder.query(ROOM_LOCK, [roomLockKey(fx.orgId, linker)]);
    await holder.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [fx.spaces.team, linker]);
    const link = fx.request(linker, 'POST', `/api/drives/${drive}/link-space`, { space_id: fx.spaces.team, role: 'view' });
    await waitForLockWaiters(1, 'the link waits');
    await holder.query(`SET LOCAL lock_timeout = '3s'`);
    await holder.query('UPDATE drives SET updated_at = now() WHERE id = $1', [drive]);
    await holder.query('COMMIT');
    const res = await link;
    const body = await json(res);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(body.code, 'SPACE_MEMBERSHIP_REQUIRED', 'it ran after the removal, which took the seat away');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
  const { rows } = await fx.client.query('SELECT count(*)::int AS n FROM drive_members WHERE drive_id = $1 AND is_link', [drive]);
  assert.equal(rows[0].n, 0);
});
