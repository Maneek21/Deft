import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalAppConnectionProfileJson, type AppConnectionRuntimeRequest } from '@deft/app-kit';
import { AppConnectionRuntimeResultSchema } from '@deft/app-kit/core';
import { AppConnectionSessionService, type AppConnectionSessionPorts, type AppConnectionSessionRecord } from '../src/lib/app-connection-session-service.js';
import { AppError } from '../src/lib/app-errors.js';

type Provider = (request: AppConnectionRuntimeRequest, signal: AbortSignal) => Promise<unknown>;
const healthy: Provider = async request => {
  if (request.operation === 'begin') return { state: 'awaiting_callback', runtime_session_ref: 'runtime_session',
    authorization_url: 'https://accounts.google.com/o/oauth2/auth?state=' + request.callback_state };
  if (request.operation === 'disconnect') return { state: 'disconnected' };
  if (request.operation === 'callback' && request.callback.outcome === 'denied') return { state: 'not_connected' };
  return { state: 'connected', account: { account_ref: 'account_A', label: 'Synthetic mailbox' } };
};

function fixture() {
  let now = Date.parse('2026-10-09T00:00:00.000Z');
  const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
  const profile = { schema_version: 'deft.app_connection_profile.v1' as const, key: 'google_mail', provider_id: 'google_mail',
    operator_user_id: randomUUID(), runtime_requirement_key: 'inbox', resource_key: 'messages', action_keys: ['send_message'],
    authorization_origin: 'https://accounts.google.com', credential_custody: 'runtime' as const, executable: false as const };
  const scope = { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), package_digest: 'sha256:' + '1'.repeat(64), grant_snapshot_digest: 'sha256:' + '2'.repeat(64),
    lifecycle_epoch: 1, grant_epoch: 1, target_key: 'personal', resource_key: 'messages', resource_binding_id: randomUUID(),
    runtime_registration_id: randomUUID(), operator_user_id: profile.operator_user_id, runtime_epoch: 1,
    profile_digest: 'sha256:' + createHash('sha256').update(canonicalAppConnectionProfileJson(profile)).digest('hex'),
    consent_expires_at: new Date(now + 2 * 60 * 60_000).toISOString() };
  let expires = now + 30 * 60_000, revoked = false, unresolved = false, provider = healthy;
  const rows = new Map<string, AppConnectionSessionRecord>(), calls: AppConnectionRuntimeRequest[] = [];
  const ports: AppConnectionSessionPorts = {
    async currentAuthority(active) {
      if (revoked || active.org_id !== scope.org_id || active.user_id !== scope.owner_user_id) throw new AppError('Revoked', 'APP_ACCESS_DENIED', 403);
      return { scope, profile, expires_at: expires };
    },
    async registeredRuntime() { if (unresolved) throw new Error('registry unavailable'); return { identity: { runtime_registration_id: scope.runtime_registration_id,
      operator_user_id: scope.operator_user_id, runtime_epoch: scope.runtime_epoch },
      async request(input, signal) { calls.push(input); return provider(input, signal); } }; },
    store: {
      async create(record) { if (rows.has(record.session_id)) return false; rows.set(record.session_id, structuredClone(record)); return true; },
      async read(locator) { const row = rows.get(locator.session_id); return row?.scope.org_id === locator.org_id
        && row.scope.owner_user_id === locator.owner_user_id ? structuredClone(row) : null; },
      async compareAndSet(locator, revision, next) { const row = rows.get(locator.session_id);
        if (row?.revision !== revision || row.scope.org_id !== locator.org_id || row.scope.owner_user_id !== locator.owner_user_id) return false;
        rows.set(locator.session_id, structuredClone(next)); return true; },
    },
  };
  const service = new AppConnectionSessionService(ports, () => now);
  return { caller, service, rows, calls, nomination: { installation_id: scope.installation_id, target_key: scope.target_key },
    provider(work: Provider) { provider = work; }, healthy() { provider = healthy; },
    authorityExpiry(value: number) { expires = value; }, now: () => now, advance(ms: number) { now += ms; }, unresolve() { unresolved = true; }, revoke() { revoked = true; } };
}
type Fixture = ReturnType<typeof fixture>;
async function connected(f: Fixture) {
  const begin = await f.service.begin(f.caller, f.nomination); assert.ok('callback_state' in begin);
  const result = await f.service.callback(f.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'synthetic-code' });
  assert.equal(result.state, 'connected'); return { begin, session_id: result.session_id };
}
async function notConnected(f: Fixture) {
  const begin = await f.service.begin(f.caller, f.nomination); assert.ok('callback_state' in begin);
  const result = await f.service.callback(f.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'denied' });
  assert.equal(result.state, 'not_connected'); return { session_id: result.session_id };
}
const never: Provider = (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
const noAnswer: Array<[string, Provider]> = [
  ['unreachable runtime', async () => { throw new TypeError('fetch failed'); }],
  ['transport-level error status', async () => { throw new AppError('Reviewed connection runtime unavailable', 'APP_CONNECTION_PROFILE_UNAVAILABLE', 503); }],
  // The registered transport parses the body and rejects (app-connection-session-registry.ts).
  ['unparseable answer', async () => AppConnectionRuntimeResultSchema.parse({ state: 'unknown_success' })],
];

test('a status check that gets no runtime answer leaves a connected session connected with its account', async () => {
  for (const [name, failure] of noAnswer) {
    const f = fixture(), { session_id } = await connected(f), before = f.rows.get(session_id)!;
    f.provider(failure);
    await assert.rejects(f.service.status(f.caller, { session_id }), (error: unknown) =>
      error instanceof AppError && error.code === 'APP_PROVIDER_UNAVAILABLE' && error.status === 503, name);
    const after = f.rows.get(session_id)!;
    assert.equal(after.state, 'connected', name); assert.deepEqual(after.account, before.account, name);
    assert.deepEqual({ ...after, revision: 0, updated_at: '' }, { ...before, revision: 0, updated_at: '' }, name);
    f.healthy();
    assert.equal((await f.service.status(f.caller, { session_id })).state, 'connected', name);
  }
});

test('a status check that times out leaves a connected session connected', async () => {
  const f = fixture(), { session_id } = await connected(f);
  let started!: () => void; const reached = new Promise<void>(resolve => { started = resolve; });
  f.provider((request, signal) => { started(); return never(request, signal); });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = f.service.status(f.caller, { session_id });
    await reached; f.advance(30_001); mock.timers.tick(30_001);
    await assert.rejects(pending, /status unavailable/);
  } finally { mock.timers.reset(); }
  assert.equal(f.rows.get(session_id)!.state, 'connected');
  assert.equal(f.rows.get(session_id)!.account?.account_ref, 'account_A');
});

test('a status check that gets no runtime answer leaves a not_connected session not_connected', async () => {
  const f = fixture(), { session_id } = await notConnected(f);
  f.provider(noAnswer[0]![1]);
  await assert.rejects(f.service.status(f.caller, { session_id }), /status unavailable/);
  assert.equal(f.rows.get(session_id)!.state, 'not_connected'); assert.equal(f.rows.get(session_id)!.account, null);
});

test('definite runtime answers keep their recorded outcome', async () => {
  const cases: Array<[unknown, string, string | null]> = [
    [{ state: 'disconnected' }, 'disconnected', null],
    [{ state: 'indeterminate' }, 'indeterminate', null],
    [{ state: 'connected', account: { account_ref: 'account_B', label: 'Other mailbox' } }, 'indeterminate', 'account_A'],
  ];
  for (const [answer, state, account] of cases) {
    const f = fixture(), { session_id } = await connected(f);
    f.provider(async () => answer);
    assert.equal((await f.service.status(f.caller, { session_id })).state, state);
    assert.equal(f.rows.get(session_id)!.state, state); assert.equal(f.rows.get(session_id)!.account?.account_ref ?? null, account);
  }
});

test('authority lost during a status check still records indeterminate and denies', async () => {
  const f = fixture(), { session_id } = await connected(f);
  f.provider(async () => { f.revoke(); throw new TypeError('fetch failed'); });
  await assert.rejects(f.service.status(f.caller, { session_id }), /Revoked|access ended/);
  assert.equal(f.rows.get(session_id)!.state, 'indeterminate');
});

test('authority expiring during a status check still records indeterminate and denies', async () => {
  const f = fixture(), { session_id } = await connected(f);
  f.provider(async () => { f.authorityExpiry(f.now()); throw new TypeError('fetch failed'); });
  await assert.rejects(f.service.status(f.caller, { session_id }), /access ended/);
  assert.equal(f.rows.get(session_id)!.state, 'indeterminate');
});

test('the original deadline passing during a status check still records indeterminate and denies', async () => {
  const f = fixture(), { session_id } = await connected(f);
  f.provider(async () => { f.authorityExpiry(f.now() + 60 * 60_000); f.advance(31 * 60_000); throw new TypeError('fetch failed'); });
  await assert.rejects(f.service.status(f.caller, { session_id }), /access ended/);
  assert.equal(f.rows.get(session_id)!.state, 'indeterminate');
});

test('failures that are not a missing runtime answer keep the indeterminate outcome', async () => {
  const cases: Array<[string, (f: Fixture) => void]> = [
    ['runtime resolution failed before any request', f => f.unresolve()],
    ['runtime answered with an invalid result', f => f.provider(async () => ({ state: 'unknown_success' }))],
    ['runtime denied the request', f => f.provider(async () => { throw new AppError('Denied', 'APP_ACCESS_DENIED', 403); })],
  ];
  for (const [name, arrange] of cases) {
    const f = fixture(), { session_id } = await connected(f);
    arrange(f);
    try { assert.equal((await f.service.status(f.caller, { session_id })).state, 'indeterminate', name); }
    catch (error) { assert.ok(error instanceof AppError && error.code === 'APP_ACCESS_DENIED', name); }
    assert.equal(f.rows.get(session_id)!.state, 'indeterminate', name);
  }
});

test('an indeterminate session from an interrupted disconnect or callback is not re-checked by status', async () => {
  const a = fixture(), { session_id } = await connected(a);
  a.provider(noAnswer[0]![1]);
  assert.equal((await a.service.disconnect(a.caller, { session_id })).state, 'indeterminate');
  assert.equal(a.rows.get(session_id)!.state, 'indeterminate');
  a.healthy(); const calls = a.calls.length, revision = a.rows.get(session_id)!.revision;
  assert.equal((await a.service.status(a.caller, { session_id })).state, 'indeterminate');
  assert.equal(a.calls.length, calls); assert.equal(a.rows.get(session_id)!.revision, revision);

  const b = fixture(), begin = await b.service.begin(b.caller, b.nomination); assert.ok('callback_state' in begin);
  b.provider(noAnswer[0]![1]);
  assert.equal((await b.service.callback(b.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'c' })).state, 'indeterminate');
  b.healthy(); const callsB = b.calls.length;
  assert.equal((await b.service.status(b.caller, { session_id: begin.session_id })).state, 'indeterminate');
  assert.equal(b.calls.length, callsB); assert.equal(b.rows.get(begin.session_id)!.state, 'indeterminate');
});

test('another workspace cannot run a status check on the session', async () => {
  const f = fixture(), { session_id } = await connected(f), before = structuredClone(f.rows.get(session_id)!), calls = f.calls.length;
  const outsider = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
  await assert.rejects(f.service.status(outsider, { session_id }), /access ended/);
  assert.deepEqual(f.rows.get(session_id), before); assert.equal(f.calls.length, calls);
});
