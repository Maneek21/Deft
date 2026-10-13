import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmailDraftRoutes } from '../src/routes/email-drafts.js';
import { EmailDraftError } from '../src/lib/email-draft-service.js';

const session = { id: 'draft-owner', org_id: 'draft-org', sid: 'draft-session', exp: 2_000_000_000 };
const id = '00000000-0000-4000-8000-000000000001';
const content = { mode: 'compose', to: '', cc: '', bcc: '', subject: 'Hello', body: 'Review me', body_html: '', reply_record_id: '', attachments: [] };
function fixture(options: { fail?: string; expired?: boolean } = {}) {
  const calls: any[] = [];
  const result = { draft_id: id, revision: 1, status: 'draft', content, origin: { kind: 'human', created_by_user_id: session.id, originating_run_id: null },
    last_edited_by_user_id: session.id, created_at: '2026-10-04T00:00:00.000Z', updated_at: '2026-10-04T00:00:00.000Z' };
  const service = {
    async list(actor: unknown, scope: unknown) { calls.push(['list', actor, scope]); if (options.fail === 'deny') throw new EmailDraftError('EMAIL_DRAFT_ACCESS_DENIED'); return [result]; },
    async read(actor: unknown, scope: unknown, draftId: string) { calls.push(['read', actor, scope, draftId]); if (options.fail === 'missing') throw new EmailDraftError('EMAIL_DRAFT_NOT_FOUND'); return result; },
    async create(actor: unknown, scope: unknown, draftId: string, value: unknown) { calls.push(['create', actor, scope, draftId, value]); if (options.fail === 'conflict') throw new EmailDraftError('EMAIL_DRAFT_CONFLICT'); return result; },
    async update(actor: unknown, scope: unknown, draftId: string, revision: number, value: unknown) { calls.push(['update', actor, scope, draftId, revision, value]); if (options.fail === 'conflict') throw new EmailDraftError('EMAIL_DRAFT_CONFLICT'); return { ...result, revision: revision + 1, content: value }; },
    async archive(actor: unknown, scope: unknown, draftId: string, revision: number) { calls.push(['archive', actor, scope, draftId, revision]); return { ...result, revision: revision + 1, status: 'archived' }; },
  };
  const routes = createEmailDraftRoutes({ verify: async token => token === 'valid' ? { ...session, exp: options.expired ? 1 : session.exp } : Promise.reject(new Error('invalid')),
    drafts: async actor => { calls.push(['runtime', actor]); return service as any; }, now: () => 10_000 });
  return { routes, calls };
}
const auth = { authorization: 'Bearer valid' };

test('verified session lists and reopens only its account-scoped drafts', async () => {
  const f = fixture();
  const list = await f.routes.request('/accounts/account-a/drafts', { headers: auth });
  assert.equal(list.status, 200); assert.deepEqual((await list.json() as any).items.map((row: any) => row.draft_id), [id]);
  const read = await f.routes.request(`/accounts/account-a/drafts/${id}`, { headers: auth });
  assert.equal(read.status, 200); assert.equal((await read.json() as any).content.body, 'Review me');
  assert.deepEqual(f.calls[1]?.[1], { user_id: session.id, web_session_id: session.sid, access_expires_at: session.exp * 1000 });
  assert.deepEqual(f.calls[1]?.[2], { org_id: session.org_id, owner_user_id: session.id, account_id: 'account-a' });
});

test('PUT uses revision zero for idempotent create and positive revisions for CAS autosave', async () => {
  const f = fixture(), headers = { ...auth, 'content-type': 'application/json' };
  const create = await f.routes.request(`/accounts/account-a/drafts/${id}`, { method: 'PUT', headers, body: JSON.stringify({ expected_revision: 0, content }) });
  assert.equal(create.status, 200); assert.equal(f.calls.at(-1)?.[0], 'create');
  const save = await f.routes.request(`/accounts/account-a/drafts/${id}`, { method: 'PUT', headers, body: JSON.stringify({ expected_revision: 4, content }) });
  assert.equal(save.status, 200); assert.equal((await save.json() as any).revision, 5); assert.equal(f.calls.at(-1)?.[0], 'update');
});

test('routes reject forged owner/provenance/status and map CAS conflict without discarding client text', async () => {
  const f = fixture({ fail: 'conflict' }), headers = { ...auth, 'content-type': 'application/json' };
  const forged = await f.routes.request(`/accounts/account-a/drafts/${id}`, { method: 'PUT', headers,
    body: JSON.stringify({ expected_revision: 0, content: { ...content, origin: 'agent', status: 'submitted', owner_user_id: 'someone-else' } }) });
  assert.equal(forged.status, 400); assert.equal(f.calls.some(call => call[0] === 'create'), false);
  const conflict = await f.routes.request(`/accounts/account-a/drafts/${id}`, { method: 'PUT', headers, body: JSON.stringify({ expected_revision: 3, content }) });
  assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { code: 'EMAIL_DRAFT_CONFLICT' });
});

test('archive is an explicit soft operation; invalid session and query strings are rejected', async () => {
  const f = fixture(), headers = { ...auth, 'content-type': 'application/json' };
  const archived = await f.routes.request(`/accounts/account-a/drafts/${id}/archive`, { method: 'POST', headers, body: JSON.stringify({ expected_revision: 2 }) });
  assert.equal(archived.status, 200); assert.equal((await archived.json() as any).status, 'archived');
  assert.equal(f.calls.at(-1)?.[0], 'archive');
  assert.equal((await f.routes.request('/accounts/account-a/drafts?owner_user_id=other', { headers: auth })).status, 400);
  assert.equal((await f.routes.request('/accounts/account-a/drafts', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await fixture({ expired: true }).routes.request('/accounts/account-a/drafts', { headers: auth })).status, 401);
  assert.equal((await fixture({ fail: 'deny' }).routes.request('/accounts/account-a/drafts', { headers: auth })).status, 403);
});
