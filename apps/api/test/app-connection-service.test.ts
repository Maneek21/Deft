import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AppConnectionRegistry, loadAppConnectionRegistry } from '../src/lib/app-connection-registry.js';
import { AppConnectionService } from '../src/lib/app-connection-service.js';
import { AppConnectionPinsSchema, type AppConnectionProjection, type AppConnectionPurpose } from '../src/lib/app-connection-contract.js';

const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
const sessionId = randomUUID();
const pins = { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: randomUUID(),
  app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), target_key: 'personal', resource_key: 'inbox',
  resource_binding_id: randomUUID(), action_key: 'send_message', action_binding_id: randomUUID() };
const projection: AppConnectionProjection = { ...pins, purpose: 'status', web_session_id: caller.sid, experience_session_id: sessionId,
  runtime_registration_id: randomUUID(), descriptor_digest: 'sha256:' + '1'.repeat(64),
  allowed_operations: ['list_summary', 'read_one'], lifecycle_epoch: 1, grant_epoch: 1, runtime_epoch: 7,
  expires_at: Date.now() + 60_000, checked_at: Date.now() };
const nomination = { installation_id: pins.installation_id, target_key: pins.target_key };

test('connection completion uses registry pins and withholds late cache outcome after authority changes', async () => {
  let changed = false, completions = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { handle: async () => Response.json({ state: 'connected', account: { account_id: 'stable', health: 'connected' } }) } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async (_caller, _session, _pins, _signal, purpose) =>
    ({ ...projection, purpose: purpose!, lifecycle_epoch: changed ? 2 : 1 }) }, Date.now, () => performance.now(), async input => {
      completions++; assert.deepEqual(input.entry.pins, pins); assert.equal(input.caller.sid, caller.sid);
      changed = true; return { ...(input.result as object), native_email: { state: 'active' } };
    });
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'callback', { state: 's'.repeat(43), code: 'synthetic' }, undefined), /access changed/);
  assert.equal(completions, 1);
});

const documentPolicy: NonNullable<AppConnectionProjection['content_policy']> = { document: {
  max_characters: 16384, metadata_schema: { type: 'object', additionalProperties: false,
    properties: { subject: { type: 'string', maxLength: 200, format: 'single_line' } }, required: ['subject'] },
} };
function policyService(rederive: (check: number) => AppConnectionProjection) {
  let checks = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(_request, context) {
    await context.recheck(); return Response.json({ state: 'not_connected' });
  } } }]);
  return new AppConnectionService(registry, { connectionSetup: async () => rederive(++checks) });
}

test('status accepts a separately rederived equal document policy rather than requiring object identity', async () => {
  const service = policyService(check => ({ ...projection, content_policy: check === 1 ? structuredClone(documentPolicy)
    : { document: { metadata_schema: structuredClone(documentPolicy.document.metadata_schema!), max_characters: 16384 } } }));
  assert.deepEqual(await service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), { state: 'not_connected' });
});

test('status rejects changed document bounds and nested metadata disclosure before returning account status', async () => {
  for (const change of [(p: typeof documentPolicy) => { p.document.max_characters--; },
    (p: typeof documentPolicy) => { p.document.metadata_schema!.properties.subject!.maxLength = 201; },
    (p: typeof documentPolicy) => { delete p.document.metadata_schema; }]) {
    const service = policyService(check => {
      const content_policy = structuredClone(documentPolicy); if (check > 1) change(content_policy);
      return { ...projection, content_policy };
    });
    await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access changed/);
  }
});

test('status rejects document policy being added or removed between authority checks', async () => {
  for (const initiallyPresent of [false, true]) {
    const service = policyService(check => ({ ...projection,
      ...(initiallyPresent === (check === 1) ? { content_policy: structuredClone(documentPolicy) } : {}) }));
    await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access changed/);
  }
});

test('equal document policy cannot hide changed owner, resource pins, operations or extra projection fields', async () => {
  for (const change of [{ owner_user_id: randomUUID() }, { resource_binding_id: randomUUID() },
    { allowed_operations: ['list_summary'] as const }, { unreviewed_policy: true }]) {
    const service = policyService(check => ({ ...projection, content_policy: structuredClone(documentPolicy), ...(check > 1 ? change : {}) }));
    await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access changed/);
  }
});

test('unconfigured, duplicate, foreign owner and foreign target adapters fail closed', async () => {
  const empty = await loadAppConnectionRegistry(undefined);
  assert.throws(() => empty.select({ org_id: caller.org_id, owner_user_id: caller.user_id, ...nomination }));
  const entry = { pins, adapter: { handle: async () => Response.json({}) } };
  const registry = new AppConnectionRegistry([entry]);
  assert.throws(() => registry.select({ org_id: caller.org_id, owner_user_id: randomUUID(), ...nomination }));
  assert.throws(() => registry.select({ org_id: caller.org_id, owner_user_id: caller.user_id, ...nomination, target_key: 'work' }));
  assert.throws(() => new AppConnectionRegistry([entry, entry]).select({ org_id: caller.org_id, owner_user_id: caller.user_id, ...nomination }));
  assert.throws(() => AppConnectionPinsSchema.parse({ ...pins, action_binding_id: null }));
});

test('host connection dispatch accepts only closed nominations and independently rechecks current authority', async () => {
  let checks = 0, calls = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(request, context) {
    calls++;
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.headers.get('cookie'), null);
    assert.equal(context.projection.web_session_id, caller.sid);
    assert.deepEqual(await request.json(), {});
    await context.recheck();
    return Response.json({ state: 'not_connected' });
  } } }]);
  const service = new AppConnectionService(registry, { async connectionSetup(actual, actualSession, actualPins, _signal, purpose) {
    checks++; assert.deepEqual(actual, caller); assert.equal(actualSession, sessionId); assert.deepEqual(actualPins, pins);
    assert.equal(purpose, 'status');
    return projection;
  } });
  assert.deepEqual(await service.invoke(caller, sessionId, nomination, 'manage', {}, 'https://deft.test'), { state: 'not_connected' });
  assert.equal(calls, 1); assert.equal(checks, 3);
  for (const raw of [{ owner_user_id: randomUUID() }, { account_id: 'attacker' }, { provider: 'gmail' }]) {
    await assert.rejects(service.invoke(caller, sessionId, nomination, 'begin', raw, 'https://deft.test'));
  }
  assert.equal(calls, 1);
});

test('callback and provider errors cannot leak bearer credentials or raw provider descriptions', async () => {
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(request) {
    assert.equal(request.method, 'GET');
    assert.equal(new URL(request.url).searchParams.get('state'), 's'.repeat(32));
    assert.equal(new URL(request.url).searchParams.get('code'), 'opaque-code');
    return Response.json({ error: 'provider-secret-in-description', code: 'EMAIL_OAUTH_REAUTH_REQUIRED' }, { status: 403 });
  } } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async () => ({ ...projection, purpose: 'connect' }) });
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'callback', { state: 's'.repeat(32), code: 'opaque-code' }, undefined),
    (error: unknown) => error instanceof Error && !error.message.includes('provider-secret') && error.message === 'Account connection needs attention');
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'callback', { state: 's'.repeat(32), code: 'opaque-code', error: 'denied' }, undefined));
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'callback', { state: 's'.repeat(32), code: 'opaque-code', provider: 'gmail' }, undefined));
});

test('withdrawal after module I/O withholds completed account identity', async () => {
  let current = true;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle() {
    current = false; return Response.json({ state: 'connected', address: 'private@example.test' });
  } } }]);
  const service = new AppConnectionService(registry, { async connectionSetup() {
    if (!current) throw Error('withdrawn'); return projection;
  } });
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /withdrawn/);
});

test('connection retains the original conservative deadline across adapter I/O and later session renewal', async () => {
  let elapsed = 0, checks = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle() {
    elapsed = 100; return Response.json({ state: 'connected' });
  } } }]);
  const service = new AppConnectionService(registry, { async connectionSetup() {
    checks++; return { ...projection, checked_at: 2000, expires_at: checks === 1 ? 2050 : 4000 };
  } }, () => 1000, () => elapsed);
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access ended/);
});

test('connection epoch changes during module I/O withhold the result', async () => {
  let epoch = projection.runtime_epoch;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle() {
    epoch++; return Response.json({ state: 'connected' });
  } } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async () => ({ ...projection, runtime_epoch: epoch }) });
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access changed/);
});

test('connection output is bounded while reading and registry nominations cannot mutate after construction', async () => {
  let cancelled = false;
  const mutable = { ...pins }, entries = [{ pins: mutable, adapter: { async handle() {
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(32_768)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } });
  } } }];
  const registry = new AppConnectionRegistry(entries);
  mutable.target_key = 'work'; entries.length = 0;
  const service = new AppConnectionService(registry, { connectionSetup: async () => projection });
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /response is unavailable/);
  assert.equal(cancelled, true);
});

test('a stalled JSON stream ends at the captured authority deadline without waiting for cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0, cancelled = false, requestSignal: AbortSignal | undefined;
  let outcome = 'pending', failure: unknown;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(request) {
    requestSignal = request.signal;
    return new Response(new ReadableStream({
      cancel() { cancelled = true; return new Promise<void>(() => undefined); },
    }), { headers: { 'content-type': 'application/json' } });
  } } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async () => ({ ...projection, checked_at: 1000, expires_at: 1010 }) },
    () => 1000, () => elapsed);
  const pending = service.invoke(caller, sessionId, nomination, 'manage', {}, undefined).then(
    () => { outcome = 'resolved'; }, error => { outcome = 'rejected'; failure = error; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(outcome, 'pending');
  elapsed = 11; t.mock.timers.tick(11);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(outcome, 'rejected');
  await pending;
  assert.match(String(failure), /access ended/);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(cancelled, true);
});

test('noncooperative adapter execution is capped at thirty seconds and receives the abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal: AbortSignal | undefined, outcome = 'pending', failure: unknown;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(request) {
    requestSignal = request.signal;
    return new Promise<Response>(() => undefined);
  } } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async () => ({ ...projection, checked_at: 1000, expires_at: 100_000 }) },
    () => 1000, () => 0);
  const pending = service.invoke(caller, sessionId, nomination, 'manage', {}, undefined).then(
    () => { outcome = 'resolved'; }, error => { outcome = 'rejected'; failure = error; });
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(29_999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(outcome, 'pending');
  t.mock.timers.tick(1);
  await pending;
  assert.equal(outcome, 'rejected');
  assert.match(String(failure), /response is unavailable/);
  assert.equal(requestSignal?.aborted, true);
});

test('caller abort races a stalled reader and cancels without waiting for its cancellation promise', async () => {
  const controller = new AbortController(), reason = new Error('Caller cancelled');
  let cancelled = false, requestSignal: AbortSignal | undefined;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(request) {
    requestSignal = request.signal;
    return new Response(new ReadableStream({
      cancel() { cancelled = true; return new Promise<void>(() => undefined); },
    }), { headers: { 'content-type': 'application/json' } });
  } } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async () => projection });
  const pending = assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined, controller.signal),
    error => error === reason);
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort(reason);
  await pending;
  assert.equal(requestSignal?.aborted, true);
  assert.equal(cancelled, true);
});

test('a response arriving after timeout is cancelled and never rechecks or publishes its body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release: (response: Response) => void = () => undefined, cancelled = false, checks = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle() {
    return new Promise<Response>(resolve => { release = resolve; });
  } } }]);
  const service = new AppConnectionService(registry, { async connectionSetup() {
    checks++; return { ...projection, checked_at: 1000, expires_at: 1010 };
  } }, () => 1000, () => 0);
  const pending = assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access ended/);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(10);
  await pending;
  release(new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise<void>(() => undefined); },
  }), { headers: { 'content-type': 'application/json' } }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(checks, 1);
});

test('successful completion cleans its deadline timer and caller abort listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(request) {
    requestSignal = request.signal;
    return Response.json({ state: 'not_connected' });
  } } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async () => ({ ...projection, checked_at: 1000, expires_at: 1010 }) },
    () => 1000, () => 0);
  assert.deepEqual(await service.invoke(caller, sessionId, nomination, 'manage', {}, undefined, controller.signal), { state: 'not_connected' });
  t.mock.timers.tick(30_000);
  controller.abort();
  assert.equal(requestSignal?.aborted, false);
});

test('expiry while arming the I/O budget cannot start adapter execution', async () => {
  let timeChecks = 0, calls = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle() {
    calls++; return Response.json({ state: 'not_connected' });
  } } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async () => ({ ...projection, checked_at: 1000, expires_at: 1010 }) },
    () => ++timeChecks === 1 ? 1000 : 1011, () => 0);
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access ended/);
  assert.equal(calls, 0);
});

test('host derives the same closed purpose for initial authority, adapter and final rechecks', async () => {
  const seen: AppConnectionPurpose[] = [];
  let calls = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(request, context) {
    calls++;
    const expected = new URL(request.url).pathname === '/connections/manage'
      ? ((await request.json()) as { operation?: AppConnectionPurpose }).operation ?? 'status' : 'connect';
    assert.equal(context.projection.purpose, expected);
    assert.equal((await context.recheck()).purpose, expected);
    return Response.json({ state: 'not_connected' });
  } } }]);
  const service = new AppConnectionService(registry, { async connectionSetup(_caller, _session, _pins, _signal, purpose = 'connect') {
    seen.push(purpose); return { ...projection, purpose };
  } });
  for (const [operation, body, purpose] of [
    ['begin', {}, 'connect'], ['callback', { state: 's'.repeat(32), code: 'opaque-code' }, 'connect'],
    ['manage', {}, 'status'], ['manage', { operation: 'status' }, 'status'], ['manage', { operation: 'disconnect' }, 'disconnect'],
  ] as const) {
    seen.length = 0;
    await service.invoke(caller, sessionId, nomination, operation, body, undefined);
    assert.deepEqual(seen, [purpose, purpose, purpose]);
  }
  for (const [operation, body] of [
    ['begin', { purpose: 'status' }], ['callback', { state: 's'.repeat(32), code: 'opaque-code', purpose: 'status' }],
    ['manage', { purpose: 'connect' }], ['manage', { operation: 'send' }], ['manage', { operation: 'revoke_provider_grant' }],
  ] as const) await assert.rejects(service.invoke(caller, sessionId, nomination, operation, body, undefined));
  assert.equal(calls, 5);
});

test('wrong initial purpose and a purpose changed during adapter I/O withhold dispatch or output', async () => {
  let purpose: AppConnectionPurpose = 'connect', calls = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle() {
    calls++; purpose = 'disconnect'; return Response.json({ state: 'connected', address: 'private@example.test' });
  } } }]);
  const service = new AppConnectionService(registry, { connectionSetup: async () => ({ ...projection, purpose }) });
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access changed/);
  assert.equal(calls, 0);
  purpose = 'status';
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', {}, undefined), /access changed/);
  assert.equal(calls, 1);
});

test('legacy authority adapters retain their resource gate while withdrawn action authority denies connect', async () => {
  let actionLive = true, resourceLive = true, calls = 0;
  const registry = new AppConnectionRegistry([{ pins, adapter: { async handle(_request, context) {
    calls++; await context.recheck(); return Response.json({ state: 'not_connected' });
  } } }]);
  const service = new AppConnectionService(registry, { async connectionSetup(_caller, _session, _pins, _signal, purpose = 'connect') {
    if (!resourceLive || purpose === 'connect' && !actionLive) throw Error('authority withdrawn');
    return { ...projection, purpose };
  } });
  actionLive = false;
  for (const body of [{}, { operation: 'disconnect' }]) await service.invoke(caller, sessionId, nomination, 'manage', body, undefined);
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'begin', {}, undefined), /authority withdrawn/);
  await assert.rejects(service.invoke(caller, sessionId, nomination, 'callback', { state: 's'.repeat(32), code: 'opaque-code' }, undefined), /authority withdrawn/);
  assert.equal(calls, 2);
  resourceLive = false;
  for (const body of [{}, { operation: 'disconnect' }]) await assert.rejects(service.invoke(caller, sessionId, nomination, 'manage', body, undefined), /authority withdrawn/);
  assert.equal(calls, 2);
});

test('retained management uses only owner cleanup authority after read and Send expire',async()=>{
 let calls=0,checks=0,current=true;
 const registry=new AppConnectionRegistry([{pins,adapter:{async handle(request,context){
  calls++;assert.equal(request.headers.get('authorization'),null);assert.deepEqual(context.projection.allowed_operations,[]);
  await context.recheck();return Response.json({state:'not_connected'});
 }}}]);
 const service=new AppConnectionService(registry,{async connectionSetup(){throw Error('read/Send expired');},
  async connectionCleanup(actual,actualPins,_signal,purpose='status'){
   checks++;assert.deepEqual(actual,caller);assert.deepEqual(actualPins,pins);if(!current)throw Error('web session revoked');
   return{...projection,purpose,experience_session_id:caller.sid,allowed_operations:[]};
  }});
 for(const body of [{},{operation:'disconnect'}])assert.deepEqual(await service.invokeRetained(caller,nomination,body,undefined),{state:'not_connected'});
 assert.equal(calls,2);assert.equal(checks,6);
 await assert.rejects(service.invoke(caller,sessionId,nomination,'begin',{},undefined),/read\/Send expired/);
 for(const body of [{operation:'connect'},{owner_user_id:randomUUID()},{operation:'disconnect',resource_binding_id:randomUUID()}])
  await assert.rejects(service.invokeRetained(caller,nomination,body,undefined));
 await assert.rejects(service.invokeRetained({...caller,user_id:randomUUID()},nomination,{},undefined));
 current=false;await assert.rejects(service.invokeRetained(caller,nomination,{},undefined),/web session revoked/);assert.equal(calls,2);
});
test('retained cleanup withholds a held identity when current web authority is revoked during module I/O',async()=>{
 let current=true;
 const registry=new AppConnectionRegistry([{pins,adapter:{async handle(){current=false;return Response.json({state:'connected',address:'private@example.test'});}}}]);
 const service=new AppConnectionService(registry,{async connectionSetup(){throw Error('expired');},async connectionCleanup(_caller,_pins,_signal,purpose='status'){
  if(!current)throw Error('web session revoked');return{...projection,purpose,experience_session_id:caller.sid,allowed_operations:[]};
 }});
 await assert.rejects(service.invokeRetained(caller,nomination,{},undefined),/web session revoked/);
});
test('retained targets disclose only registry-nominated owner keys and independently validate stored custody',async()=>{
 const foreign={...pins,owner_user_id:randomUUID(),target_key:'work'};
 const registry=new AppConnectionRegistry([pins,foreign].map(p=>({pins:p,adapter:{handle:async()=>Response.json({})}})));
 let current=true,checks=0;
 const service=new AppConnectionService(registry,{async connectionSetup(){throw Error('expired');},async connectionCleanup(_caller,_pins,_signal,purpose='status'){
  checks++;if(!current)throw Error('web session revoked');return{...projection,purpose,allowed_operations:[]};
 }});
 assert.deepEqual(await service.retainedTargets(caller,pins.installation_id),{targets:[{key:'personal'}]});assert.equal(checks,1);
 assert.deepEqual(await service.retainedTargets({...caller,user_id:randomUUID()},pins.installation_id),{targets:[]});assert.equal(checks,1);
 current=false;await assert.rejects(service.retainedTargets(caller,pins.installation_id),/web session revoked/);
});
