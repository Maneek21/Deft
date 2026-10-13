import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalAppConnectionProfileJson, type AppConnectionRuntimeRequest } from '@deft/app-kit';
import { AppConnectionSessionService, type AppConnectionSessionPorts, type AppConnectionSessionRecord } from '../src/lib/app-connection-session-service.js';
import { AppError } from '../src/lib/app-errors.js';

function fixture() {
  let now = Date.parse('2026-10-09T00:00:00.000Z');
  const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
  let profile = { schema_version: 'deft.app_connection_profile.v1' as const, key: 'google_mail', provider_id: 'google_mail',
    operator_user_id: randomUUID(), runtime_requirement_key: 'inbox', resource_key: 'messages', action_keys: ['send_message'],
    authorization_origin: 'https://accounts.google.com', credential_custody: 'runtime' as const, executable: false as const };
  let scope = { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), package_digest: 'sha256:' + '1'.repeat(64), grant_snapshot_digest: 'sha256:' + '2'.repeat(64),
    lifecycle_epoch: 1, grant_epoch: 1, target_key: 'personal', resource_key: 'messages', resource_binding_id: randomUUID(),
    runtime_registration_id: randomUUID(), operator_user_id: profile.operator_user_id, runtime_epoch: 1,
    profile_digest: 'sha256:' + createHash('sha256').update(canonicalAppConnectionProfileJson(profile)).digest('hex'),
    consent_expires_at: new Date(now + 2 * 60 * 60_000).toISOString() };
  let expires = now + 30 * 60_000;
  let revoked = false, refuseCas = false, refuseCreate = false, identityChanged = false;
  const rows = new Map<string, AppConnectionSessionRecord>(), calls: AppConnectionRuntimeRequest[] = [];
  const refreshed: NonNullable<AppConnectionSessionPorts['refreshResource']> extends (input: infer T) => unknown ? T[] : never = [];
  let provider: (request: AppConnectionRuntimeRequest, signal: AbortSignal) => Promise<unknown> = async request => {
    if (request.operation === 'begin') return { state: 'awaiting_callback', runtime_session_ref: 'runtime_session',
      authorization_url: 'https://accounts.google.com/o/oauth2/auth?state=' + request.callback_state };
    if (request.operation === 'disconnect') return { state: 'disconnected' };
    if (request.operation === 'callback' && request.callback.outcome === 'denied') return { state: 'not_connected' };
    return { state: 'connected', account: { account_ref: 'account_A', label: 'Synthetic mailbox' } };
  };
  const ports: AppConnectionSessionPorts = {
    async currentAuthority() { if (revoked) throw new AppError('Revoked', 'APP_ACCESS_DENIED', 403); return { scope, profile, expires_at: expires }; },
    async registeredRuntime() { return { identity: { runtime_registration_id: scope.runtime_registration_id,
      operator_user_id: identityChanged ? randomUUID() : scope.operator_user_id, runtime_epoch: scope.runtime_epoch },
      async request(input, signal) {
        // Provider IO sees a committed state, including consumed callback state.
        const committed = rows.get(input.session_id)!;
        assert.ok(committed);
        assert.deepEqual(input.scope, committed.scope);
        if (input.operation === 'callback') assert.equal(committed.callback_consumed, true);
        calls.push(input); return provider(input, signal);
      } }; },
    store: {
      async create(record) { if (refuseCreate || rows.has(record.session_id)) return false; rows.set(record.session_id, structuredClone(record)); return true; },
      async read(locator) { const row = rows.get(locator.session_id); return row?.scope.org_id === locator.org_id
        && row.scope.owner_user_id === locator.owner_user_id ? structuredClone(row) : null; },
      async compareAndSet(locator, revision, next) { const row = rows.get(locator.session_id);
        if (refuseCas || row?.revision !== revision || row.scope.org_id !== locator.org_id || row.scope.owner_user_id !== locator.owner_user_id) return false;
        rows.set(locator.session_id, structuredClone(next)); return true; },
    },
    async refreshResource(input) { refreshed.push(input); return { schema_version: 'deft.app_connection_refresh.v1', session_id: input.session_id,
      resource_binding_id: input.scope.resource_binding_id, run_id: randomUUID(), state: 'queued' }; },
  };
  const service = new AppConnectionSessionService(ports, () => now);
  return { caller, service, ports, calls, rows, refreshed, nomination: { installation_id: scope.installation_id, target_key: scope.target_key },
    clock(value: number) { now = value; }, now: () => now,
    authorityExpiry(value: number) { expires = value; },
    revoke() { revoked = true; }, failCas() { refuseCas = true; }, failCreate() { refuseCreate = true; }, wrongIdentity() { identityChanged = true; },
    scope: () => scope, changeScope(patch: Partial<typeof scope>) { scope = { ...scope, ...patch }; },
    changeProfile(patch: Partial<typeof profile>) { profile = { ...profile, ...patch }; },
    provider(work: typeof provider) { provider = work; },
  };
}
async function begun(f: ReturnType<typeof fixture>) {
  const value = await f.service.begin(f.caller, f.nomination);
  assert.equal(value.state, 'awaiting_callback'); assert.ok('callback_state' in value); return value;
}
async function connected(f: ReturnType<typeof fixture>) {
  const begin = await begun(f);
  const result = await f.service.callback(f.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'synthetic-code' });
  assert.equal(result.state, 'connected'); return { begin, result };
}
test('public interface persists begin/callback/status/disconnect and delegates refresh to existing scoped scheduler', async () => {
  const f = fixture(), { begin, result } = await connected(f);
  assert.equal(result.account?.account_ref, 'account_A');
  assert.equal(Object.hasOwn(result, 'runtime_session_ref'), false);
  assert.equal(Object.hasOwn(result, 'callback_state_hash'), false);
  assert.equal(Object.hasOwn(f.rows.get(begin.session_id)!, 'callback_state'), false);
  assert.equal((await f.service.status(f.caller, { session_id: result.session_id })).state, 'connected');
  const requestId = randomUUID(), refresh = await f.service.refresh(f.caller, { session_id: result.session_id, request_id: requestId });
  assert.equal(refresh.state, 'queued');
  assert.deepEqual(f.refreshed[0], { session_id: result.session_id, session_revision: f.rows.get(result.session_id)!.revision,
    scope: f.scope(), account_ref: 'account_A', request_id: requestId });
  assert.equal((await f.service.disconnect(f.caller, { session_id: result.session_id })).state, 'disconnected');
  assert.equal((await f.service.disconnect(f.caller, { session_id: result.session_id })).state, 'disconnected');
  assert.deepEqual(f.calls.map(call => call.operation), ['begin', 'callback', 'status', 'disconnect']);
  assert.equal(f.calls.at(-1)?.operation === 'disconnect' && f.calls.at(-1)?.expected_account_ref, 'account_A');
});
test('cross-owner/org sessions and arbitrary owner/account nomination cannot reach runtime IO', async () => {
  const f = fixture(), begin = await begun(f);
  for (const caller of [{ ...f.caller, user_id: randomUUID() }, { ...f.caller, org_id: randomUUID() }]) {
    await assert.rejects(f.service.status(caller, { session_id: begin.session_id }), /access ended/);
    await assert.rejects(f.service.callback(caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'code' }), /access ended/);
  }
  await assert.rejects(f.service.begin(f.caller, { ...f.nomination, owner_user_id: randomUUID() }));
  await assert.rejects(f.service.refresh(f.caller, { session_id: begin.session_id, request_id: randomUUID(), account_ref: 'account_B' }));
  assert.equal(f.calls.length, 1);
});
test('expiry and revoked authority stop callbacks before provider IO', async () => {
  for (const end of ['expired', 'revoked'] as const) {
    const f = fixture(), begin = await begun(f);
    if (end === 'expired') f.clock(f.now() + 10 * 60_000); else f.revoke();
    await assert.rejects(f.service.callback(f.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'code' }), /access ended|Revoked/);
    assert.equal(f.calls.length, 1); assert.equal(f.rows.get(begin.session_id)?.callback_consumed, false);
  }
});
test('every deployment/grant/resource/operator/profile pin is rechecked against current authority', async () => {
  const patches = [{ app_version_id: randomUUID() }, { grant_snapshot_id: randomUUID() }, { package_digest: 'sha256:' + '8'.repeat(64) },
    { grant_snapshot_digest: 'sha256:' + '8'.repeat(64) }, { lifecycle_epoch: 2 }, { grant_epoch: 2 }, { runtime_epoch: 2 },
    { resource_binding_id: randomUUID() }, { runtime_registration_id: randomUUID() }, { operator_user_id: randomUUID() },
    { consent_expires_at: '2026-10-09T01:00:00.000Z' }, { profile_digest: 'sha256:' + '8'.repeat(64) }];
  for (const patch of patches) {
    const f = fixture(), begin = await begun(f); f.changeScope(patch);
    await assert.rejects(f.service.callback(f.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'code' }), /access ended/);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(), begin = await begun(f); f.changeProfile({ provider_id: 'other_mail' });
  await assert.rejects(f.service.status(f.caller, { session_id: begin.session_id }), /access ended/);
});
test('invalid state does not consume callback and concurrent callback is single use', async () => {
  const f = fixture(), begin = await begun(f);
  await assert.rejects(f.service.callback(f.caller, { session_id: begin.session_id, state: 'x'.repeat(43), outcome: 'authorized', code: 'code' }), /state changed/);
  assert.equal(f.rows.get(begin.session_id)?.callback_consumed, false);
  const callback = { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'code' };
  const replies = await Promise.allSettled([f.service.callback(f.caller, callback), f.service.callback(f.caller, callback)]);
  assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'callback').length, 1);
  await assert.rejects(f.service.callback(f.caller, callback), /state changed/);
});
test('unacknowledged durable store writes and wrong registered runtime identity fail before provider IO', async () => {
  const a = fixture(); a.failCreate(); await assert.rejects(a.service.begin(a.caller, a.nomination), /state changed/); assert.equal(a.calls.length, 0);
  const b = fixture(), begin = await begun(b); b.failCas();
  await assert.rejects(b.service.callback(b.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'code' }), /state changed/);
  assert.equal(b.calls.length, 1);
  const c = fixture(); c.wrongIdentity(); await assert.rejects(c.service.begin(c.caller, c.nomination), /access ended/); assert.equal(c.calls.length, 0);
});
test('unknown, malformed and failed provider outcomes persist indeterminate without automatic retry across service recreation', async () => {
  for (const reply of [() => Promise.reject(new Error('transport lost')), async () => ({ state: 'unknown_success' }),
    async () => ({ state: 'connected', account: { account_ref: 'account_A', label: 'Mail', access_token: 'forbidden' } }),
    async () => ({ state: 'indeterminate' })]) {
    const f = fixture(), begin = await begun(f); f.provider(reply);
    const callback = { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'code' };
    assert.equal((await f.service.callback(f.caller, callback)).state, 'indeterminate');
    const recreated = new AppConnectionSessionService(f.ports, f.now);
    assert.equal((await recreated.status(f.caller, { session_id: begin.session_id })).state, 'indeterminate');
    assert.equal((await recreated.disconnect(f.caller, { session_id: begin.session_id })).state, 'indeterminate');
    await assert.rejects(recreated.callback(f.caller, callback), /state changed/);
    assert.equal(f.calls.length, 2);
  }
});
test('pending callback status cannot establish a new account and denial cannot return connected', async () => {
  const f = fixture(), begin = await begun(f);
  assert.equal((await f.service.status(f.caller, { session_id: begin.session_id })).state, 'awaiting_callback'); assert.equal(f.calls.length, 1);
  f.provider(async () => ({ state: 'connected', account: { account_ref: 'account_B', label: 'Other mailbox' } }));
  assert.equal((await f.service.callback(f.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'denied' })).state, 'indeterminate');
});
test('status rejects account substitution and transmits only the host-retained account handle', async () => {
  const f = fixture(), { result } = await connected(f);
  f.provider(async () => ({ state: 'connected', account: { account_ref: 'account_B', label: 'Other mailbox' } }));
  const status = await f.service.status(f.caller, { session_id: result.session_id });
  assert.equal(status.state, 'indeterminate'); assert.equal(status.account?.account_ref, 'account_A');
  const call = f.calls.at(-1); assert.equal(call?.operation === 'status' && call.expected_account_ref, 'account_A');
});
test('changed authority after callback or refresh withholds outcomes and never repeats provider IO', async () => {
  const f = fixture(), begin = await begun(f);
  f.provider(async () => { f.changeScope({ grant_epoch: 2 }); return { state: 'connected', account: { account_ref: 'account_A', label: 'Mail' } }; });
  await assert.rejects(f.service.callback(f.caller, { session_id: begin.session_id, state: begin.callback_state, outcome: 'authorized', code: 'code' }), /access ended/);
  assert.equal(f.rows.get(begin.session_id)?.state, 'indeterminate'); assert.equal(f.calls.length, 2);
  const g = fixture(), { result } = await connected(g);
  const modified = new AppConnectionSessionService({ ...g.ports, async refreshResource(input) { g.revoke(); return {
    schema_version: 'deft.app_connection_refresh.v1', session_id: input.session_id, resource_binding_id: input.scope.resource_binding_id,
    run_id: randomUUID(), state: 'queued' }; } }, g.now);
  await assert.rejects(modified.refresh(g.caller, { session_id: result.session_id, request_id: randomUUID() }), /Revoked/);
});
test('unapproved redirect origins and secret-bearing begin replies become indeterminate', async () => {
  for (const url of ['https://unexpected.example/oauth', 'https://accounts.google.com/oauth?refresh_token=forbidden']) {
    const f = fixture(); f.provider(async () => ({ state: 'awaiting_callback', runtime_session_ref: 'runtime_session', authorization_url: url }));
    assert.equal((await f.service.begin(f.caller, f.nomination)).state, 'indeterminate'); assert.equal(f.calls.length, 1);
  }
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
test('revoke or expiry during successful durable CAS acknowledgement withholds the committed result without an obsolete CAS', async () => {
  for (const outcome of ['begin', 'callback'] as const) for (const end of ['revoke', 'expiry'] as const) {
    const f = fixture(), reached = deferred(), release = deferred();
    const begin = outcome === 'callback' ? await begun(f) : undefined;
    let writes = 0;
    const service = new AppConnectionSessionService({ ...f.ports, store: { ...f.ports.store,
      async compareAndSet(where, revision, next) {
        writes++;
        const committed = await f.ports.store.compareAndSet(where, revision, next);
        if (next.state === (outcome === 'begin' ? 'awaiting_callback' : 'connected')) { reached.resolve(); await release.promise; }
        return committed;
      },
    } }, f.now);
    const pending = outcome === 'begin' ? service.begin(f.caller, f.nomination) : service.callback(f.caller,
      { session_id: begin!.session_id, state: begin!.callback_state, outcome: 'authorized', code: 'code' });
    await reached.promise;
    if (end === 'revoke') f.revoke(); else f.clock(f.now() + 30 * 60_000);
    release.resolve();
    await assert.rejects(pending, /Revoked|access ended/);
    assert.equal(writes, outcome === 'begin' ? 1 : 2);
    assert.equal([...f.rows.values()][0]?.state, outcome === 'begin' ? 'awaiting_callback' : 'connected');
  }
});
test('refresh fences the connected custody revision and withholds a receipt after concurrent disconnect', async () => {
  const f = fixture(), { result } = await connected(f), reached = deferred(), release = deferred();
  const revision = f.rows.get(result.session_id)!.revision;
  let schedules = 0;
  const service = new AppConnectionSessionService({ ...f.ports, async refreshResource(input) {
    schedules++; assert.equal(input.session_revision, revision); assert.equal(input.account_ref, 'account_A');
    reached.resolve(); await release.promise;
    return { schema_version: 'deft.app_connection_refresh.v1', session_id: input.session_id,
      resource_binding_id: input.scope.resource_binding_id, run_id: randomUUID(), state: 'queued' };
  } }, f.now);
  const pending = service.refresh(f.caller, { session_id: result.session_id, request_id: randomUUID() });
  await reached.promise;
  assert.equal((await service.disconnect(f.caller, { session_id: result.session_id })).state, 'disconnected');
  release.resolve(); await assert.rejects(pending, /access ended/);
  assert.equal(schedules, 1); assert.equal(f.calls.length, 3);
});
test('runtime request, callback deadline and signal are independently capped by caller access expiry', async () => {
  const f = fixture(), accessExpiry = f.now() + 15;
  let aborted = false;
  f.provider(async (request, signal) => {
    assert.equal(Date.parse(request.expires_at), accessExpiry);
    assert.equal(Date.parse(f.rows.get(request.session_id)!.callback_expires_at), accessExpiry);
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; f.clock(accessExpiry); resolve(); }, { once: true }));
    return { state: 'indeterminate' };
  });
  await assert.rejects(f.service.begin({ ...f.caller, access_expires_at: accessExpiry }, f.nomination), /access ended/);
  assert.equal(aborted, true); assert.equal(f.calls.length, 1);
});
test('a shorter deadline returned by the last authority check caps the runtime request', async () => {
  const f = fixture(), shorter = f.now() + 5000;
  const service = new AppConnectionSessionService({ ...f.ports, async registeredRuntime(scope, profile) {
    f.authorityExpiry(shorter); return f.ports.registeredRuntime(scope, profile);
  } }, f.now);
  const result = await service.begin(f.caller, f.nomination);
  assert.equal(result.state, 'awaiting_callback'); assert.equal(Date.parse(f.calls[0]!.expires_at), shorter);
});
