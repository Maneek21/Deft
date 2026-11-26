import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeMemberRole, driveKeys, driveWrite, ensureMyDrive, HttpError, isNoAccess, pageAccess, removeMember, type DriveClient,
} from './drive-actions';
import type { DriveListItem } from './drive-tree';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const drive = (over: Partial<DriveListItem>): DriveListItem => ({
  id: 'd', name: 'D', icon: null, kind: 'private', system_key: null, role: 'full', default_role: null, frozen: false, pinned: false,
  admin_listed: false, is_member: true, is_mine: false, owner_name: null, ...over,
});

function client(handler: (method: string, path: string, body?: unknown) => Promise<Response>): DriveClient & { calls: string[] } {
  const calls: string[] = [];
  const run = (method: string) => (path: string, body?: unknown) => { calls.push(`${method} ${path}`); return handler(method, path, body); };
  return { post: run('POST'), patch: run('PATCH'), delete: run('DELETE'), calls };
}

test('a refused role change or removal reports the server message instead of succeeding silently', async () => {
  const refused = client(async () => reply(403, { error: 'You need full access to this drive', code: 'FORBIDDEN_ROLE' }));
  const patched = await changeMemberRole(refused, 'd1', 'm1', 'view');
  assert.deepEqual(patched, { ok: false, status: 403, message: 'You need full access to this drive' });
  const removed = await removeMember(refused, 'd1', 'm1');
  assert.deepEqual(removed, { ok: false, status: 403, message: 'You need full access to this drive' });
  assert.deepEqual(refused.calls, ['PATCH /api/drives/d1/members/m1', 'DELETE /api/drives/d1/members/m1']);
});

test('a write with no readable error body falls back to a plain message, and a transport failure says so', async () => {
  const noBody = await driveWrite(async () => new Response('oops', { status: 500 }), 'Could not do that');
  assert.deepEqual(noBody, { ok: false, status: 500, message: 'Could not do that' });
  const down = await driveWrite(async () => { throw new TypeError('fetch failed'); }, 'Could not do that');
  assert.equal(down.ok, false);
  assert.equal(down.ok === false && down.status, null);
  assert.match(down.ok === false ? down.message : '', /connection/i);
  const fine = await driveWrite(async () => reply(200, { pinned: true }), 'x');
  assert.deepEqual(fine, { ok: true, body: { pinned: true } });
});

test('a member or access change revalidates the list, the drive, its tree, trash and members, and without-manager', () => {
  assert.deepEqual(driveKeys('d1').sort(), [
    '/api/drives', '/api/drives/d1', '/api/drives/d1/members', '/api/drives/d1/trash', '/api/drives/d1/tree', '/api/drives/without-manager',
  ]);
});

test('losing access (self-removal) shows no access; a self-downgrade drops the controls', () => {
  assert.equal(isNoAccess(new HttpError(404, 'Drive not found')), true);
  assert.equal(isNoAccess(new HttpError(403, 'no')), true);
  assert.equal(isNoAccess(new HttpError(500, 'no')), false);
  assert.equal(isNoAccess(new Error('boom')), false);
  assert.deepEqual(pageAccess('full'), { canEdit: true, canManage: true });
  assert.deepEqual(pageAccess('edit'), { canEdit: true, canManage: false });
  assert.deepEqual(pageAccess('view'), { canEdit: false, canManage: false });
  assert.deepEqual(pageAccess(null), { canEdit: false, canManage: false });
});

test('the sidebar creates My drive once when none of the listed drives is the caller’s own', async () => {
  const c = client(async () => reply(200, { drive: { id: 'mine' } }));
  const shared = drive({ id: 'sam', name: 'My drive', kind: 'personal', is_mine: false });
  assert.deepEqual(await ensureMyDrive([shared], c), { ok: true, body: { drive: { id: 'mine' } } });
  assert.deepEqual(c.calls, ['POST /api/drives/mine']);
  const c2 = client(async () => reply(200, {}));
  assert.equal(await ensureMyDrive([drive({ kind: 'personal', is_mine: true })], c2), null);
  assert.deepEqual(c2.calls, []);
});
