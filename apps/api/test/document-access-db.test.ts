/**
 * The one access check for documents and drives (lib/document-access.ts,
 * spec 5.2 and consult rule C7). Each rule is asserted through
 * `documentRoleFor`; the last tests check that the list conditions
 * (`visibleDocumentCondition`, `visibleDocumentIdSql`, `visibleDriveCondition`)
 * give exactly the answer of the role lookups for every person, document,
 * drive and role in the fixture.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-access-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DOC_ROLES, documents, drives } from '@deft/db/documents';
import { closeDb, db } from '../src/lib/db.js';
import {
  DOC_ROLE_RANK,
  adminListedDriveCondition,
  documentRoleFor,
  driveRoleFor,
  roleAtLeast,
  spaceMembersWhoCannotOpen,
  visibleDocumentCondition,
  visibleDocumentIdSql,
  visibleDriveCondition,
  type DocRole,
} from '../src/lib/document-access.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let fx: DrivesFixture | undefined;

/** A route that answers with the user the fixture's request stub set, to check `request`. */
const probe = new Hono();
probe.all('/', async (c) => c.json({ user: c.get('user'), method: c.req.method, body: await c.req.json().catch(() => null) }));

before(async () => {
  if (url) fx = await setupDrivesFixture('document-access', { routes: [{ path: '/api/drives-probe', app: probe }] });
});

after(async () => {
  try {
    await fx?.teardown();
  } finally {
    await closeDb();
  }
});

const roleOf = (userId: string, documentId: string, orgId = fx!.orgId) => documentRoleFor(userId, orgId, documentId);
const driveRoleOf = (userId: string, driveId: string, orgId = fx!.orgId) => driveRoleFor(userId, orgId, driveId);

/** Each person's role on `documentId`, by name. */
async function rolesOn(documentId: string, orgId = fx!.orgId): Promise<Record<string, DocRole | null>> {
  const out: Record<string, DocRole | null> = {};
  for (const [name, id] of Object.entries(fx!.people)) out[name] = await roleOf(id, documentId, orgId);
  return out;
}

const rejoin = (spaceId: string, userId: string) => fx!.client.query(
  'INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (space_id, user_id) DO NOTHING', [randomUUID(), spaceId, userId]);

test('roles rank view, comment, edit, full', () => {
  assert.deepEqual(DOC_ROLE_RANK, { view: 1, comment: 2, edit: 3, full: 4 });
  assert.equal(roleAtLeast('edit', 'comment'), true);
  assert.equal(roleAtLeast('edit', 'edit'), true);
  assert.equal(roleAtLeast('comment', 'edit'), false);
  assert.equal(roleAtLeast('full', 'full'), true);
  assert.equal(roleAtLeast(null, 'view'), false);
  assert.throws(() => visibleDocumentCondition('someone', 'org', 'owner' as DocRole), /unknown document role/);
});

test("the fixture's request mounts the routes it is given, as the person asking", async (t) => {
  if (!fx) return t.skip(SKIP);
  const asGuest = await fx.request(fx.people.guest, 'POST', '/api/drives-probe', { hello: 'there' });
  assert.equal(asGuest.status, 200);
  const guest = await asGuest.json() as { user: { id: string; org_id: string; role: string }; method: string; body: unknown };
  assert.deepEqual([guest.user.id, guest.user.org_id, guest.user.role, guest.method, guest.body],
    [fx.people.guest, fx.orgId, 'guest', 'POST', { hello: 'there' }]);
  const outsider = await (await fx.request(fx.people.outsider, 'GET', '/api/drives-probe')).json() as { user: { org_id: string; role: string } };
  assert.deepEqual([outsider.user.org_id, outsider.user.role], [fx.otherOrgId, 'member']);
  assert.equal((await fx.request(fx.people.member, 'GET', '/api/nowhere')).status, 404);
});

test('a direct drive member gets their role', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const drive = await fx.insertDrive({ kind: 'private', name: 'Direct members' });
  await fx.addDriveMember(drive, { user: people.member2 }, 'full');
  await fx.addDriveMember(drive, { user: people.guest }, 'edit');
  await fx.addDriveMember(drive, { user: people.member }, 'comment');
  await fx.addDriveMember(drive, { user: people.agentUser }, 'view');
  const doc = await fx.insertDocument({ driveId: drive, title: 'Direct' });
  const folder = await fx.insertFolder({ driveId: drive });
  const inFolder = await fx.insertDocument({ driveId: drive, folderId: folder });
  const subPage = await fx.insertDocument({ driveId: drive, parentDocumentId: doc });
  const expected = { owner: null, admin: null, member: 'comment', member2: 'full', guest: 'edit', agentUser: 'view', outsider: null };
  for (const id of [doc, inFolder, subPage]) assert.deepEqual(await rolesOn(id), expected);
  assert.equal(await driveRoleOf(people.member, drive), 'comment');
  assert.equal(await driveRoleOf(people.member2, drive), 'full');
  assert.equal(await driveRoleOf(people.owner, drive), null);
});

test('a chat that is a drive member gives its members the role; leaving the chat removes it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, spaces } = fx;
  // The team chat is public: only its members get the drive's role, not everyone who could read the chat.
  const drive = await fx.insertDrive({ kind: 'private', name: 'Team drive' });
  await fx.addDriveMember(drive, { space: spaces.team }, 'edit');
  const doc = await fx.insertDocument({ driveId: drive });
  assert.deepEqual(await rolesOn(doc), { owner: null, admin: null, member: 'edit', member2: 'edit', guest: 'edit', agentUser: 'edit', outsider: null });
  assert.equal(await driveRoleOf(people.guest, drive), 'edit');
  await fx.removeSpaceMember(spaces.team, people.guest);
  try {
    assert.equal(await roleOf(people.guest, doc), null);
    assert.equal(await driveRoleOf(people.guest, drive), null);
    assert.equal(await roleOf(people.member, doc), 'edit', 'the others keep it');
  } finally {
    await rejoin(spaces.team, people.guest);
  }
});

test("an open drive gives full human members its default role", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const workspaceDoc = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'In Workspace' });
  assert.equal(await roleOf(people.member, workspaceDoc), 'edit', 'Workspace: can edit');
  assert.equal(await roleOf(people.member2, workspaceDoc), 'edit');
  for (const defaultRole of ['comment', 'view'] as const) {
    const drive = await fx.insertDrive({ kind: 'open', defaultRole, name: `Open ${defaultRole}` });
    const doc = await fx.insertDocument({ driveId: drive });
    assert.equal(await roleOf(people.member, doc), defaultRole);
    assert.equal(await roleOf(people.member2, doc), defaultRole);
    assert.equal(await driveRoleOf(people.member, drive), defaultRole);
  }
  // A direct role above the default wins; one below it doesn't lower it.
  const drive = await fx.insertDrive({ kind: 'open', defaultRole: 'comment', name: 'Open with members' });
  await fx.addDriveMember(drive, { user: people.member }, 'full');
  await fx.addDriveMember(drive, { user: people.member2 }, 'view');
  const doc = await fx.insertDocument({ driveId: drive });
  assert.equal(await roleOf(people.member, doc), 'full');
  assert.equal(await roleOf(people.member2, doc), 'comment');
});

test("a guest never gets an open drive's default role", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, spaces } = fx;
  const workspaceDoc = await fx.insertDocument({ driveId: fx.workspaceDriveId });
  assert.equal(await roleOf(people.guest, workspaceDoc), null);
  assert.equal(await driveRoleOf(people.guest, fx.workspaceDriveId), null);
  // Only what names the guest or a chat they're in.
  const drive = await fx.insertDrive({ kind: 'open', defaultRole: 'edit', name: 'Open with the team chat' });
  await fx.addDriveMember(drive, { space: spaces.team }, 'view');
  const doc = await fx.insertDocument({ driveId: drive });
  assert.equal(await roleOf(people.guest, doc), 'view');
  assert.equal(await roleOf(people.member, doc), 'edit', 'a member keeps the default above the chat role');
});

test("an agent user never gets an open drive's default role", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const doc = await fx.insertDocument({ driveId: fx.workspaceDriveId });
  assert.equal(await roleOf(people.agentUser, doc), null);
  // Not even as an owner or admin of the workspace.
  for (const role of ['admin', 'owner']) {
    await fx.client.query('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [fx.orgId, people.agentUser, role]);
    try {
      assert.equal(await roleOf(people.agentUser, doc), null, `an agent user with the ${role} role`);
      assert.equal(await driveRoleOf(people.agentUser, fx.workspaceDriveId), null);
    } finally {
      await fx.client.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [fx.orgId, people.agentUser]);
    }
  }
  await fx.share(doc, { user: people.agentUser }, 'comment');
  assert.equal(await roleOf(people.agentUser, doc), 'comment', 'a direct share still counts');
});

test('owners and admins have full access on open drives', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const workspaceDoc = await fx.insertDocument({ driveId: fx.workspaceDriveId });
  const viewDrive = await fx.insertDrive({ kind: 'open', defaultRole: 'view', name: 'Open, view' });
  const viewDoc = await fx.insertDocument({ driveId: viewDrive });
  for (const person of [people.owner, people.admin]) {
    assert.equal(await roleOf(person, workspaceDoc), 'full');
    assert.equal(await roleOf(person, viewDoc), 'full');
    assert.equal(await driveRoleOf(person, fx.workspaceDriveId), 'full');
    assert.equal(await driveRoleOf(person, viewDrive), 'full');
  }
});

test('an admin gets nothing from a private drive until added', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const drive = await fx.insertDrive({ kind: 'private', name: 'Private, admin listed' });
  await fx.addDriveMember(drive, { user: people.member }, 'full');
  const doc = await fx.insertDocument({ driveId: drive });
  for (const person of [people.admin, people.owner]) {
    assert.equal(await roleOf(person, doc), null);
    assert.equal(await driveRoleOf(person, drive), null);
  }
  // Owners and admins see it listed (F4 lets them manage its members), but can't open it.
  const listed = async (userId: string) => (await db.select({ id: drives.id }).from(drives)
    .where(and(eq(drives.id, drive), adminListedDriveCondition(userId, fx!.orgId)))).length === 1;
  assert.deepEqual([await listed(people.owner), await listed(people.admin), await listed(people.member), await listed(people.guest)],
    [true, true, false, false]);
  await fx.addDriveMember(drive, { user: people.admin }, 'view');
  assert.equal(await roleOf(people.admin, doc), 'view');
  assert.equal(await roleOf(people.owner, doc), null);
});

test("a personal drive's owner has full access", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: people.member, name: 'My drive' });
  const doc = await fx.insertDocument({ driveId: drive });
  assert.deepEqual(await rolesOn(doc), { owner: null, admin: null, member: 'full', member2: null, guest: null, agentUser: null, outsider: null });
  assert.equal(await driveRoleOf(people.member, drive), 'full');
  // Never listed for owners and admins.
  const listed = await db.select({ id: drives.id }).from(drives).where(and(eq(drives.id, drive), adminListedDriveCondition(people.admin, fx.orgId)));
  assert.equal(listed.length, 0);
});

test("a frozen drive gives nothing to its former owner, an owner or an admin", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const personal = await fx.insertDrive({ kind: 'personal', ownerUserId: people.member2, frozen: true, name: "Member 2's drive" });
  // Even grants that name them give nothing while it is frozen.
  await fx.addDriveMember(personal, { user: people.owner }, 'full');
  await fx.addDriveMember(personal, { user: people.admin }, 'edit');
  const doc = await fx.insertDocument({ driveId: personal });
  const frozenOpen = await fx.insertDrive({ kind: 'open', defaultRole: 'edit', frozen: true, name: 'Frozen open' });
  const openDoc = await fx.insertDocument({ driveId: frozenOpen });
  for (const id of [doc, openDoc]) {
    assert.deepEqual(await rolesOn(id), { owner: null, admin: null, member: null, member2: null, guest: null, agentUser: null, outsider: null });
  }
  for (const person of [people.member2, people.owner, people.admin, people.member]) {
    assert.equal(await driveRoleOf(person, personal), null);
    assert.equal(await driveRoleOf(person, frozenOpen), null);
  }
  const listed = await db.select({ id: drives.id }).from(drives)
    .where(and(inArray(drives.id, [personal, frozenOpen]), adminListedDriveCondition(people.admin, fx.orgId)));
  assert.equal(listed.length, 0, 'a frozen drive is not listed for admins');
});

test('a share out of a frozen drive still gives view, never more', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, spaces } = fx;
  const drive = await fx.insertDrive({ kind: 'personal', ownerUserId: people.admin, frozen: true, name: "Admin's drive" });
  const doc = await fx.insertDocument({ driveId: drive });
  await fx.share(doc, { user: people.member }, 'edit');
  await fx.share(doc, { space: spaces.other }, 'comment');
  await fx.share(doc, { user: people.guest }, 'view');
  assert.deepEqual(await rolesOn(doc), { owner: null, admin: null, member: 'view', member2: 'view', guest: 'view', agentUser: null, outsider: null });
  const visible = async (userId: string, min: DocRole) => (await db.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.id, doc), visibleDocumentCondition(userId, fx!.orgId, min)))).length === 1;
  assert.equal(await visible(people.member, 'view'), true);
  assert.equal(await visible(people.member, 'comment'), false);
  assert.equal(await visible(people.member, 'edit'), false);
  // Unfrozen (handed over), the shares give their own roles again.
  await fx.client.query('UPDATE drives SET frozen_at = NULL WHERE id = $1', [drive]);
  assert.equal(await roleOf(people.member, doc), 'edit');
  assert.equal(await roleOf(people.member2, doc), 'comment');
  await fx.client.query('UPDATE drives SET frozen_at = now() WHERE id = $1', [drive]);
});

test('a direct share and a chat share both count; the highest role wins (drive view + share edit → edit)', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, spaces } = fx;
  const drive = await fx.insertDrive({ kind: 'private', name: 'Shared out' });
  await fx.addDriveMember(drive, { user: people.member }, 'view');
  const editShared = await fx.insertDocument({ driveId: drive, title: 'drive view + share edit' });
  await fx.share(editShared, { user: people.member }, 'edit');
  assert.equal(await roleOf(people.member, editShared), 'edit');
  const chatShared = await fx.insertDocument({ driveId: drive, title: 'chat share' });
  await fx.share(chatShared, { space: spaces.team }, 'comment');
  await fx.share(chatShared, { user: people.member2 }, 'view');
  assert.deepEqual(await rolesOn(chatShared),
    { owner: null, admin: null, member: 'comment', member2: 'comment', guest: 'comment', agentUser: 'comment', outsider: null });
  const both = await fx.insertDocument({ driveId: drive, title: 'direct edit + chat view' });
  await fx.share(both, { user: people.guest }, 'edit');
  await fx.share(both, { space: spaces.team }, 'view');
  assert.equal(await roleOf(people.guest, both), 'edit');
  assert.equal(await roleOf(people.member2, both), 'view');
  // A share never lowers a higher role: open default and full stay.
  const workspaceDoc = await fx.insertDocument({ driveId: fx.workspaceDriveId });
  await fx.share(workspaceDoc, { user: people.member }, 'view');
  await fx.share(workspaceDoc, { user: people.owner }, 'view');
  assert.equal(await roleOf(people.member, workspaceDoc), 'edit');
  assert.equal(await roleOf(people.owner, workspaceDoc), 'full');
  // A share of one document gives nothing on its drive, its sub-pages or its siblings.
  assert.equal(await driveRoleOf(people.guest, drive), null);
  const subPage = await fx.insertDocument({ driveId: drive, parentDocumentId: both });
  assert.equal(await roleOf(people.guest, subPage), null);
});

test('a deleted document and a deleted drive give nothing', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const deletedDoc = await fx.insertDocument({ driveId: fx.workspaceDriveId, deleted: true });
  await fx.share(deletedDoc, { user: people.guest }, 'edit');
  assert.deepEqual(await rolesOn(deletedDoc), { owner: null, admin: null, member: null, member2: null, guest: null, agentUser: null, outsider: null });
  const drive = await fx.insertDrive({ kind: 'open', defaultRole: 'edit', name: 'Deleted drive' });
  await fx.addDriveMember(drive, { user: people.guest }, 'full');
  const doc = await fx.insertDocument({ driveId: drive });
  await fx.share(doc, { user: people.agentUser }, 'edit');
  assert.equal(await roleOf(people.member, doc), 'edit', 'before the drive is deleted');
  await fx.client.query('UPDATE drives SET is_deleted = true, deleted_at = now() WHERE id = $1', [drive]);
  assert.deepEqual(await rolesOn(doc), { owner: null, admin: null, member: null, member2: null, guest: null, agentUser: null, outsider: null });
  for (const person of Object.values(people)) assert.equal(await driveRoleOf(person, drive), null);
});

test("another org's member gets nothing", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, orgId, otherOrgId } = fx;
  const doc = await fx.insertDocument({ driveId: fx.workspaceDriveId });
  assert.equal(await roleOf(people.outsider, doc), null);
  assert.equal(await roleOf(people.outsider, doc, otherOrgId), null, 'asked in their own workspace');
  assert.equal(await roleOf(people.member, doc, otherOrgId), null, 'a document is only found in its own workspace');
  // The triggers refuse a grant naming someone, or a chat, of another workspace.
  await assert.rejects(fx.share(doc, { user: people.outsider }, 'edit'), /not in workspace/);
  const otherDrive = randomUUID();
  await fx.client.query(`INSERT INTO drives (id, org_id, name, kind, default_role) VALUES ($1, $2, 'Their Workspace', 'open', 'edit')`,
    [otherDrive, otherOrgId]);
  await assert.rejects(fx.addDriveMember(otherDrive, { space: fx.spaces.team }, 'edit'), /not in workspace/);
  // Their open drive gives them its default; nobody of this workspace gets anything from it.
  const otherDoc = await fx.insertDocument({ driveId: otherDrive });
  assert.equal(await roleOf(people.outsider, otherDoc, otherOrgId), 'edit');
  for (const [name, person] of Object.entries(people)) {
    if (person === people.outsider) continue;
    assert.equal(await roleOf(person, otherDoc, otherOrgId), null, `${name}, in the other workspace`);
    assert.equal(await roleOf(person, otherDoc, orgId), null, `${name}, asked in their own workspace`);
  }
  assert.equal(await driveRoleOf(people.owner, otherDrive, otherOrgId), null);
  // Someone in both workspaces opens the other workspace's document only when asked there.
  await fx.client.query("INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')", [randomUUID(), otherOrgId, people.member]);
  try {
    assert.equal(await roleOf(people.member, otherDoc, otherOrgId), 'edit');
    assert.equal(await roleOf(people.member, otherDoc, orgId), null);
    assert.equal(await driveRoleOf(people.member, otherDrive, orgId), null);
    const asked = async (org: string) => (await db.select({ id: documents.id }).from(documents)
      .where(and(eq(documents.id, otherDoc), visibleDocumentIdSql(people.member, org, sql`${documents.id}`)))).length;
    assert.deepEqual([await asked(otherOrgId), await asked(orgId)], [1, 0]);
  } finally {
    await fx.client.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [otherOrgId, people.member]);
  }
  // A chat grant counts only while the chat is in the document's workspace (the triggers check it only when the grant is written).
  const chatDrive = await fx.insertDrive({ kind: 'private', name: 'Chat of this workspace' });
  await fx.addDriveMember(chatDrive, { space: fx.spaces.other }, 'edit');
  const inChatDrive = await fx.insertDocument({ driveId: chatDrive });
  const sharedWithChat = await fx.insertDocument({ driveId: fx.workspaceDriveId });
  await fx.share(sharedWithChat, { space: fx.spaces.other }, 'comment');
  await fx.share(sharedWithChat, { user: people.member2 }, 'view');
  // As a guest, so the Workspace drive's default role doesn't hide what the shares give.
  await fx.client.query('UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2', [orgId, people.member2, 'guest']);
  try {
    assert.deepEqual([await roleOf(people.member2, inChatDrive), await roleOf(people.member2, sharedWithChat)], ['edit', 'comment']);
    await fx.client.query('UPDATE spaces SET org_id = $2 WHERE id = $1', [fx.spaces.other, otherOrgId]);
    try {
      assert.deepEqual([await roleOf(people.member2, inChatDrive), await roleOf(people.member2, sharedWithChat)], [null, 'view'],
        'a chat moved to another workspace grants nothing here; the direct share still does');
      assert.equal(await driveRoleOf(people.member2, chatDrive), null);
    } finally {
      await fx.client.query('UPDATE spaces SET org_id = $2 WHERE id = $1', [fx.spaces.other, orgId]);
    }
  } finally {
    await fx.client.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, people.member2]);
  }
});

test('an inactive member gets nothing from any branch', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, spaces } = fx;
  const direct = await fx.insertDrive({ kind: 'private', name: 'Inactive: direct' });
  await fx.addDriveMember(direct, { user: people.member2 }, 'edit');
  const viaChat = await fx.insertDrive({ kind: 'private', name: 'Inactive: chat' });
  await fx.addDriveMember(viaChat, { space: spaces.other }, 'edit');
  const sharing = await fx.insertDrive({ kind: 'private', name: 'Inactive: shares' });
  const docs = {
    direct: await fx.insertDocument({ driveId: direct }),
    viaChat: await fx.insertDocument({ driveId: viaChat }),
    openDefault: await fx.insertDocument({ driveId: fx.workspaceDriveId }),
    directShare: await fx.insertDocument({ driveId: sharing }),
    chatShare: await fx.insertDocument({ driveId: sharing }),
  };
  await fx.share(docs.directShare, { user: people.member2 }, 'edit');
  await fx.share(docs.chatShare, { space: spaces.other }, 'view');
  const roles = async () => Object.fromEntries(await Promise.all(Object.entries(docs).map(async ([name, id]) => [name, await roleOf(people.member2, id)])));
  assert.deepEqual(await roles(), { direct: 'edit', viaChat: 'edit', openDefault: 'edit', directShare: 'edit', chatShare: 'view' });
  assert.equal(await roleOf(people.admin, docs.openDefault), 'full');
  await fx.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = ANY($2::text[])', [fx.orgId, [people.member2, people.admin]]);
  try {
    assert.deepEqual(await roles(), { direct: null, viaChat: null, openDefault: null, directShare: null, chatShare: null });
    assert.equal(await roleOf(people.admin, docs.openDefault), null, 'an inactive admin');
    for (const drive of [direct, viaChat, fx.workspaceDriveId]) {
      assert.equal(await driveRoleOf(people.member2, drive), null);
      assert.equal(await driveRoleOf(people.admin, drive), null);
    }
    const listed = await db.select({ id: documents.id }).from(documents).where(visibleDocumentCondition(people.member2, fx.orgId));
    assert.deepEqual(listed, [], 'the list condition shows them nothing');
    const drivesListed = await db.select({ id: drives.id }).from(drives).where(adminListedDriveCondition(people.admin, fx.orgId));
    assert.deepEqual(drivesListed, [], 'nor are private drives listed for an inactive admin');
  } finally {
    await fx.client.query('UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = ANY($2::text[])', [fx.orgId, [people.member2, people.admin]]);
  }
});

test('an archived chat still grants its members; a former member gets nothing', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, spaces } = fx;
  const drive = await fx.insertDrive({ kind: 'private', name: 'Archived chat drive' });
  await fx.addDriveMember(drive, { space: spaces.team }, 'comment');
  const inDrive = await fx.insertDocument({ driveId: drive });
  const elsewhere = await fx.insertDrive({ kind: 'private', name: 'Elsewhere' });
  const shared = await fx.insertDocument({ driveId: elsewhere });
  await fx.share(shared, { space: spaces.team }, 'view');
  await fx.client.query('UPDATE spaces SET is_archived = true WHERE id = $1', [spaces.team]);
  try {
    assert.equal(await roleOf(people.member, inDrive), 'comment');
    assert.equal(await roleOf(people.member, shared), 'view');
    assert.equal(await driveRoleOf(people.member, drive), 'comment');
    await fx.removeSpaceMember(spaces.team, people.member);
    assert.equal(await roleOf(people.member, inDrive), null);
    assert.equal(await roleOf(people.member, shared), null);
    assert.equal(await driveRoleOf(people.member, drive), null);
    assert.equal(await roleOf(people.member2, inDrive), 'comment', 'the members who stay keep it');
  } finally {
    await fx.client.query('UPDATE spaces SET is_archived = false WHERE id = $1', [spaces.team]);
    await rejoin(spaces.team, people.member);
  }
});

test('a deleted employee gets nothing from a direct grant', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, spaces } = fx;
  const drive = await fx.insertDrive({ kind: 'private', name: 'Agent drive' });
  await fx.addDriveMember(drive, { user: people.agentUser }, 'edit');
  const inDrive = await fx.insertDocument({ driveId: drive });
  const elsewhere = await fx.insertDrive({ kind: 'private', name: 'Agent shares' });
  const shared = await fx.insertDocument({ driveId: elsewhere });
  await fx.share(shared, { user: people.agentUser }, 'comment');
  const chatShared = await fx.insertDocument({ driveId: elsewhere });
  await fx.share(chatShared, { space: spaces.team }, 'view');
  const roles = async () => [await roleOf(people.agentUser, inDrive), await roleOf(people.agentUser, shared),
    await roleOf(people.agentUser, chatShared), await driveRoleOf(people.agentUser, drive)];
  assert.deepEqual(await roles(), ['edit', 'comment', 'view', 'edit']);
  // The agent user's own employee is the one users.agent_employee_id names. A second, active employee row
  // naming the same user in the same workspace grants nothing of its own.
  const { rows: [{ agent_employee_id: linked }] } = await fx.client.query('SELECT agent_employee_id FROM users WHERE id = $1', [people.agentUser]);
  assert.ok(linked, 'the fixture links the agent user to its employee');
  const second = randomUUID();
  await fx.client.query(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_active, is_byoa, runtime_kind, created_by)
    VALUES ($1, $2, $3, 'Second', $4, 'custom', 'Test.', 'conservative', true, true, 'custom_mcp', $5)`,
  [second, fx.orgId, people.agentUser, `second-${second}`, people.owner]);
  const setEmployee = (id: string, change: string) => fx!.client.query(`UPDATE agent_employees SET ${change} WHERE id = $1`, [id]);
  try {
    for (const [state, change, restore] of [
      ['deleted', 'is_deleted = true, deleted_at = now()', 'is_deleted = false, deleted_at = NULL'],
      ['paused', 'is_active = false', 'is_active = true'],
    ]) {
      await setEmployee(linked, change);
      try {
        assert.deepEqual(await roles(), [null, null, null, null], `a ${state} employee, with a second active row for the same user`);
      } finally {
        await setEmployee(linked, restore);
      }
      // The second row's state changes nothing.
      await setEmployee(second, change);
      try {
        assert.deepEqual(await roles(), ['edit', 'comment', 'view', 'edit'], `the second row ${state}, the linked employee active`);
      } finally {
        await setEmployee(second, restore);
      }
    }
    // The linked employee moved to another workspace: nothing here, though the second row is active here.
    await setEmployee(linked, `org_id = '${fx.otherOrgId}'`);
    try {
      assert.deepEqual(await roles(), [null, null, null, null], 'an employee of another workspace');
    } finally {
      await setEmployee(linked, `org_id = '${fx.orgId}'`);
    }
  } finally {
    await fx.client.query('DELETE FROM agent_employees WHERE id = $1', [second]);
  }
  assert.deepEqual(await roles(), ['edit', 'comment', 'view', 'edit'], 'restored');
});

test('overlapping grants through several chats and a direct grant give the highest role', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  // Member 2 sits in three more chats, each granting a different role on one drive and one document.
  const chats: Array<[string, DocRole]> = [[randomUUID(), 'view'], [randomUUID(), 'comment'], [randomUUID(), 'edit']];
  for (const [chat, role] of chats) {
    await fx.client.query("INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'private', $4)", [chat, fx.orgId, `overlap-${role}-${chat}`, people.owner]);
    await rejoin(chat, people.member2);
  }
  const drive = await fx.insertDrive({ kind: 'private', name: 'Overlapping chats' });
  for (const [chat, role] of chats) await fx.addDriveMember(drive, { space: chat }, role);
  const inDrive = await fx.insertDocument({ driveId: drive });
  const elsewhere = await fx.insertDrive({ kind: 'private', name: 'Overlapping shares' });
  const shared = await fx.insertDocument({ driveId: elsewhere });
  for (const [chat, role] of chats) await fx.share(shared, { space: chat }, role === 'edit' ? 'comment' : 'view');
  assert.deepEqual([await roleOf(people.member2, inDrive), await driveRoleOf(people.member2, drive), await roleOf(people.member2, shared)],
    ['edit', 'edit', 'comment'], 'the highest of the chats');
  // A direct grant below the chats changes nothing; one above them wins.
  await fx.addDriveMember(drive, { user: people.member2 }, 'view');
  await fx.share(shared, { user: people.member2 }, 'view');
  assert.deepEqual([await roleOf(people.member2, inDrive), await driveRoleOf(people.member2, drive), await roleOf(people.member2, shared)],
    ['edit', 'edit', 'comment']);
  await fx.addDriveMember(drive, { user: people.member2 }, 'full');
  await fx.share(shared, { user: people.member2 }, 'edit');
  assert.deepEqual([await roleOf(people.member2, inDrive), await driveRoleOf(people.member2, drive), await roleOf(people.member2, shared)],
    ['full', 'full', 'edit'], 'the direct grant above the chats');
  // Leaving the highest chat drops to the next one.
  await fx.addDriveMember(drive, { user: people.member2 }, 'view');
  await fx.removeSpaceMember(chats[2]![0], people.member2);
  assert.deepEqual([await roleOf(people.member2, inDrive), await driveRoleOf(people.member2, drive)], ['comment', 'comment'], 'the next chat');
});

test('spaceMembersWhoCannotOpen lists the chat members who cannot open a document, and counts the guests among them', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, spaces } = fx;
  const sorted = (ids: string[]) => [...ids].sort();
  const workspaceDoc = await fx.insertDocument({ driveId: fx.workspaceDriveId });
  // Team: member, member2, guest, agentUser. Members open Workspace documents; the guest and the agent don't.
  assert.deepEqual(await spaceMembersWhoCannotOpen(fx.orgId, spaces.team, workspaceDoc),
    { userIds: sorted([people.guest, people.agentUser]), guests: 1 });
  const drive = await fx.insertDrive({ kind: 'private', name: 'Audience' });
  await fx.addDriveMember(drive, { user: people.member }, 'full');
  const doc = await fx.insertDocument({ driveId: drive });
  assert.deepEqual(await spaceMembersWhoCannotOpen(fx.orgId, spaces.team, doc),
    { userIds: sorted([people.member2, people.guest, people.agentUser]), guests: 1 });
  await fx.share(doc, { space: spaces.team }, 'view');
  assert.deepEqual(await spaceMembersWhoCannotOpen(fx.orgId, spaces.team, doc), { userIds: [], guests: 0 });
  // A member who left the workspace is not counted.
  const unshared = await fx.insertDocument({ driveId: drive });
  assert.deepEqual(await spaceMembersWhoCannotOpen(fx.orgId, spaces.other, unshared), { userIds: [people.member2], guests: 0 });
  await fx.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx.orgId, people.member2]);
  try {
    assert.deepEqual(await spaceMembersWhoCannotOpen(fx.orgId, spaces.other, unshared), { userIds: [], guests: 0 });
  } finally {
    await fx.client.query('UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2', [fx.orgId, people.member2]);
  }
  // Another workspace's chat gives nothing.
  assert.deepEqual(await spaceMembersWhoCannotOpen(fx.otherOrgId, spaces.team, unshared), { userIds: [], guests: 0 });
  // In a caller's transaction, which sees its own uncommitted share.
  await db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role)
      VALUES (${randomUUID()}, ${fx!.orgId}, ${unshared}, 'user', ${people.member2}, 'view')`);
    assert.deepEqual(await spaceMembersWhoCannotOpen(fx!.orgId, spaces.other, unshared, tx), { userIds: [], guests: 0 });
    tx.rollback();
  }).catch((error: Error) => { if (!/rollback/i.test(error.message)) throw error; });
  assert.deepEqual(await spaceMembersWhoCannotOpen(fx.orgId, spaces.other, unshared), { userIds: [people.member2], guests: 0 }, 'rolled back');
});

test('a system user gets nothing, even with a linked active employee', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people } = fx;
  const drive = await fx.insertDrive({ kind: 'private', name: 'System user' });
  await fx.addDriveMember(drive, { user: people.agentUser }, 'edit');
  const doc = await fx.insertDocument({ driveId: drive });
  await fx.share(doc, { user: people.agentUser }, 'comment');
  assert.equal(await roleOf(people.agentUser, doc), 'edit', 'as an agent user');
  // The same user, its linked employee active, but of kind system: only humans and agent users act.
  await fx.client.query("UPDATE users SET kind = 'system' WHERE id = $1", [people.agentUser]);
  try {
    assert.equal(await roleOf(people.agentUser, doc), null);
    assert.equal(await driveRoleOf(people.agentUser, drive), null);
    const listed = await db.select({ id: documents.id }).from(documents).where(visibleDocumentCondition(people.agentUser, fx.orgId));
    assert.deepEqual(listed, []);
  } finally {
    await fx.client.query("UPDATE users SET kind = 'agent' WHERE id = $1", [people.agentUser]);
  }
});

test("caller SQL is bound before the check's own aliases: an outer access_doc or access_drive can't widen it", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { people, orgId, otherOrgId } = fx;
  // The guest can read one of these and not the other.
  const readable = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Shared with the guest' });
  await fx.share(readable, { user: people.guest }, 'view');
  const unreadable = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Not shared' });
  const docsOfOrg = (await db.select({ id: documents.id }).from(documents).where(eq(documents.org_id, orgId))).map((row) => row.id).sort();
  const expected: string[] = [];
  for (const id of docsOfOrg) if (await roleOf(people.guest, id) !== null) expected.push(id);
  assert.ok(expected.includes(readable) && !expected.includes(unreadable), 'the fixture has both outcomes');
  // The outer query names its documents with each of the check's own aliases.
  for (const alias of ['access_doc', 'access_drive', 'access_target', 'access_member', 'access_share', 'access_actor', 'access_chat_seat', 'access_open']) {
    const name = sql.raw(alias);
    const rows = await db.execute(sql`SELECT ${name}.id AS id FROM documents ${name}
      WHERE ${name}.org_id = ${orgId} AND ${visibleDocumentIdSql(people.guest, orgId, sql.raw(`${alias}.id`))}`);
    assert.deepEqual(rows.rows.map((row) => (row as { id: string }).id).sort(), expected, `documents aliased ${alias}`);
  }
  // The workspace taken from an outer access_drive: a document of another workspace is not admitted under it,
  // even for someone in both workspaces.
  const otherDrive = randomUUID();
  await fx.client.query(`INSERT INTO drives (id, org_id, name, kind, default_role) VALUES ($1, $2, 'Alias test', 'open', 'edit')`, [otherDrive, otherOrgId]);
  const otherDoc = await fx.insertDocument({ driveId: otherDrive });
  await fx.client.query("INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')", [randomUUID(), otherOrgId, people.member]);
  try {
    const askedUnder = async (driveId: string) => (await db.execute(sql`SELECT doc.id FROM documents doc
      JOIN drives access_drive ON access_drive.id = ${driveId}
      WHERE doc.id = ${otherDoc} AND ${visibleDocumentIdSql(people.member, sql.raw('access_drive.org_id'), sql.raw('doc.id'))}`)).rows.length;
    assert.equal(await askedUnder(fx.workspaceDriveId), 0, "asked under this workspace's drive");
    assert.equal(await askedUnder(otherDrive), 1, "asked under the other workspace's drive");
  } finally {
    await fx.client.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [otherOrgId, people.member]);
  }
});

// documentRoleFor and driveRoleFor are built from visibleDocumentCondition and visibleDriveCondition, so what this
// guards is: the EXISTS form (visibleDocumentIdSql, with the workspace as a value and as a column) gives exactly the
// list form's answer, and the role lookups' CASE returns the highest role at which the condition holds (at least
// `min` exactly when the condition holds at `min`, for every role).
test('visibleDocumentCondition and documentRoleFor agree for every person and document in the fixture', async (t) => {
  if (!fx) return t.skip(SKIP);
  const people = Object.entries({ ...fx.people, stranger: randomUUID() });
  const orgs = [fx.orgId, fx.otherOrgId];
  const allDocs = (await db.select({ id: documents.id, org_id: documents.org_id }).from(documents)
    .where(inArray(documents.org_id, orgs))).map((row) => row.id).sort();
  const allDrives = (await db.select({ id: drives.id }).from(drives).where(inArray(drives.org_id, orgs))).map((row) => row.id).sort();
  assert.ok(allDocs.length >= 30 && allDrives.length >= 15, `the fixture has ${allDocs.length} documents and ${allDrives.length} drives`);
  const outcomes = new Map<string, number>();
  const tally = (role: DocRole | null) => outcomes.set(String(role), (outcomes.get(String(role)) ?? 0) + 1);
  for (const [name, person] of people) {
    for (const org of orgs) {
      const docRoles = new Map<string, DocRole | null>();
      for (const id of allDocs) docRoles.set(id, await documentRoleFor(person, org, id));
      const driveRoles = new Map<string, DocRole | null>();
      for (const id of allDrives) driveRoles.set(id, await driveRoleFor(person, org, id));
      for (const role of docRoles.values()) tally(role);
      for (const min of DOC_ROLES) {
        const expected = allDocs.filter((id) => roleAtLeast(docRoles.get(id)!, min));
        const at = `${name} in ${org === fx.orgId ? 'this' : 'the other'} workspace, at least ${min}`;
        const listed = await db.select({ id: documents.id }).from(documents)
          .where(and(inArray(documents.org_id, orgs), visibleDocumentCondition(person, org, min))).orderBy(documents.id);
        assert.deepEqual(listed.map((row) => row.id), expected, `${at}: visibleDocumentCondition`);
        // The EXISTS form, with the workspace as a value and as a column of the statement.
        const byId = await db.select({ id: documents.id }).from(documents)
          .where(and(inArray(documents.org_id, orgs), visibleDocumentIdSql(person, org, sql`${documents.id}`, min))).orderBy(documents.id);
        assert.deepEqual(byId.map((row) => row.id), expected, `${at}: visibleDocumentIdSql, workspace as a value`);
        const byColumn = await db.select({ id: documents.id }).from(documents)
          .where(and(eq(documents.org_id, org), visibleDocumentIdSql(person, sql`${documents.org_id}`, sql`${documents.id}`, min))).orderBy(documents.id);
        assert.deepEqual(byColumn.map((row) => row.id), expected, `${at}: visibleDocumentIdSql, workspace as a column`);
        const expectedDrives = allDrives.filter((id) => roleAtLeast(driveRoles.get(id)!, min));
        const drivesListed = await db.select({ id: drives.id }).from(drives)
          .where(and(inArray(drives.org_id, orgs), visibleDriveCondition(person, org, min))).orderBy(drives.id);
        assert.deepEqual(drivesListed.map((row) => row.id), expectedDrives, `${at}: visibleDriveCondition`);
      }
    }
  }
  // The comparison is not vacuous: every outcome occurs.
  for (const role of [...DOC_ROLES, null]) assert.ok((outcomes.get(String(role)) ?? 0) > 0, `some document gives ${role}: ${JSON.stringify([...outcomes])}`);
});
