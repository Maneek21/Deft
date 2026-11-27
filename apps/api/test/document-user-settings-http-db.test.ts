/**
 * Each person's setting for where an agent's edit lands, and who counts as
 * "someone else in the document" (plan Task M5; lib/document-edit-landing.ts,
 * routes/documents.ts):
 * - GET /api/document-settings answers { agent_edit_mode } for the caller in
 *   their workspace, `suggest_when_open` when they have saved nothing;
 *   PATCH /api/document-settings { agent_edit_mode } saves it, checked with
 *   zod. Both are per person and per workspace; an inactive member is 403.
 * - otherHumansOpen counts the people with a live connection to the
 *   document, leaving out the asker, agent users (Defty, every employee),
 *   system users and anyone who isn't an active member of the workspace.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-user-settings-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { setCollabLimitsForTest } from '../src/collab/limits.js';
import { getCollabServer } from '../src/collab/server.js';
import { closeDb } from '../src/lib/db.js';
import { agentEditModeFor, otherHumansAmong, otherHumansOpen, setAgentEditMode } from '../src/lib/document-edit-landing.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { documentSettingsRoutes } from '../src/routes/documents.js';
import { connectCollab, pollUntil, startCollabTestServer, tokenFor, type CollabTestServer } from './fixtures/collab-client.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const PATH = '/api/document-settings';

let fx: DrivesFixture | undefined;
let srv: CollabTestServer | undefined;
let restoreLimits: (() => void) | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('edit-settings', { routes: [{ path: PATH, app: documentSettingsRoutes }] });
  restoreLimits = setCollabLimitsForTest({ unloadAfterMs: 200 });
  srv = await startCollabTestServer(fx);
});

after(async () => {
  restoreLimits?.();
  await srv?.close();
  if (fx) await fx.client.query('DELETE FROM document_user_settings WHERE org_id = ANY($1::text[])', [[fx.orgId, fx.otherOrgId]]);
  await fx?.teardown();
  await closeDb();
});

async function getMode(userId: string) {
  const res = await fx!.request(userId, 'GET', PATH);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function patchMode(userId: string, body: unknown) {
  const res = await fx!.request(userId, 'PATCH', PATH, body);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function storedRows(orgId: string, userId: string) {
  return (await fx!.client.query<{ agent_edit_mode: string }>(
    'SELECT agent_edit_mode FROM document_user_settings WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rows;
}

test('the setting defaults to suggest_when_open and is saved per person', { skip: !url && SKIP }, async () => {
  const { orgId, otherOrgId, people } = fx!;
  // Nothing saved yet: the default, and no row is written by reading it.
  assert.deepEqual(await getMode(people.member), { status: 200, body: { agent_edit_mode: 'suggest_when_open' } });
  assert.equal(await agentEditModeFor(orgId, people.member), 'suggest_when_open');
  assert.deepEqual(await storedRows(orgId, people.member), []);

  // Saving it changes only the caller's own setting.
  assert.deepEqual(await patchMode(people.member, { agent_edit_mode: 'direct' }), { status: 200, body: { agent_edit_mode: 'direct' } });
  assert.deepEqual(await getMode(people.member), { status: 200, body: { agent_edit_mode: 'direct' } });
  assert.equal(await agentEditModeFor(orgId, people.member), 'direct');
  assert.deepEqual(await getMode(people.member2), { status: 200, body: { agent_edit_mode: 'suggest_when_open' } });
  assert.equal(await agentEditModeFor(orgId, people.member2), 'suggest_when_open');

  // Saving again replaces it: one row per person.
  assert.deepEqual(await patchMode(people.member, { agent_edit_mode: 'suggest' }), { status: 200, body: { agent_edit_mode: 'suggest' } });
  assert.deepEqual(await storedRows(orgId, people.member), [{ agent_edit_mode: 'suggest' }]);
  assert.deepEqual(await patchMode(people.member, { agent_edit_mode: 'suggest_when_open' }), { status: 200, body: { agent_edit_mode: 'suggest_when_open' } });
  assert.deepEqual(await storedRows(orgId, people.member), [{ agent_edit_mode: 'suggest_when_open' }]);
  assert.deepEqual(await patchMode(people.member, { agent_edit_mode: 'suggest' }), { status: 200, body: { agent_edit_mode: 'suggest' } });

  // A guest has a setting of their own too.
  assert.deepEqual(await patchMode(people.guest, { agent_edit_mode: 'direct' }), { status: 200, body: { agent_edit_mode: 'direct' } });
  assert.equal(await agentEditModeFor(orgId, people.guest), 'direct');
  assert.equal(await agentEditModeFor(orgId, people.member), 'suggest');

  // Per workspace: the same person in another workspace starts from the default, and their settings stay apart.
  await fx!.client.query('INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [randomUUID(), otherOrgId, people.member, 'member']);
  assert.equal(await agentEditModeFor(otherOrgId, people.member), 'suggest_when_open');
  assert.equal(await setAgentEditMode(otherOrgId, people.member, 'direct'), 'direct');
  assert.equal(await agentEditModeFor(otherOrgId, people.member), 'direct');
  assert.equal(await agentEditModeFor(orgId, people.member), 'suggest');
  assert.deepEqual(await getMode(people.member), { status: 200, body: { agent_edit_mode: 'suggest' } }, 'the request is in the caller\'s own workspace');
  // A workspace the person isn't in at all has no setting to save.
  assert.equal(await setAgentEditMode(otherOrgId, people.member2, 'direct'), null);
  assert.deepEqual(await storedRows(otherOrgId, people.member2), []);
});

test('PATCH checks its body: an unknown mode, a missing or extra key, or anything but a JSON object is 400, and nothing is saved', { skip: !url && SKIP }, async () => {
  const { orgId, people } = fx!;
  const person = people.member2;
  const invalid = { status: 400, body: { error: 'Invalid input', code: 'VALIDATION_ERROR' } };
  for (const body of [{ agent_edit_mode: 'always' }, { agent_edit_mode: 'DIRECT' }, { agent_edit_mode: null }, { agent_edit_mode: 1 }, {},
    { agent_edit_mode: 'direct', extra: true }, ['direct'], 'direct', null]) {
    assert.deepEqual(await patchMode(person, body), invalid, JSON.stringify(body));
  }
  for (const raw of ['{"agent_edit_mode":', 'direct', '']) {
    const res = await fx!.requestRaw(person, 'PATCH', PATH, raw);
    assert.deepEqual({ status: res.status, body: await res.json() }, invalid, JSON.stringify(raw));
  }
  assert.deepEqual(await storedRows(orgId, person), []);
  assert.deepEqual(await getMode(person), { status: 200, body: { agent_edit_mode: 'suggest_when_open' } });
});

test('an inactive member gets 403 from both routes, and nothing is saved', { skip: !url && SKIP }, async () => {
  const { client, orgId } = fx!;
  const refused = { status: 403, body: { error: 'You are no longer an active member of this workspace', code: 'ORG_MEMBERSHIP_INACTIVE' } };
  const inactive = await fx!.addPerson({ active: false });
  assert.deepEqual(await getMode(inactive), refused);
  assert.deepEqual(await patchMode(inactive, { agent_edit_mode: 'direct' }), refused);
  assert.deepEqual(await storedRows(orgId, inactive), []);
  assert.equal(await setAgentEditMode(orgId, inactive, 'direct'), null);
  assert.deepEqual(await storedRows(orgId, inactive), []);

  // Someone who saved a setting and then left can't read or change it.
  const leaver = await fx!.addPerson();
  assert.deepEqual(await patchMode(leaver, { agent_edit_mode: 'direct' }), { status: 200, body: { agent_edit_mode: 'direct' } });
  await client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [orgId, leaver]);
  assert.deepEqual(await getMode(leaver), refused);
  assert.deepEqual(await patchMode(leaver, { agent_edit_mode: 'suggest' }), refused);
  assert.deepEqual(await storedRows(orgId, leaver), [{ agent_edit_mode: 'direct' }]);
});

test('otherHumansAmong counts only another active human of the workspace', { skip: !url && SKIP }, async () => {
  const { orgId, people } = fx!;
  const defty = await ensureDeftyMembership(orgId);
  const system = await fx!.addPerson({ kind: 'system' });
  const inactive = await fx!.addPerson({ active: false });
  const employeeAgent = await fx!.addPerson({ kind: 'agent', agentEmployeeId: randomUUID() });
  const asker = people.member;
  assert.equal(await otherHumansAmong(orgId, asker, []), false, 'nobody');
  assert.equal(await otherHumansAmong(orgId, asker, [asker, asker]), false, 'the asker alone, twice');
  assert.equal(await otherHumansAmong(orgId, asker,
    [asker, defty, people.agentUser, employeeAgent, system, inactive, people.outsider, randomUUID()]), false,
  'Defty, employees, a system user, an inactive member, another workspace\'s member and an unknown id are nobody');
  assert.equal(await otherHumansAmong(orgId, asker, [asker, defty, people.member2]), true, 'another member');
  assert.equal(await otherHumansAmong(orgId, asker, [people.guest]), true, 'a guest is a person too');
  assert.equal(await otherHumansAmong(orgId, people.member2, [asker]), true, 'the asker is someone else to another asker');
  // The outsider is an active human of their own workspace, not of this one.
  assert.equal(await otherHumansAmong(fx!.otherOrgId, asker, [people.outsider]), true);
});

test('otherHumansOpen is true only while another active human has the document open', { skip: !url && SKIP }, async (t) => {
  const { orgId, people, workspaceDriveId } = fx!;
  const doc = await fx!.insertDocument({ driveId: workspaceDriveId, title: 'Live' });
  // An agent user gets nothing from an open drive's default role: only what names it.
  await fx!.share(doc, { user: people.agentUser }, 'edit');
  const open =(askerId: string) => otherHumansOpen({ orgId, documentId: doc, askerId });
  const connected = () => getCollabServer().connectedUserIds(doc);
  const join = async (userId: string) => {
    const client = connectCollab({ url: srv!.url, documentId: doc, token: await tokenFor(userId, orgId) });
    t.after(() => client.destroy());
    await client.waitSynced();
    await pollUntil(() => connected().includes(userId), `${userId} is connected`);
    return client;
  };

  assert.equal(await open(people.member), false, 'nobody is in the document');
  await join(people.member);
  assert.equal(await open(people.member), false, 'only the asker is in');
  await join(people.agentUser);
  assert.equal(await open(people.member), false, 'an agent user is no one else');
  const colleague = await join(people.member2);
  assert.equal(await open(people.member), true, 'a colleague is in');
  assert.equal(await open(people.member2), true, 'and to the colleague, the first person is');
  colleague.destroy();
  await pollUntil(() => !connected().includes(people.member2), 'the colleague left');
  assert.equal(await open(people.member), false, 'the colleague left');
  // A connection to another document doesn't count.
  const other = await fx!.insertDocument({ driveId: workspaceDriveId, title: 'Elsewhere' });
  const elsewhere = connectCollab({ url: srv!.url, documentId: other, token: await tokenFor(people.member2, orgId) });
  t.after(() => elsewhere.destroy());
  await elsewhere.waitSynced();
  assert.equal(await open(people.member), false, 'someone in another document');
});
