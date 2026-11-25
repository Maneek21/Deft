/**
 * Departed members and their drives (spec 5.2; plan Task F6; consult rules
 * C3, C4 and C5), over HTTP:
 * - every way out of the workspace (removal, the deactivation an invite
 *   revocation makes, deleting an agent employee) freezes the person's
 *   personal drive, through the one departure seam
 *   (lib/drives.ts endDriveAccessOnDepartureInTx);
 * - removal with a replacement hands the drive to the replacement instead;
 * - an owner hands a frozen drive on (POST /api/drives/:id/handover);
 * - owners and admins list the private drives nobody can manage
 *   (GET /api/drives/without-manager).
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
  drives: Array<Record<string, any>>; frozen_drives: Array<Record<string, any>>;
}>;

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

  // Owners and admins see the frozen drive listed, with the departed person's name.
  for (const who of [owner, admin]) {
    const listed = (await withoutManager(who)).frozen_drives.find((row) => row.id === drive);
    assert.ok(listed, 'listed as frozen');
    assert.equal(listed.former_owner_id, departed);
    assert.equal(listed.former_owner_name, 'Asha Departed');
  }

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
  assert.equal((await withoutManager(owner)).frozen_drives.find((row) => row.id === drive), undefined);

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
  // A chat holding full, with someone active in it, manages its drive.
  const chatManaged = await fx.insertDrive({ kind: 'private', name: 'Managed through a chat' });
  await fx.addDriveMember(chatManaged, { space: fx.spaces.other }, 'full');
  // An agent whose employee is paused manages nothing.
  const employeeId = randomUUID();
  const agent = await fx.addPerson({ kind: 'agent', agentEmployeeId: employeeId });
  const agentManaged = await fx.insertDrive({ kind: 'private', name: 'Paused agent’s drive' });
  await fx.addDriveMember(agentManaged, { user: agent }, 'full');

  let listed = (await withoutManager(admin)).drives.map((row) => row.id);
  assert.equal(listed.includes(drive), false);
  assert.equal(listed.includes(agentManaged), false, 'an active agent employee manages its drive');

  await fx.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx.orgId, manager]);
  await fx.client.query('UPDATE agent_employees SET is_active = false WHERE id = $1', [employeeId]);
  listed = (await withoutManager(owner)).drives.map((row) => row.id);
  assert.ok(listed.includes(drive), 'the full row stays, but its holder is no longer an active member');
  assert.ok(listed.includes(agentManaged), 'the agent is paused');
  assert.equal(listed.includes(chatManaged), false, 'member2 is active in the chat that holds full');
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
