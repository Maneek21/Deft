/**
 * Drives and their members over HTTP (routes/drives.ts, lib/drives.ts), with
 * the owner and admin rules (spec 5.2), and the access-loss path (consult
 * rule C3, lib/document-access-change.ts) wired into the drive routes,
 * routes/spaces.ts and routes/members.ts. Events follow rule C4.
 *
 * Every access-lowering change is watched through an `onAccessLossInTx` hook
 * registered once for the file: it records each change together with the
 * transaction id it ran in (`txid_current_if_assigned()`, which is set only
 * inside a transaction that has already written), so a recorded id shows the
 * hook ran inside the change's own transaction, before commit.
 *
 * Fix round 1 adds: agent employees paused, resumed and deleted (REST and
 * MCP); document:updated sent only to each current viewer, never to the
 * members room (non-guest agents without a grant included), and nothing
 * after a drive is deleted; admin changes audited in their own transaction
 * and told to every human member; drive notifications that disappear with
 * drive access; the link rule on every endpoint; grants raised only to
 * people who can hold access; chat checks on the drive transaction; personal
 * drives kept; drive_member notifications.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/drives-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import test, { after, before } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { driveRoleFor, documentRoleFor } from '../src/lib/document-access.js';
import { emitDocumentUpdated, onDocumentAccessChanged, type DocumentAccessChange } from '../src/lib/document-access-events.js';
import { currentAccessGeneration, onAccessLossInTx } from '../src/lib/document-access-change.js';
import { onDocumentEvent, type DocumentLifecycleEvent } from '../src/lib/document-events.js';
import { ensurePersonalDrive, ensureSharedNotesDrive, ensureWorkspaceDrive, PrincipalCannotHoldAccessError } from '../src/lib/drives.js';
import { humanAgentEmployeeUpdateState } from '../src/lib/mcp-tools/human.js';
import { agentEmployeeRoutes } from '../src/routes/agent-employees.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { driveRoutes } from '../src/routes/drives.js';
import { spaceRoutes } from '../src/routes/spaces.js';
import { memberRoutes } from '../src/routes/members.js';
import { notificationRoutes } from '../src/routes/notifications.js';
import { setupSocket } from '../src/socket.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const ROUTES = [
  { path: '/api/drives', app: driveRoutes },
  { path: '/api/spaces', app: spaceRoutes },
  { path: '/api/members', app: memberRoutes },
  { path: '/api/notifications', app: notificationRoutes },
  { path: '/api/agent-employees', app: agentEmployeeRoutes },
  { path: '/api/dashboard', app: dashboardRoutes },
];
let fx: DrivesFixture | undefined;

/** Every change seen by the in-transaction hook, with the id of the transaction it ran in. */
const lossesInTx: Array<{ change: DocumentAccessChange; txid: string | null }> = [];
/** Every access change emitted after commit (finishAccessLoss and the plain emitter). */
const accessChanges: DocumentAccessChange[] = [];
const lifecycle: DocumentLifecycleEvent[] = [];
const unsubscribe: Array<() => void> = [];

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('drives-http', { routes: ROUTES });
  onAccessLossInTx(async (tx, change) => {
    const result = await tx.execute(sql`SELECT txid_current_if_assigned()::text AS txid`);
    lossesInTx.push({ change, txid: (result.rows[0] as { txid: string | null }).txid });
    return [];
  });
  unsubscribe.push(onDocumentAccessChanged((change) => { accessChanges.push(change); }));
  unsubscribe.push(onDocumentEvent((event) => { lifecycle.push(event); }));
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
  lifecycle.length = 0;
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

async function createDrive(userId: string, body: Record<string, unknown>): Promise<string> {
  const created = await call(userId, 'POST', '/api/drives', body, 201);
  return created.drive.id as string;
}

async function addMember(actor: string, driveId: string, principal: { user?: string; space?: string }, role: string, status = 201): Promise<any> {
  return call(actor, 'POST', `/api/drives/${driveId}/members`, {
    principal_type: principal.user ? 'user' : 'space', principal_id: principal.user ?? principal.space, role,
  }, status);
}

async function memberRowId(driveId: string, principalId: string): Promise<string> {
  const { rows: [row] } = await fx!.client.query('SELECT id FROM drive_members WHERE drive_id = $1 AND principal_id = $2', [driveId, principalId]);
  assert.ok(row, `a member row for ${principalId}`);
  return row.id;
}

const listOf = async (userId: string) => (await call(userId, 'GET', '/api/drives', undefined, 200)).drives as Array<Record<string, any>>;

/** The one hook call and emitted change a single access loss should produce. */
function assertOneLoss(expected: DocumentAccessChange, generationBefore: number) {
  assert.equal(lossesInTx.length, 1, `one applyAccessLossInTx call: ${JSON.stringify(lossesInTx)}`);
  assert.deepEqual(lossesInTx[0]!.change, expected);
  assert.ok(lossesInTx[0]!.txid, 'the hook ran inside the transaction that made the change');
  assert.ok(accessChanges.some((change) => isDeepStrictEqual(change, expected)), 'finishAccessLoss emitted the change');
  assert.ok(currentAccessGeneration() > generationBefore, 'the access generation moved');
}

test('the first GET /api/drives creates the Workspace drive, and a member sees it with role edit', async (t) => {
  if (!url) return t.skip(SKIP);
  const fresh = await setupDrivesFixture('drives-http-fresh', { routes: ROUTES });
  try {
    await fresh.client.query('DELETE FROM drives WHERE id = $1', [fresh.workspaceDriveId]);
    const res = await fresh.request(fresh.people.member, 'GET', '/api/drives');
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    const workspace = (body.drives as Array<Record<string, any>>).filter((drive) => drive.system_key === 'workspace');
    assert.equal(workspace.length, 1);
    assert.equal(workspace[0]!.name, 'Workspace');
    assert.equal(workspace[0]!.kind, 'open');
    assert.equal(workspace[0]!.default_role, 'edit');
    assert.equal(workspace[0]!.role, 'edit');
    assert.equal(workspace[0]!.admin_listed, false);
    await fresh.request(fresh.people.owner, 'GET', '/api/drives');
    const { rows } = await fresh.client.query(`SELECT id FROM drives WHERE org_id = $1 AND system_key = 'workspace' AND NOT is_deleted`, [fresh.orgId]);
    assert.equal(rows.length, 1, 'created once');
    assert.equal((await ensureWorkspaceDrive(fresh.orgId)).id, rows[0].id);
  } finally {
    await fresh.teardown();
  }
});

test("a guest's drive list has no open drives", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member } = fx.people;
  const openDrive = await createDrive(member, { name: 'Open to members', kind: 'open', default_role: 'comment' });
  const guestDrive = await createDrive(member, { name: 'With the guest', kind: 'private' });
  await addMember(member, guestDrive, { user: guest }, 'view');
  const drives = await listOf(guest);
  assert.deepEqual(drives.filter((drive) => drive.kind === 'open'), []);
  assert.deepEqual(drives.map((drive) => [drive.id, drive.role]), [[guestDrive, 'view']]);
  await call(guest, 'GET', `/api/drives/${fx.workspaceDriveId}`, undefined, 404);
  await call(guest, 'GET', `/api/drives/${openDrive}`, undefined, 404);
});

test('a member creates a private drive and holds full access; a guest gets 403 GUEST_FORBIDDEN', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2, owner } = fx.people;
  const created = await call(member, 'POST', '/api/drives', { name: 'Plans', kind: 'private', icon: 'folder' }, 201);
  assert.equal(created.drive.role, 'full');
  assert.equal(created.drive.kind, 'private');
  assert.equal(created.drive.default_role, null);
  assert.equal(await driveRoleFor(member, fx.orgId, created.drive.id), 'full');
  assert.equal(await driveRoleFor(member2, fx.orgId, created.drive.id), null);
  assert.equal(await driveRoleFor(owner, fx.orgId, created.drive.id), null, 'owners hold nothing on a private drive they are not in');
  const { rows } = await fx.client.query('SELECT principal_type, principal_id, role FROM drive_members WHERE drive_id = $1', [created.drive.id]);
  assert.deepEqual(rows, [{ principal_type: 'user', principal_id: member, role: 'full' }]);

  const open = await call(member, 'POST', '/api/drives', { name: 'Team handbook', kind: 'open', default_role: 'view' }, 201);
  assert.equal(await driveRoleFor(member2, fx.orgId, open.drive.id), 'view');

  const refused = await call(guest, 'POST', '/api/drives', { name: 'Mine', kind: 'private' }, 403);
  assert.equal(refused.code, 'GUEST_FORBIDDEN');
  assert.equal((await call(member, 'POST', '/api/drives', { name: 'x', kind: 'personal' }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await call(member, 'POST', '/api/drives', { name: 'x', kind: 'private', default_role: 'edit' }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await call(member, 'POST', '/api/drives', { name: '  ', kind: 'private' }, 400)).code, 'VALIDATION_ERROR');
});

test('only full access changes settings: an editor gets 403 FORBIDDEN_ROLE', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  // The Workspace drive gives a member edit.
  assert.equal((await call(member, 'PATCH', `/api/drives/${fx.workspaceDriveId}`, { name: 'Renamed' }, 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(member, 'DELETE', `/api/drives/${fx.workspaceDriveId}`, undefined, 403)).code, 'FORBIDDEN_ROLE');
  const drive = await createDrive(member, { name: 'Editors', kind: 'private' });
  await addMember(member, drive, { user: member2 }, 'edit');
  for (const [method, path, body] of [
    ['PATCH', `/api/drives/${drive}`, { name: 'Mine now' }],
    ['DELETE', `/api/drives/${drive}`, undefined],
    ['GET', `/api/drives/${drive}/members`, undefined],
    ['POST', `/api/drives/${drive}/members`, { principal_type: 'user', principal_id: fx.people.guest, role: 'view' }],
  ] as const) {
    assert.equal((await call(member2, method, path, body, 403)).code, 'FORBIDDEN_ROLE', `${method} ${path}`);
  }
  // An editor still reads the drive.
  assert.equal((await call(member2, 'GET', `/api/drives/${drive}`, undefined, 200)).drive.role, 'edit');
  // Kind can't change, even with full access.
  assert.equal((await call(member, 'PATCH', `/api/drives/${drive}`, { kind: 'open' }, 400)).code, 'VALIDATION_ERROR');
  // A private drive has no default role.
  assert.equal((await call(member, 'PATCH', `/api/drives/${drive}`, { default_role: 'view' }, 400)).code, 'VALIDATION_ERROR');
  const changed = await call(member, 'PATCH', `/api/drives/${drive}`, { name: 'Editors only', icon: 'pen', agent_suggest_only: true }, 200);
  assert.equal(changed.drive.name, 'Editors only');
  assert.equal(changed.drive.icon, 'pen');
  assert.equal(changed.drive.agent_suggest_only, true);
});

test('an admin has full access on every open drive', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, owner } = fx.people;
  const openDrive = await createDrive(member, { name: 'Open, view', kind: 'open', default_role: 'view' });
  for (const person of [admin, owner]) {
    const drives = await listOf(person);
    assert.equal(drives.find((drive) => drive.id === fx!.workspaceDriveId)?.role, 'full');
    assert.equal(drives.find((drive) => drive.id === openDrive)?.role, 'full');
  }
  assert.equal((await call(admin, 'PATCH', `/api/drives/${openDrive}`, { name: 'Open, renamed by an admin' }, 200)).drive.name,
    'Open, renamed by an admin');
  assert.equal((await call(admin, 'GET', `/api/drives/${openDrive}/members`, undefined, 200)).admin_changes.length, 0);
});

test('an admin sees a private drive listed but gets 404 on it until they add themselves; the change is audited and members are told', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, agentUser, guest, member, member2 } = fx.people;
  const drive = await createDrive(member, { name: 'Payroll', kind: 'private' });
  await addMember(member, drive, { user: member2 }, 'view');
  // The chat `other` holds member2 only; an agent member is never sent the notice.
  await addMember(member, drive, { user: agentUser }, 'view');

  const listed = (await listOf(admin)).find((row) => row.id === drive);
  assert.ok(listed, 'listed for the admin');
  assert.equal(listed.admin_listed, true);
  assert.equal(listed.role, null);
  assert.equal(listed.name, 'Payroll');
  assert.equal((await call(admin, 'GET', `/api/drives/${drive}`, undefined, 404)).code, 'NOT_FOUND');
  assert.equal((await call(admin, 'POST', `/api/drives/${drive}/pin`, undefined, 404)).code, 'NOT_FOUND');
  // A member's list never shows it.
  assert.equal((await listOf(fx.people.member2)).find((row) => row.id === drive)?.role, 'view');
  assert.equal((await listOf(fx.people.guest)).find((row) => row.id === drive), undefined);

  const before = await call(admin, 'GET', `/api/drives/${drive}/members`, undefined, 200);
  assert.deepEqual(before.members.map((row: any) => [row.principal_id, row.role]).sort(),
    [[member, 'full'], [member2, 'view'], [agentUser, 'view']].sort());
  assert.deepEqual(before.admin_changes, []);
  assert.equal(before.admin_path, true);

  await addMember(admin, drive, { user: admin }, 'edit');
  assert.equal((await call(admin, 'GET', `/api/drives/${drive}`, undefined, 200)).drive.role, 'edit');
  const after = (await listOf(admin)).find((row) => row.id === drive);
  assert.equal(after?.role, 'edit');
  assert.equal(after?.admin_listed, false);

  const { rows: audits } = await fx.client.query(`SELECT actor_id, action, entity_type, entity_id, metadata, xmin::text AS xmin FROM audit_log
    WHERE org_id = $1 AND entity_id = $2`, [fx.orgId, drive]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'drive_member_changed_by_admin');
  assert.equal(audits[0].entity_type, 'drive');
  assert.equal(audits[0].actor_id, admin);
  assert.equal(audits[0].metadata.change, 'added');
  assert.equal(audits[0].metadata.principal_id, admin);
  // Written by the change's own transaction: the same xmin as the member row it records.
  const { rows: [adminRow] } = await fx.client.query('SELECT xmin::text AS xmin FROM drive_members WHERE drive_id = $1 AND principal_id = $2',
    [drive, admin]);
  assert.equal(audits[0].xmin, adminRow.xmin, 'the audit row commits with the change');

  const { rows: told } = await fx.client.query(`SELECT user_id, type::text AS type, metadata FROM notifications
    WHERE org_id = $1 AND metadata->>'drive_id' = $2 AND metadata->>'subtype' = 'admin_change' ORDER BY user_id`, [fx.orgId, drive]);
  assert.deepEqual(told.map((row) => row.user_id).sort(), [member, member2].sort(), 'every human member but the admin who acted');
  for (const row of told) {
    assert.equal(row.type, 'document_shared');
    assert.equal(row.metadata.actor_id, admin);
  }

  // A removal through the admin path tells the members in a chat member too, never the agent.
  await addMember(member, drive, { space: fx.spaces.team }, 'view');
  await fx.client.query(`DELETE FROM notifications WHERE org_id = $1 AND metadata->>'drive_id' = $2`, [fx.orgId, drive]);
  await call(admin, 'DELETE', `/api/drives/${drive}/members/${await memberRowId(drive, member2)}`, undefined, 200);
  const { rows: toldOfRemoval } = await fx.client.query(`SELECT user_id FROM notifications
    WHERE org_id = $1 AND metadata->>'drive_id' = $2 AND metadata->>'subtype' = 'admin_change'`, [fx.orgId, drive]);
  assert.deepEqual(toldOfRemoval.map((row) => row.user_id).sort(), [member, member2, guest].sort(),
    'member, and member2 and the guest through the team chat; not the agent, not the admin');

  const panel = await call(member, 'GET', `/api/drives/${drive}/members`, undefined, 200);
  assert.deepEqual(panel.admin_changes.map((entry: any) => [entry.actor_id, entry.change]), [[admin, 'removed'], [admin, 'added']]);

  // A full member's own changes are not admin changes.
  await addMember(member, drive, { user: fx.people.guest }, 'view');
  assert.equal((await call(member, 'GET', `/api/drives/${drive}/members`, undefined, 200)).admin_changes.length, 2);
});

test('adding a chat as a member grants its members; removing someone from the chat emits an access change and removes it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { agentUser, guest, member, member2, owner } = fx.people;
  const drive = await createDrive(member2, { name: 'Team drive', kind: 'private' });
  const document = await fx.insertDocument({ driveId: drive, title: 'Team notes' });
  resetEvents();
  await addMember(member2, drive, { space: fx.spaces.team }, 'edit');
  assert.deepEqual(accessChanges, [{ orgId: fx.orgId, driveId: drive, spaceId: fx.spaces.team }], 'adding emits an access change');
  assert.equal(lossesInTx.length, 0, 'adding loses nobody anything');
  for (const person of [member, guest, agentUser]) {
    assert.equal(await driveRoleFor(person, fx.orgId, drive), 'edit');
    assert.equal(await documentRoleFor(person, fx.orgId, document), 'edit');
  }
  try {
    resetEvents();
    const generation = currentAccessGeneration();
    await call(owner, 'DELETE', `/api/spaces/${fx.spaces.team}/members/${guest}`, undefined, 200);
    assertOneLoss({ orgId: fx.orgId, spaceId: fx.spaces.team, userIds: [guest] }, generation);
    assert.equal(await driveRoleFor(guest, fx.orgId, drive), null);
    assert.equal(await documentRoleFor(guest, fx.orgId, document), null);
    assert.equal(await driveRoleFor(member, fx.orgId, drive), 'edit', 'the others keep it');
  } finally {
    await fx.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (space_id, user_id) DO NOTHING',
      [randomUUID(), fx.spaces.team, guest]);
  }
});

test('linking a second drive to the same chat is refused with 409 SPACE_ALREADY_LINKED', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const first = await createDrive(member2, { name: 'Linked one', kind: 'private' });
  const second = await createDrive(member2, { name: 'Linked two', kind: 'private' });
  resetEvents();
  const linked = await call(member2, 'POST', `/api/drives/${first}/link-space`, { space_id: fx.spaces.other, role: 'comment' }, 201);
  assert.equal(linked.member.is_link, true);
  assert.equal(linked.member.role, 'comment');
  assert.deepEqual(accessChanges, [{ orgId: fx.orgId, driveId: first, spaceId: fx.spaces.other }]);
  assert.equal((await call(member2, 'POST', `/api/drives/${second}/link-space`, { space_id: fx.spaces.other, role: 'view' }, 409)).code,
    'SPACE_ALREADY_LINKED');
  assert.equal((await call(member2, 'POST', `/api/drives/${first}/link-space`, { space_id: fx.spaces.other, role: 'view' }, 409)).code,
    'SPACE_ALREADY_LINKED');
  await call(member2, 'DELETE', `/api/drives/${first}/link-space/${fx.spaces.other}`, undefined, 200);
  await call(member2, 'POST', `/api/drives/${second}/link-space`, { space_id: fx.spaces.other, role: 'view' }, 201);

  // A chat that is already a plain member of the drive becomes its link.
  const third = await createDrive(member, { name: 'Linked three', kind: 'private' });
  await addMember(member, third, { space: fx.spaces.team }, 'view');
  const promoted = await call(member, 'POST', `/api/drives/${third}/link-space`, { space_id: fx.spaces.team, role: 'edit' }, 201);
  assert.equal(promoted.member.is_link, true);
  assert.equal(promoted.member.role, 'edit');
  const { rows } = await fx.client.query(`SELECT count(*)::int AS n FROM drive_members WHERE drive_id = $1 AND principal_id = $2`, [third, fx.spaces.team]);
  assert.equal(rows[0].n, 1);
  // Free both chats for the tests that follow.
  await call(member2, 'DELETE', `/api/drives/${second}/link-space/${fx.spaces.other}`, undefined, 200);
  await call(member, 'DELETE', `/api/drives/${third}/link-space/${fx.spaces.team}`, undefined, 200);
});

test('linking needs full access on the drive and membership of the chat', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const drive = await createDrive(member, { name: 'Needs both', kind: 'private' });
  // Full on the drive, but not in the chat `other`.
  const notInChat = await call(member, 'POST', `/api/drives/${drive}/link-space`, { space_id: fx.spaces.other, role: 'view' }, 403);
  assert.equal(notInChat.code, 'SPACE_MEMBERSHIP_REQUIRED');
  // A chat of another workspace, or none at all, looks the same.
  assert.equal((await call(member, 'POST', `/api/drives/${drive}/link-space`, { space_id: randomUUID(), role: 'view' }, 403)).code,
    'SPACE_MEMBERSHIP_REQUIRED');
  // In the chat, but only edit on the drive.
  await addMember(member, drive, { user: member2 }, 'edit');
  assert.equal((await call(member2, 'POST', `/api/drives/${drive}/link-space`, { space_id: fx.spaces.other, role: 'view' }, 403)).code,
    'FORBIDDEN_ROLE');
  // Someone who can't see the drive at all gets 404.
  assert.equal((await call(fx.people.guest, 'POST', `/api/drives/${drive}/link-space`, { space_id: fx.spaces.team, role: 'view' }, 404)).code,
    'NOT_FOUND');
  // Both: allowed. (Adding someone twice is refused; their row's role is changed instead.)
  assert.equal((await addMember(member, drive, { user: member2 }, 'full', 409)).code, 'ALREADY_MEMBER');
  await call(member, 'PATCH', `/api/drives/${drive}/members/${await memberRowId(drive, member2)}`, { role: 'full' }, 200);
  await call(member2, 'POST', `/api/drives/${drive}/link-space`, { space_id: fx.spaces.other, role: 'view' }, 201);
  // Unlinking needs full too.
  await call(member, 'PATCH', `/api/drives/${drive}/members/${await memberRowId(drive, member2)}`, { role: 'edit' }, 200);
  assert.equal((await call(member2, 'DELETE', `/api/drives/${drive}/link-space/${fx.spaces.other}`, undefined, 403)).code, 'FORBIDDEN_ROLE');
  await call(member, 'DELETE', `/api/drives/${drive}/link-space/${fx.spaces.other}`, undefined, 200);
});

test("the Workspace drive can't be deleted (409 SYSTEM_DRIVE)", async (t) => {
  if (!fx) return t.skip(SKIP);
  for (const person of [fx.people.owner, fx.people.admin]) {
    assert.equal((await call(person, 'DELETE', `/api/drives/${fx.workspaceDriveId}`, undefined, 409)).code, 'SYSTEM_DRIVE');
  }
  const { rows } = await fx.client.query('SELECT is_deleted FROM drives WHERE id = $1', [fx.workspaceDriveId]);
  assert.equal(rows[0].is_deleted, false);
  const sharedNotes = await ensureSharedNotesDrive(fx.orgId, fx.people.owner);
  assert.equal((await call(fx.people.owner, 'DELETE', `/api/drives/${sharedNotes.id}`, undefined, 409)).code, 'SYSTEM_DRIVE');
});

test("a personal drive can't be deleted, even by its owner (409 PERSONAL_DRIVE)", async (t) => {
  if (!fx) return t.skip(SKIP);
  const mine = await ensurePersonalDrive(fx.orgId, fx.people.member);
  assert.equal((await call(fx.people.member, 'DELETE', `/api/drives/${mine.id}`, undefined, 409)).code, 'PERSONAL_DRIVE');
  const { rows } = await fx.client.query('SELECT is_deleted FROM drives WHERE id = $1', [mine.id]);
  assert.equal(rows[0].is_deleted, false);
});

test('lowering default_role, removing a member, removing a link, demoting an admin and deleting a drive each run applyAccessLossInTx', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2, owner } = fx.people;
  const orgId = fx.orgId;

  // Lowering default_role; raising it again is not a loss but still emits.
  const openDrive = await createDrive(member, { name: 'Open for loss', kind: 'open', default_role: 'edit' });
  resetEvents();
  let generation = currentAccessGeneration();
  await call(member, 'PATCH', `/api/drives/${openDrive}`, { default_role: 'view' }, 200);
  assertOneLoss({ orgId, driveId: openDrive }, generation);
  assert.equal(await driveRoleFor(member2, orgId, openDrive), 'view');
  resetEvents();
  await call(member, 'PATCH', `/api/drives/${openDrive}`, { default_role: 'comment' }, 200);
  assert.equal(lossesInTx.length, 0, 'raising is not a loss');
  assert.deepEqual(accessChanges, [{ orgId, driveId: openDrive }]);

  // Lowering, then removing, a member.
  const privateDrive = await createDrive(member, { name: 'Private for loss', kind: 'private' });
  await addMember(member, privateDrive, { user: member2 }, 'edit');
  const memberId = await memberRowId(privateDrive, member2);
  resetEvents();
  generation = currentAccessGeneration();
  await call(member, 'PATCH', `/api/drives/${privateDrive}/members/${memberId}`, { role: 'view' }, 200);
  assertOneLoss({ orgId, driveId: privateDrive, userIds: [member2] }, generation);
  resetEvents();
  generation = currentAccessGeneration();
  await call(member, 'DELETE', `/api/drives/${privateDrive}/members/${memberId}`, undefined, 200);
  assertOneLoss({ orgId, driveId: privateDrive, userIds: [member2] }, generation);
  assert.equal(await driveRoleFor(member2, orgId, privateDrive), null);

  // Removing a link.
  const linkedDrive = await createDrive(member2, { name: 'Linked for loss', kind: 'private' });
  await call(member2, 'POST', `/api/drives/${linkedDrive}/link-space`, { space_id: fx.spaces.other, role: 'edit' }, 201);
  resetEvents();
  generation = currentAccessGeneration();
  await call(member2, 'DELETE', `/api/drives/${linkedDrive}/link-space/${fx.spaces.other}`, undefined, 200);
  assertOneLoss({ orgId, driveId: linkedDrive, spaceId: fx.spaces.other }, generation);

  // Demoting an admin (the owner does it; the admin is restored afterwards).
  try {
    resetEvents();
    generation = currentAccessGeneration();
    await call(owner, 'PATCH', `/api/members/${admin}`, { role: 'member' }, 200);
    assertOneLoss({ orgId, userIds: [admin] }, generation);
    assert.equal(await driveRoleFor(admin, orgId, fx.workspaceDriveId), 'edit', 'a member, not full, on the Workspace drive');
  } finally {
    await fx.client.query(`UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, admin]);
  }

  // Deleting a drive.
  const doomed = await createDrive(member, { name: 'Doomed', kind: 'private' });
  const doc = await fx.insertDocument({ driveId: doomed, title: 'Going' });
  await fx.insertDocument({ driveId: doomed, title: 'Already gone', deleted: true });
  resetEvents();
  generation = currentAccessGeneration();
  await call(member, 'DELETE', `/api/drives/${doomed}`, undefined, 200);
  assertOneLoss({ orgId, driveId: doomed, documentIds: [doc] }, generation);
  assert.equal(await documentRoleFor(member, orgId, doc), null);
  await call(member, 'GET', `/api/drives/${doomed}`, undefined, 404);
});

test('removing a person from the workspace, and making a member a guest, run applyAccessLossInTx', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { owner } = fx.people;
  const person = await fx.addPerson({ role: 'member' });
  assert.equal(await driveRoleFor(person, fx.orgId, fx.workspaceDriveId), 'edit');
  resetEvents();
  let generation = currentAccessGeneration();
  await call(owner, 'PATCH', `/api/members/${person}`, { role: 'guest' }, 200);
  assertOneLoss({ orgId: fx.orgId, userIds: [person] }, generation);
  assert.equal(await driveRoleFor(person, fx.orgId, fx.workspaceDriveId), null);

  // Back to member: not a loss, but an access change.
  resetEvents();
  await call(owner, 'PATCH', `/api/members/${person}`, { role: 'member' }, 200);
  assert.equal(lossesInTx.length, 0);
  assert.deepEqual(accessChanges, [{ orgId: fx.orgId, userIds: [person] }]);

  const drive = await createDrive(person, { name: 'Leaving with them', kind: 'private' });
  resetEvents();
  generation = currentAccessGeneration();
  await call(owner, 'DELETE', `/api/members/${person}`, {}, 200);
  assertOneLoss({ orgId: fx.orgId, userIds: [person] }, generation);
  assert.equal(await driveRoleFor(person, fx.orgId, drive), null);
});

test('a grant naming someone who can never hold access is refused with 400 PRINCIPAL_CANNOT_HOLD_ACCESS', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await createDrive(member, { name: 'Grants', kind: 'private' });
  const noEmployeeAgent = await fx.addPerson({ kind: 'agent' }); // as Defty's own user: an agent with no employee
  const systemUser = await fx.addPerson({ kind: 'system' });
  const inactive = await fx.addPerson({ active: false });
  for (const principal of [noEmployeeAgent, systemUser, inactive, fx.people.outsider, randomUUID()]) {
    assert.equal((await addMember(member, drive, { user: principal }, 'view', 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS', principal);
  }
  for (const space of [randomUUID(), fx.spaces.other /* a private chat the member is not in */]) {
    assert.equal((await addMember(member, drive, { space }, 'view', 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS', space);
  }
  const { rows } = await fx.client.query('SELECT count(*)::int AS n FROM drive_members WHERE drive_id = $1', [drive]);
  assert.equal(rows[0].n, 1, 'only the creator');
  // An agent with an active employee, and a guest, can hold access.
  await addMember(member, drive, { user: fx.people.agentUser }, 'view');
  await addMember(member, drive, { user: fx.people.guest }, 'comment');
  assert.equal(await driveRoleFor(fx.people.agentUser, fx.orgId, drive), 'view');
  assert.equal(await driveRoleFor(fx.people.guest, fx.orgId, drive), 'comment');
  assert.equal((await call(member, 'POST', `/api/drives/${drive}/members`, { principal_type: 'team', principal_id: member, role: 'view' }, 400)).code,
    'VALIDATION_ERROR');
});

test("ensurePersonalDrive writes the owner's full row once; ensureSharedNotesDrive makes one Shared notes drive", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, guest, member2 } = fx.people;
  const [first, second] = await Promise.all([ensurePersonalDrive(fx.orgId, member2), ensurePersonalDrive(fx.orgId, member2)]);
  assert.equal(first.id, second.id);
  assert.equal(first.name, 'My drive');
  assert.equal(first.kind, 'personal');
  assert.equal(first.owner_user_id, member2);
  const { rows } = await fx.client.query('SELECT principal_id, role FROM drive_members WHERE drive_id = $1', [first.id]);
  assert.deepEqual(rows, [{ principal_id: member2, role: 'full' }]);
  assert.equal(await driveRoleFor(member2, fx.orgId, first.id), 'full');
  assert.equal(await driveRoleFor(admin, fx.orgId, first.id), null, 'nobody else');
  // A lost owner row comes back.
  await fx.client.query('DELETE FROM drive_members WHERE drive_id = $1', [first.id]);
  assert.equal((await ensurePersonalDrive(fx.orgId, member2)).id, first.id);
  assert.equal(await driveRoleFor(member2, fx.orgId, first.id), 'full');
  // The owner can't remove or lower their own row through the API.
  const ownerRow = await memberRowId(first.id, member2);
  assert.equal((await call(member2, 'DELETE', `/api/drives/${first.id}/members/${ownerRow}`, undefined, 409)).code, 'PERSONAL_DRIVE_OWNER');
  assert.equal((await call(member2, 'PATCH', `/api/drives/${first.id}/members/${ownerRow}`, { role: 'view' }, 409)).code, 'PERSONAL_DRIVE_OWNER');

  const [notes, again] = await Promise.all([ensureSharedNotesDrive(fx.orgId, admin), ensureSharedNotesDrive(fx.orgId, admin)]);
  assert.equal(notes.id, again.id);
  assert.equal(notes.name, 'Shared notes');
  assert.equal(notes.system_key, 'shared_notes');
  assert.equal(notes.kind, 'open');
  assert.equal(notes.default_role, 'view');
  assert.equal(await driveRoleFor(member2, fx.orgId, notes.id), 'view');
  assert.equal(await driveRoleFor(admin, fx.orgId, notes.id), 'full');
  assert.equal(await driveRoleFor(guest, fx.orgId, notes.id), null);
});

test('deleting a drive, or changing its knowledge default, emits a lifecycle event for each document', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const drive = await createDrive(member, { name: 'Knowledge', kind: 'private' });
  const docs = [await fx.insertDocument({ driveId: drive, title: 'A' }), await fx.insertDocument({ driveId: drive, title: 'B' })];
  await fx.insertDocument({ driveId: drive, title: 'Trashed', deleted: true });
  await call(member, 'POST', `/api/drives/${drive}/link-space`, { space_id: fx.spaces.team, role: 'view' }, 201);
  resetEvents();
  const off = await call(member, 'PATCH', `/api/drives/${drive}`, { knowledge_default: false }, 200);
  assert.equal(off.drive.knowledge_default, false);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]!.type, 'knowledge_changed');
  assert.equal(lifecycle[0]!.actorId, member);
  assert.deepEqual([...lifecycle[0]!.documentIds].sort(), [...docs].sort());
  resetEvents();
  await call(member, 'PATCH', `/api/drives/${drive}`, { knowledge_default: false }, 200);
  assert.equal(lifecycle.length, 0, 'no change, no event');

  resetEvents();
  await call(member, 'DELETE', `/api/drives/${drive}`, undefined, 200);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]!.type, 'deleted');
  assert.equal(lifecycle[0]!.fromDriveId, drive);
  assert.deepEqual([...lifecycle[0]!.documentIds].sort(), [...docs].sort());
  // The deleted drive's chat link is gone, so the chat can be linked again.
  const other = await createDrive(member2, { name: 'Next link', kind: 'private' });
  await call(member2, 'POST', `/api/drives/${other}/link-space`, { space_id: fx.spaces.team, role: 'view' }, 201);
  await call(member2, 'DELETE', `/api/drives/${other}/link-space/${fx.spaces.team}`, undefined, 200);
});

test('pinning a drive is per person', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  await call(member, 'POST', `/api/drives/${fx.workspaceDriveId}/pin`, undefined, 200);
  await call(member, 'POST', `/api/drives/${fx.workspaceDriveId}/pin`, undefined, 200);
  assert.equal((await listOf(member)).find((drive) => drive.id === fx!.workspaceDriveId)?.pinned, true);
  assert.equal((await listOf(member2)).find((drive) => drive.id === fx!.workspaceDriveId)?.pinned, false);
  await call(member, 'DELETE', `/api/drives/${fx.workspaceDriveId}/pin`, undefined, 200);
  assert.equal((await listOf(member)).find((drive) => drive.id === fx!.workspaceDriveId)?.pinned, false);
});

type Received = Array<{ event: string; data: any }>;

/** Sockets for people of the fixture's workspace, through the real socket server (roles from org_members). */
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

test('document:updated for a private drive reaches only people who can view it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, agentUser, guest, member, member2, owner } = fx.people;
  const drive = await createDrive(member, { name: 'Private events', kind: 'private' });
  const document = await fx.insertDocument({ driveId: drive, title: 'Private' });
  await fx.share(document, { user: guest }, 'view');
  const harness = await socketHarness([owner, admin, member, member2, guest, agentUser]);
  try {
    await emitDocumentUpdated(fx.orgId, [document]);
    const expected = { id: document, drive_id: drive };
    await waitFor(() => harness.updates(member).length > 0 && harness.updates(guest).length > 0, 'the viewers are told');
    // Deleting the drive tells nobody, not even someone who could see it a moment ago.
    await call(member, 'DELETE', `/api/drives/${drive}`, undefined, 200);
    await emitDocumentUpdated(fx.orgId, [document]);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(harness.updates(member), [expected], 'the full member, once: nothing after the delete');
    assert.deepEqual(harness.updates(guest), [expected], 'a guest who holds a share, once');
    for (const outside of [owner, admin, member2, agentUser]) assert.deepEqual(harness.updates(outside), [], 'outside the private drive');
    for (const update of [...harness.updates(member), ...harness.updates(guest)]) assert.deepEqual(Object.keys(update).sort(), ['drive_id', 'id'], 'ids only');
  } finally {
    await harness.close();
  }
});

test('document:updated for an open drive goes to each viewer, never the members room: a non-guest agent gets it only with a grant', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { agentUser, guest, member2, owner } = fx.people;
  const openDocument = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Open' });
  const harness = await socketHarness([owner, member2, guest, agentUser]);
  try {
    const expected = { id: openDocument, drive_id: fx.workspaceDriveId };
    await emitDocumentUpdated(fx.orgId, [openDocument]);
    await waitFor(() => harness.updates(member2).length > 0 && harness.updates(owner).length > 0, 'the open drive’s people are told');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(harness.updates(member2), [expected]);
    assert.deepEqual(harness.updates(owner), [expected]);
    assert.deepEqual(harness.updates(agentUser), [], 'an agent with the member role, and no grant, in the org-members room');
    assert.deepEqual(harness.updates(guest), [], 'a guest without a share');
    // With a grant of its own, the agent is told; the guest still isn't.
    await fx.share(openDocument, { user: agentUser }, 'view');
    await emitDocumentUpdated(fx.orgId, [openDocument]);
    await waitFor(() => harness.updates(agentUser).length > 0, 'the agent with a share is told');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(harness.updates(agentUser), [expected]);
    assert.deepEqual(harness.updates(member2), [expected, expected], 'once per event');
    assert.deepEqual(harness.updates(guest), []);
  } finally {
    await harness.close();
  }
});

test('pausing an agent, or deleting it, runs applyAccessLossInTx; resuming only emits (REST and MCP)', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, owner } = fx.people;
  const employeeId = randomUUID();
  const agent = await fx.addPerson({ kind: 'agent', agentEmployeeId: employeeId });
  const drive = await createDrive(member, { name: 'Agent access', kind: 'private' });
  await addMember(member, drive, { user: agent }, 'view');
  assert.equal(await driveRoleFor(agent, fx.orgId, drive), 'view');
  const lost = { orgId: fx.orgId, userIds: [agent] };

  resetEvents();
  let generation = currentAccessGeneration();
  await call(owner, 'POST', `/api/agent-employees/${employeeId}/pause`, {}, 200);
  assertOneLoss(lost, generation);
  assert.equal(await driveRoleFor(agent, fx.orgId, drive), null);

  resetEvents();
  await call(owner, 'POST', `/api/agent-employees/${employeeId}/resume`, {}, 200);
  assert.equal(lossesInTx.length, 0, 'resuming takes nothing away');
  assert.deepEqual(accessChanges, [lost]);
  assert.equal(await driveRoleFor(agent, fx.orgId, drive), 'view');

  const mcp = (state: string) => humanAgentEmployeeUpdateState({ employee_id: employeeId, state },
    { org_id: fx!.orgId, user_id: owner, role: 'owner', scopes: ['write:workspace'] });
  resetEvents();
  generation = currentAccessGeneration();
  assert.ok(!(await mcp('paused')).isError);
  assertOneLoss(lost, generation);
  assert.equal(await driveRoleFor(agent, fx.orgId, drive), null);
  resetEvents();
  assert.ok(!(await mcp('active')).isError);
  assert.equal(lossesInTx.length, 0);
  assert.deepEqual(accessChanges, [lost]);
  assert.equal(await driveRoleFor(agent, fx.orgId, drive), 'view');

  resetEvents();
  generation = currentAccessGeneration();
  await call(owner, 'DELETE', `/api/agent-employees/${employeeId}`, undefined, 200);
  assertOneLoss(lost, generation);
  assert.equal(await driveRoleFor(agent, fx.orgId, drive), null);
});

test('a drive notification is listed and counted only while its reader can view the drive', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const drive = await createDrive(member, { name: 'Shared then not', kind: 'private' });
  await addMember(member, drive, { user: member2 }, 'view');
  const inbox = async () => {
    const body = await call(member2, 'GET', '/api/notifications', undefined, 200);
    return { forDrive: (body.notifications as any[]).filter((row) => row.metadata?.drive_id === drive), unread: body.unread_count as number };
  };
  const shared = await inbox();
  assert.equal(shared.forDrive.length, 1);
  assert.equal(shared.forDrive[0].metadata.subtype, 'drive_member');
  assert.equal(shared.forDrive[0].type, 'document_shared');
  await call(member, 'DELETE', `/api/drives/${drive}/members/${await memberRowId(drive, member2)}`, undefined, 200);
  const removed = await inbox();
  assert.deepEqual(removed.forDrive, [], 'no longer listed');
  assert.equal(removed.unread, shared.unread - 1, 'no longer counted');
});

test('a drive notification that is also a readable mention delivery is listed and counted only while its reader can view the drive', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const q = (text: string, values: unknown[]) => fx!.client.query(text, values);
  const drive = await createDrive(member, { name: 'Mentioned drive', kind: 'private' });
  await addMember(member, drive, { user: member2 }, 'view');
  const [message, state, delivery, notification] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  // A mention of member2 in a message of the team chat, which member2 can read: the delivery stays readable.
  await q(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, 'a mention')`, [message, fx.orgId, fx.spaces.team, member]);
  try {
    await q(`INSERT INTO native_reference_states (id, org_id, source_kind, source_id, content_hash) VALUES ($1, $2, 'message', $3, 'hash')`,
      [state, fx.orgId, message]);
    await q(`INSERT INTO native_mention_deliveries (id, org_id, source_state_id, publication_revision, recipient_user_id, actor_user_id, status)
      VALUES ($1, $2, $3, 1, $4, $5, 'delivered')`, [delivery, fx.orgId, state, member2, member]);
    await q(`INSERT INTO notifications (id, org_id, user_id, type, title, metadata)
      VALUES ($1, $2, $3, 'mention', 'Mentioned', jsonb_build_object('native_mention_delivery_id', $4::text, 'drive_id', $5::text))`,
    [notification, fx.orgId, member2, delivery, drive]);
    const inbox = async () => {
      const body = await call(member2, 'GET', '/api/notifications', undefined, 200);
      return { listed: (body.notifications as any[]).some((row) => row.id === notification), unread: body.unread_count as number };
    };
    const before = await inbox();
    assert.equal(before.listed, true, 'listed while member2 can view the drive');
    await call(member, 'DELETE', `/api/drives/${drive}/members/${await memberRowId(drive, member2)}`, undefined, 200);
    const after = await inbox();
    assert.equal(after.listed, false, 'the readable mention does not keep it listed');
    // member2's drive_member notice for this drive goes too.
    assert.equal(after.unread, before.unread - 2, 'neither is counted');
  } finally {
    await q('DELETE FROM notifications WHERE id = $1', [notification]);
    await q('DELETE FROM native_mention_deliveries WHERE id = $1', [delivery]);
    await q('DELETE FROM native_reference_states WHERE id = $1', [state]);
    await q('DELETE FROM messages WHERE id = $1', [message]);
  }
});

test('someone an admin adds to a private drive gets their drive_member notice and the admin_change notice', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2 } = fx.people;
  const drive = await createDrive(member, { name: 'Admin adds', kind: 'private' });
  await addMember(admin, drive, { user: member2 }, 'view');
  const { rows } = await fx.client.query(`SELECT user_id, metadata->>'subtype' AS subtype FROM notifications
    WHERE org_id = $1 AND metadata->>'drive_id' = $2 ORDER BY user_id, subtype`, [fx.orgId, drive]);
  const byPerson = (id: string) => rows.filter((row) => row.user_id === id).map((row) => row.subtype).sort();
  assert.deepEqual(byPerson(member2), ['admin_change', 'drive_member'], 'the person added gets both');
  assert.deepEqual(byPerson(member), ['admin_change']);
  assert.deepEqual(byPerson(admin), [], 'never the admin who acted');
});

test('a direct grant tells the named person, agent included; a chat grant tells only the chat’s humans', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { agentUser, guest, member, member2 } = fx.people;
  const drive = await createDrive(member, { name: 'Agent told', kind: 'private' });
  const toldFor = async () => (await fx!.client.query(`SELECT user_id FROM notifications
    WHERE org_id = $1 AND metadata->>'drive_id' = $2 AND metadata->>'subtype' = 'drive_member'`, [fx!.orgId, drive])).rows.map((row) => row.user_id);
  await addMember(member, drive, { user: agentUser }, 'view');
  assert.deepEqual(await toldFor(), [agentUser], 'an agent with an active employee, named directly');
  await addMember(member, drive, { space: fx.spaces.team }, 'view');
  const told = await toldFor();
  assert.deepEqual(told.filter((id) => id !== agentUser).sort(), [member2, guest].sort(), 'the humans in the chat, apart from the actor');
  assert.equal(told.filter((id) => id === agentUser).length, 1, 'the chat grant does not tell the agent again');
});

test('adding a person or a chat, or linking a chat, tells the people it reaches apart from the actor', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { agentUser, guest, member, member2 } = fx.people;
  const told = async (drive: string) => (await fx!.client.query(`SELECT user_id, metadata FROM notifications
    WHERE org_id = $1 AND metadata->>'drive_id' = $2 ORDER BY user_id`, [fx!.orgId, drive])).rows;
  const byPerson = await createDrive(member, { name: 'Told by person', kind: 'private' });
  await addMember(member, byPerson, { user: member2 }, 'view');
  assert.deepEqual((await told(byPerson)).map((row) => [row.user_id, row.metadata.subtype]), [[member2, 'drive_member']]);
  const byChat = await createDrive(member, { name: 'Told by chat', kind: 'private' });
  await addMember(member, byChat, { space: fx.spaces.team }, 'view');
  assert.deepEqual((await told(byChat)).map((row) => row.user_id).sort(), [member2, guest].sort(), 'the humans in the chat, not the agent, not the actor');
  const byLink = await createDrive(member, { name: 'Told by link', kind: 'private' });
  await call(member, 'POST', `/api/drives/${byLink}/link-space`, { space_id: fx.spaces.team, role: 'view' }, 201);
  assert.deepEqual((await told(byLink)).map((row) => row.user_id).sort(), [member2, guest].sort());
  assert.ok(!(await told(byLink)).some((row) => row.user_id === agentUser));
  await call(member, 'DELETE', `/api/drives/${byLink}/link-space/${fx.spaces.team}`, undefined, 200);
});

test('a link row follows the link rule on every endpoint: the admin path never changes it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2 } = fx.people;
  const drive = await createDrive(member2, { name: 'Linked, admin-listed', kind: 'private' });
  await call(member2, 'POST', `/api/drives/${drive}/link-space`, { space_id: fx.spaces.other, role: 'comment' }, 201);
  const linkRow = await memberRowId(drive, fx.spaces.other);
  try {
    assert.equal((await call(admin, 'GET', `/api/drives/${drive}/members`, undefined, 200)).admin_path, true);
    assert.equal((await call(admin, 'PATCH', `/api/drives/${drive}/members/${linkRow}`, { role: 'view' }, 403)).code, 'FORBIDDEN_ROLE');
    assert.equal((await call(admin, 'DELETE', `/api/drives/${drive}/members/${linkRow}`, undefined, 403)).code, 'FORBIDDEN_ROLE');
    // A full member who isn't in the chat may lower the link but not raise it.
    await addMember(member2, drive, { user: member }, 'full');
    assert.equal((await call(member, 'PATCH', `/api/drives/${drive}/members/${linkRow}`, { role: 'edit' }, 403)).code, 'SPACE_MEMBERSHIP_REQUIRED');
    await call(member, 'PATCH', `/api/drives/${drive}/members/${linkRow}`, { role: 'view' }, 200);
    // In the chat: raising is allowed.
    assert.equal((await call(member2, 'PATCH', `/api/drives/${drive}/members/${linkRow}`, { role: 'edit' }, 200)).member.role, 'edit');
  } finally {
    await call(member2, 'DELETE', `/api/drives/${drive}/link-space/${fx.spaces.other}`, undefined, 200);
  }
});

test('a grant is raised only for someone who can hold access; a stale grant can still be lowered and removed', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const person = await fx.addPerson();
  const drive = await createDrive(member, { name: 'Stale grants', kind: 'private' });
  await addMember(member, drive, { user: person }, 'comment');
  const row = await memberRowId(drive, person);
  await fx.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx.orgId, person]);
  assert.equal((await call(member, 'PATCH', `/api/drives/${drive}/members/${row}`, { role: 'edit' }, 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  const { rows: [unchanged] } = await fx.client.query('SELECT role FROM drive_members WHERE id = $1', [row]);
  assert.equal(unchanged.role, 'comment');
  assert.equal((await call(member, 'PATCH', `/api/drives/${drive}/members/${row}`, { role: 'view' }, 200)).member.role, 'view');
  await call(member, 'DELETE', `/api/drives/${drive}/members/${row}`, undefined, 200);

  // ensurePersonalDrive makes no drive and no grant for someone who can't hold access.
  const noEmployeeAgent = await fx.addPerson({ kind: 'agent' });
  for (const nobody of [person, noEmployeeAgent]) {
    await assert.rejects(ensurePersonalDrive(fx.orgId, nobody), PrincipalCannotHoldAccessError);
    const { rows } = await fx.client.query('SELECT id FROM drives WHERE org_id = $1 AND owner_user_id = $2', [fx.orgId, nobody]);
    assert.deepEqual(rows, []);
  }
});

test('member changes on several drives at once finish: chat checks run on the drive transaction, not a second connection', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member2 } = fx.people;
  // The API pool holds 4 connections. Each change holds one, with its drive row locked, while it checks the chat.
  const many: string[] = [];
  for (let at = 0; at < 6; at += 1) many.push(await createDrive(member2, { name: `Concurrent ${at}`, kind: 'private' }));
  const started = Date.now();
  const responses = await Promise.all(many.map((drive) => fx!.request(member2, 'POST', `/api/drives/${drive}/members`,
    { principal_type: 'space', principal_id: fx!.spaces.other, role: 'view' })));
  assert.deepEqual(responses.map((res) => res.status), many.map(() => 201));
  assert.ok(Date.now() - started < 4_000, `took ${Date.now() - started} ms`);
});

test('a notification naming a document fails closed: with a drive it needs that drive, and without one it is never shown', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const drive = await createDrive(member, { name: 'Document notices', kind: 'private' });
  await addMember(member, drive, { user: member2 }, 'view');
  const [withDrive, withoutDrive] = [randomUUID(), randomUUID()];
  await fx.client.query(`INSERT INTO notifications (id, org_id, user_id, type, title, metadata) VALUES
    ($1, $3, $4, 'system', 'A document', jsonb_build_object('document_id', $5::text, 'drive_id', $6::text)),
    ($2, $3, $4, 'system', 'A document', jsonb_build_object('document_id', $7::text))`,
  [withDrive, withoutDrive, fx.orgId, member2, randomUUID(), drive, randomUUID()]);
  const inbox = async () => {
    const body = await call(member2, 'GET', '/api/notifications', undefined, 200);
    const ids = new Set((body.notifications as any[]).map((row) => row.id));
    return { withDrive: ids.has(withDrive), withoutDrive: ids.has(withoutDrive), unread: body.unread_count as number };
  };
  const before = await inbox();
  assert.equal(before.withDrive, true, 'naming a drive member2 can view');
  assert.equal(before.withoutDrive, false, 'a document with no drive is never shown (no document rule yet)');
  await call(member, 'DELETE', `/api/drives/${drive}/members/${await memberRowId(drive, member2)}`, undefined, 200);
  const after = await inbox();
  assert.equal(after.withDrive, false, 'a document_id does not skip the drive check');
  assert.equal(after.withoutDrive, false);
  assert.equal(after.unread, before.unread - 2, 'this notice and the drive_member notice leave the count');
});

test('the dashboard unread count leaves out a drive notification once drive access ends', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const drive = await createDrive(member, { name: 'Dashboard count', kind: 'private' });
  await addMember(member, drive, { user: member2 }, 'view');
  const unread = async () => (await call(member2, 'GET', '/api/dashboard', undefined, 200)).unread_notifications as number;
  const before = await unread();
  await call(member, 'DELETE', `/api/drives/${drive}/members/${await memberRowId(drive, member2)}`, undefined, 200);
  assert.equal(await unread(), before - 1, 'the drive_member notice is no longer counted');
});

test('a stale chat grant can be lowered and removed: the principal is checked only when it is written', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const q = (text: string, values: unknown[]) => fx!.client.query(text, values);
  const chat = randomUUID();
  await q(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)`, [chat, fx.orgId, `moving-${chat.slice(0, 8)}`, member]);
  await q('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $3, $4), ($2, $3, $5)', [randomUUID(), randomUUID(), chat, member, member2]);
  const drive = await createDrive(member, { name: 'Stale chat', kind: 'private' });
  await addMember(member, drive, { space: chat }, 'edit');
  const row = await memberRowId(drive, chat);
  const document = await fx.insertDocument({ driveId: drive, title: 'Shared with the chat' });
  await fx.share(document, { space: chat }, 'edit');
  // The chat moves to the other workspace: both grants are stale.
  await q('UPDATE spaces SET org_id = $1 WHERE id = $2', [fx.otherOrgId, chat]);

  resetEvents();
  const generation = currentAccessGeneration();
  assert.equal((await call(member, 'PATCH', `/api/drives/${drive}/members/${row}`, { role: 'view' }, 200)).member.role, 'view');
  assertOneLoss({ orgId: fx.orgId, driveId: drive, spaceId: chat }, generation);
  // Raising it is a new grant, and the chat is no longer this workspace's.
  assert.equal((await call(member, 'PATCH', `/api/drives/${drive}/members/${row}`, { role: 'edit' }, 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  // A role-only change of a stale share is allowed too (F9 lowers shares this way).
  await q(`UPDATE document_shares SET role = 'view' WHERE document_id = $1 AND principal_id = $2`, [document, chat]);
  await call(member, 'DELETE', `/api/drives/${drive}/members/${row}`, undefined, 200);

  // Writing a principal of another workspace is still refused, on insert and on an update of the principal.
  const refused = (error: any) => error?.code === '23503';
  await assert.rejects(q(`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role) VALUES ($1, $2, $3, 'space', $4, 'view')`,
    [randomUUID(), fx.orgId, drive, chat]), refused);
  await assert.rejects(q('UPDATE drive_members SET principal_id = $1 WHERE drive_id = $2 AND principal_id = $3', [fx.people.outsider, drive, member]), refused);
  await assert.rejects(q('UPDATE document_shares SET principal_id = principal_id WHERE document_id = $1 AND principal_id = $2', [document, chat]), refused);
  await assert.rejects(q(`INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role) VALUES ($1, $2, $3, 'user', $4, 'view')`,
    [randomUUID(), fx.orgId, document, fx.people.outsider]), refused);
});

async function waitUntil(cond: () => Promise<boolean>, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(await cond(), `timed out: ${label}`);
}

test('a demotion cannot commit in the middle of an admin-path member add: it waits, and the add commits as an admin change', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2, owner } = fx.people;
  const drive = await createDrive(member, { name: 'Racing an admin', kind: 'private' });
  const waitingOn = async (event: string) => (await fx!.client.query(`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = $1`, [event])).rows[0].n as number;
  // A second connection holds the drive row, so the add stops there, after its first locks.
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM drives WHERE id = $1 FOR UPDATE', [drive]);
    const add = fx.request(admin, 'POST', `/api/drives/${drive}/members`, { principal_type: 'user', principal_id: member2, role: 'view' });
    await waitUntil(async () => (await waitingOn('transactionid')) + (await waitingOn('tuple')) > 0, 'the add is waiting on the drive row');
    let demotionDone = false;
    const demotion = fx.request(owner, 'PATCH', `/api/members/${admin}`, { role: 'member' }).then((res) => { demotionDone = true; return res; });
    await waitUntil(async () => demotionDone || (await waitingOn('advisory')) > 0, 'the demotion is waiting on the admin’s room-access lock');
    assert.equal(demotionDone, false, 'the demotion has not committed while the add is open');
    await holder.query('ROLLBACK');
    const added = await add;
    assert.equal(added.status, 201, await added.clone().text());
    assert.equal((await demotion).status, 200);
    const { rows: audits } = await fx.client.query(`SELECT actor_id FROM audit_log WHERE org_id = $1 AND entity_id = $2 AND action = 'drive_member_changed_by_admin'`,
      [fx.orgId, drive]);
    assert.deepEqual(audits.map((row) => row.actor_id), [admin], 'the add committed as the admin’s change, before the demotion');
    const { rows: [after] } = await fx.client.query('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [fx.orgId, admin]);
    assert.equal(after.role, 'member', 'then the demotion committed');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
    await fx.client.query(`UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [fx.orgId, admin]);
  }
});

test('the drive routes answer a drive of another workspace with 404', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { rows: [foreign] } = await fx.client.query(`INSERT INTO drives (id, org_id, name, kind, default_role) VALUES ($1, $2, 'Elsewhere', 'open', 'edit') RETURNING id`,
    [randomUUID(), fx.otherOrgId]);
  for (const [method, path] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['GET', '/members'], ['POST', '/pin']] as const) {
    assert.equal((await call(fx.people.owner, method, `/api/drives/${foreign.id}${path}`, method === 'PATCH' ? { name: 'x' } : undefined, 404)).code, 'NOT_FOUND');
  }
});
