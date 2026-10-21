import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { AppConnectionSessionRegistry, AppConnectionSessionRegistryConfigSchema, connectionProfileDigest,
  readBoundedConnectionJson } from '../src/lib/app-connection-session-registry.js';
import { AppError } from '../src/lib/app-errors.js';

test('data transport retains safe structured Runtime reasons instead of reporting profile unavailability',async()=>{
 const cases=[['EMAIL_DATA_SOURCE_CHANGED','APP_RUNTIME_SOURCE_CHANGED',409],['EMAIL_DATA_AUTHORITY_DENIED','APP_RUNTIME_ACCESS_DENIED',403],
  ['MAIL_DATA_CONNECTION_DENIED','APP_RUNTIME_ACCESS_DENIED',403],['MAIL_RUNTIME_SESSION_DENIED','APP_RUNTIME_ACCESS_DENIED',403],
  ['EMAIL_DATA_CONFLICT','APP_RUNTIME_CONFLICT',409],['EMAIL_DATA_NOT_FOUND','APP_RUNTIME_NOT_FOUND',404],
  ['EMAIL_DATA_INPUT_INVALID','APP_RUNTIME_INPUT_INVALID',400]] as const;
 for(const [runtimeCode,code,status] of cases){
  const f=fixture((async()=>Response.json({error:runtimeCode},{status:403})) as typeof fetch);
  const input={schema_version:'deft.app_data_runtime.v1' as const,request_id:randomUUID(),scope:f.scope,
   connection:{session_id:randomUUID(),session_revision:1,runtime_session_ref:'runtime',account_ref:'account'},
   authority:{consent_id:null,consent_digest:null,data_policy_digest:'sha256:'+'a'.repeat(64)},expires_at:f.scope.consent_expires_at,
   operation:'resource_read_presentation' as const,input:{store_key:'inbox',resource_key:'messages',record_id:randomUUID(),content_digest:'sha256:'+'b'.repeat(64)}};
  await assert.rejects(f.registry.dataRuntime(f.scope,f.profile).request(input,new AbortController().signal),(error:unknown)=>{
   assert.ok(error instanceof AppError);assert.equal(error.code,code);assert.equal(error.status,status);assert.equal(error.details?.runtime_code,runtimeCode);
   assert.doesNotMatch(error.message,/profile unavailable/);return true;
  });
 }
});

function fixture(fetcher: typeof fetch = fetch) {
  const token = 'a'.repeat(43);
  const profile = { schema_version: 'deft.app_connection_profile.v1' as const, key: 'mail', provider_id: 'google_mail',
    operator_user_id: randomUUID(), runtime_requirement_key: 'mail', resource_key: 'messages', action_keys: ['send_message'],
    authorization_origin: 'https://accounts.google.com', credential_custody: 'runtime' as const, executable: false as const };
  const scope = { org_id: randomUUID(), owner_user_id: randomUUID(), installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), package_digest: 'sha256:' + '1'.repeat(64), grant_snapshot_digest: 'sha256:' + '2'.repeat(64),
    lifecycle_epoch: 1, grant_epoch: 1, target_key: 'personal', resource_key: 'messages', resource_binding_id: randomUUID(),
    runtime_registration_id: randomUUID(), operator_user_id: profile.operator_user_id, runtime_epoch: 1,
    profile_digest: connectionProfileDigest(profile), consent_expires_at: new Date(Date.now() + 600000).toISOString() };
  const config = { schema_version: 'deft.app_connection_http_registrations.v1', entries: [{ org_id: scope.org_id,
    installation_id: scope.installation_id, runtime_registration_id: scope.runtime_registration_id, runtime_epoch: 1, profile,
    endpoint: 'https://runtime.example.test/v1/connections', runtime_auth_token: 'b'.repeat(43),
    authority_token_sha256: 'sha256:' + createHash('sha256').update(token).digest('hex') }] };
  const registry = new AppConnectionSessionRegistry(config, fetcher);
  return { token, profile, scope, config, registry, input: { schema_version: 'deft.app_connection_runtime.v1' as const,
    operation: 'begin' as const, session_id: randomUUID(), scope, expires_at: scope.consent_expires_at, callback_state: 'c'.repeat(43) } };
}

test('deployment config accepts data-only HTTPS endpoint and rejects URL credentials, query, modules and duplicate review', () => {
  const f = fixture();
  for (const endpoint of ['http://127.0.0.1/v1/connections', 'https://user:pass@runtime.test/v1/connections',
    'https://runtime.test/v1/connections?token=secret', 'https://runtime.test/v1/connections#x', 'https://runtime.test/author-route']) {
    assert.equal(AppConnectionSessionRegistryConfigSchema.safeParse({ ...f.config,
      entries: [{ ...f.config.entries[0], endpoint }] }).success, false);
  }
  assert.throws(() => new AppConnectionSessionRegistry({ ...f.config, entries: [f.config.entries[0], f.config.entries[0]] }));
  assert.equal(AppConnectionSessionRegistryConfigSchema.safeParse({ ...f.config,
    entries: [{ ...f.config.entries[0], module_path: '/tmp/provider.js' }] }).success, false);
});
test('reviewed protocol readiness never falls back between v1 and independent v2 grants',()=>{
 const f=fixture(),entry=f.config.entries[0]!;
 assert.equal(f.registry.protocol(f.scope,f.profile),'v1');
 assert.throws(()=>f.registry.runtimeV2(f.scope,f.profile));assert.throws(()=>f.registry.upgradeRuntime(f.scope,f.profile));
 const registry=new AppConnectionSessionRegistry({...f.config,entries:[{...entry,connection_protocol:'v2'}]});
 assert.equal(registry.protocol(f.scope,f.profile),'v2');registry.assertReady(f.scope,f.profile);
 assert.equal(registry.reviewedProtocol(f.scope.org_id,f.scope.installation_id,f.profile),'v2');
 const bootstrap={...f.scope,runtime_registration_id:randomUUID()};
 assert.throws(()=>registry.assertReady(bootstrap,f.profile));
 assert.throws(()=>registry.runtimeV2(bootstrap,f.profile));
 assert.equal(registry.reviewedProtocol(bootstrap.org_id,bootstrap.installation_id,f.profile),'v2','metadata review does not require enrolled target transport');
 assert.throws(()=>registry.reviewedProtocol(randomUUID(),f.scope.installation_id,f.profile));
 assert.throws(()=>registry.runtime(f.scope,f.profile));assert.ok(registry.reattachmentRuntime(f.scope,f.profile));
 assert.equal(registry.runtimeV2(f.scope,f.profile).identity.runtime_epoch,1);assert.ok(registry.upgradeRuntime(f.scope,f.profile));
 assert.equal(registry.transportDigest(f.scope.org_id,f.scope.installation_id,f.profile),f.registry.transportDigest(f.scope.org_id,f.scope.installation_id,f.profile));
 assert.throws(()=>new AppConnectionSessionRegistry({...f.config,entries:[entry,{...entry,runtime_registration_id:randomUUID(),connection_protocol:'v2'}]}));
 assert.equal(AppConnectionSessionRegistryConfigSchema.safeParse({...f.config,entries:[{...entry,connection_protocol:'automatic'}]}).success,false);
});

test('transport sends exact reviewed schema and runtime-only token with redirects disabled', async () => {
  let calls = 0;
  const f = fixture((async (url, init) => {
    calls++;
    assert.equal(url, 'https://runtime.example.test/v1/connections'); assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers); assert.equal(headers.get('authorization'), 'Bearer ' + 'b'.repeat(43));
    assert.equal(headers.has('cookie'), false); assert.deepEqual(JSON.parse(String(init?.body)), f.input);
    return Response.json({ state: 'awaiting_callback', runtime_session_ref: 'opaque', authorization_url: 'https://accounts.google.com/auth' });
  }) as typeof fetch);
  await f.registry.runtime(f.scope, f.profile).request(f.input, new AbortController().signal);
  assert.equal(calls, 1);
  for (const patch of [{ org_id: randomUUID() }, { runtime_registration_id: randomUUID() }, { runtime_epoch: 2 },
    { operator_user_id: randomUUID() }, { profile_digest: 'sha256:' + '3'.repeat(64) }]) {
    assert.throws(() => f.registry.runtime({ ...f.scope, ...patch }, f.profile));
  }
  f.registry.authenticate(f.scope, 'Bearer ' + f.token);
  const changedTransport = new AppConnectionSessionRegistry({ ...f.config, entries: [{ ...f.config.entries[0],
    endpoint: 'https://replacement.test/v1/connections' }] });
  assert.notEqual(changedTransport.transportDigest(f.scope.org_id, f.scope.installation_id, f.profile),
    f.registry.transportDigest(f.scope.org_id, f.scope.installation_id, f.profile));
  for (const authorization of [undefined, 'Bearer ' + 'b'.repeat(43), 'Bearer owner-web-token', 'Basic ' + f.token]) {
    assert.throws(() => f.registry.authenticate(f.scope, authorization));
  }
});

test('transport withholds non-JSON, redirects, credentials in response, and oversized responses', async () => {
  for (const response of [new Response('plain'), new Response('', { status: 302, headers: { location: 'https://foreign.test' } }),
    Response.json({ state: 'connected', account: { account_ref: 'opaque', label: 'Mailbox', access_token: 'secret' } }),
    new Response(' '.repeat(16385), { headers: { 'content-type': 'application/json' } })]) {
    const f = fixture((async () => response) as typeof fetch);
    await assert.rejects(f.registry.runtime(f.scope, f.profile).request(f.input, new AbortController().signal));
  }
});

test('distinct owner registrations share only an identical reviewed profile and transport', () => {
  const f = fixture(), first = f.config.entries[0]!;
  const second = { ...first, runtime_registration_id: randomUUID() };
  const registry = new AppConnectionSessionRegistry({ ...f.config, entries: [first, second] });
  const policy = { key: 'mailbox', resource_key: 'messages', action_keys: ['send_message'], max_consent_seconds: 86400,
    provider_profile_key: 'mail', runtime_requirement_key: 'mail' };
  assert.deepEqual(registry.profile(f.scope.org_id, f.scope.installation_id, policy, f.profile.operator_user_id), f.profile);
  assert.equal(registry.transportDigest(f.scope.org_id, f.scope.installation_id, f.profile),
    f.registry.transportDigest(f.scope.org_id, f.scope.installation_id, f.profile));
  assert.equal(registry.runtime(f.scope, f.profile).identity.runtime_registration_id, first.runtime_registration_id);
  assert.equal(registry.runtime({ ...f.scope, owner_user_id: randomUUID(), resource_binding_id: randomUUID(),
    runtime_registration_id: second.runtime_registration_id }, f.profile).identity.runtime_registration_id, second.runtime_registration_id);
  // A retired/current epoch pair remains exact rather than being collapsed.
  const epochs = new AppConnectionSessionRegistry({ ...f.config, entries: [first, { ...first, runtime_epoch: 2 }] });
  assert.equal(epochs.runtime({ ...f.scope, runtime_epoch: 2 }, f.profile).identity.runtime_epoch, 2);
  for (const patch of [{ endpoint: 'https://replacement.test/v1/connections' }, { runtime_auth_token: 'z'.repeat(43) },
    { authority_token_sha256: 'sha256:' + '9'.repeat(64) }, { profile: { ...first.profile, authorization_origin: 'https://replacement.test' } }]) {
    assert.throws(() => new AppConnectionSessionRegistry({ ...f.config, entries: [first, { ...second, ...patch }] }));
  }
  assert.throws(() => new AppConnectionSessionRegistry({ ...f.config, entries: [first, first] }));
});

test('bounded JSON cancels stalled body on caller abort and rejects invalid UTF8', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const pending = readBoundedConnectionJson(new ReadableStream({ cancel() { cancelled = true; } }), controller.signal);
  controller.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
  await assert.rejects(readBoundedConnectionJson(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0xff])); c.close(); } })));
});

test('reattachment uses the exact reviewed transport and separate closed protocol', async () => {
  let calls = 0;
  const f = fixture((async (url, init) => {
    calls++; assert.equal(url, f.config.entries[0].endpoint); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + 'b'.repeat(43));
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    return Response.json({ schema_version: input.schema_version, session_id: input.session_id,
      state: 'eligible', account: { account_ref: 'stable_account', label: 'Mailbox' },
      custody_generation: 1, custody_digest: 'sha256:' + 'a'.repeat(64) });
  }) as typeof fetch);
  const input = { schema_version: 'deft.app_connection_reattach_runtime.v1' as const,
    operation: 'prepare' as const, session_id: randomUUID(), scope: f.scope,
    source: { session_id: randomUUID(), session_revision: 2, scope: { ...f.scope, app_version_id: randomUUID() },
      runtime_session_ref: 'historical_ref', account_ref: 'stable_account' },
    transport_digest: f.registry.transportDigest(f.scope.org_id, f.scope.installation_id, f.profile),
    review_expires_at: f.scope.consent_expires_at, expires_at: f.scope.consent_expires_at };
  const transport = f.registry.reattachmentRuntime(f.scope, f.profile);
  assert.equal((await transport.request(input, new AbortController().signal)).state, 'eligible');
  await assert.rejects(transport.request({ ...input, scope: { ...f.scope, owner_user_id: randomUUID() } }, new AbortController().signal));
  assert.equal(calls, 1);
  for (const response of [
    Response.json({ state: 'connected', account: { account_ref: 'stable_account', label: 'Mailbox' } }),
    Response.json({ schema_version: input.schema_version, session_id: input.session_id, state: 'indeterminate', access_token: 'forbidden' }),
    new Response('', { status: 302, headers: { location: 'https://foreign.test' } }),
    new Response(' '.repeat(16385), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const registry = new AppConnectionSessionRegistry(f.config, (async () => response) as typeof fetch);
    await assert.rejects(registry.reattachmentRuntime(f.scope, f.profile).request(input, new AbortController().signal));
  }
});


test('exact concurrent policy variants retain old registrations and reject cross-profile scope', () => {
  const f = fixture(), original = f.config.entries[0]!;
  const newer = { ...original, runtime_registration_id: randomUUID(), connection_protocol: 'v2',
    profile: { ...f.profile, action_keys: ['organize_messages', 'send_message'] } };
  const registry = new AppConnectionSessionRegistry({ ...f.config, entries: [original, newer] });
  const policy = (actions: string[]) => ({ key: 'personal', provider_profile_key: f.profile.key,
    resource_key: f.profile.resource_key, runtime_requirement_key: f.profile.runtime_requirement_key,
    action_keys: actions, max_consent_seconds: 600 });
  assert.deepEqual(registry.profile(f.scope.org_id, f.scope.installation_id, policy(f.profile.action_keys), f.profile.operator_user_id), f.profile);
  assert.deepEqual(registry.profile(f.scope.org_id, f.scope.installation_id, policy(newer.profile.action_keys), f.profile.operator_user_id), newer.profile);
  assert.equal(registry.protocol(f.scope, f.profile), 'v1');
  const scope = { ...f.scope, runtime_registration_id: newer.runtime_registration_id, profile_digest: connectionProfileDigest(newer.profile) };
  assert.equal(registry.protocol(scope, newer.profile), 'v2');
  assert.throws(() => registry.protocol(f.scope, newer.profile));
  assert.throws(() => registry.protocol(scope, f.profile));
  for (const changed of [policy(['send_message', 'organize_messages']), { ...policy(newer.profile.action_keys), resource_key: 'other' },
    { ...policy(newer.profile.action_keys), runtime_requirement_key: 'other' }]) {
    assert.throws(() => registry.profile(f.scope.org_id, f.scope.installation_id, changed, f.profile.operator_user_id));
  }
  for (const patch of [{ endpoint: 'https://other.test/v1/connections' }, { connection_protocol: 'v2' },
    { profile: { ...original.profile, provider_id: 'different' } }]) {
    assert.throws(() => new AppConnectionSessionRegistry({ ...f.config, entries: [original,
      { ...original, runtime_registration_id: randomUUID(), ...patch }] }));
  }
  const otherOperator = { ...original, runtime_registration_id: randomUUID(), profile: { ...original.profile, operator_user_id: randomUUID() } };
  const ambiguous = new AppConnectionSessionRegistry({ ...f.config, entries: [original, otherOperator] });
  assert.throws(() => ambiguous.profile(f.scope.org_id, f.scope.installation_id, policy(f.profile.action_keys)));
});

test('v2 reattachment transport denies v1 relabel before I/O and preserves independent consent wire',async()=>{
 let calls=0;const f=fixture(),registry=new AppConnectionSessionRegistry({...f.config,entries:[{...f.config.entries[0],connection_protocol:'v2'}]},(async(_url,options)=>{
  calls++;const input=JSON.parse(String(options?.body));assert.equal(input.schema_version,'deft.app_connection_reattach_runtime.v2');assert.deepEqual(input.action_consents,[]);
  return Response.json({schema_version:input.schema_version,session_id:input.session_id,state:'indeterminate'});
 }) as typeof fetch);
 const input={schema_version:'deft.app_connection_reattach_runtime.v2' as const,operation:'prepare' as const,session_id:randomUUID(),scope:f.scope,action_consents:[],
  source:{session_id:randomUUID(),session_revision:2,scope:{...f.scope,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),lifecycle_epoch:0,grant_epoch:0},runtime_session_ref:'retained',account_ref:'stable'},
  transport_digest:registry.transportDigest(f.scope.org_id,f.scope.installation_id,f.profile),review_expires_at:f.scope.consent_expires_at,expires_at:f.scope.consent_expires_at};
 const runtime=registry.reattachmentRuntime(f.scope,f.profile);
 await runtime.request(input,new AbortController().signal);assert.equal(calls,1);
 const {action_consents,...v1}=input;await assert.rejects(runtime.request({...v1,schema_version:'deft.app_connection_reattach_runtime.v1'},new AbortController().signal));assert.equal(calls,1);
});
