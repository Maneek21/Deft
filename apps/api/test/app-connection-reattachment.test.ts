import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppConnectionReattachRuntimeRequestSchema, AppConnectionReattachAuthorityResultSchema } from '@deft/app-kit';
import { AppConnectionReattachmentService, connectionReattachmentReceiptDigest,
  type AppConnectionReattachmentPorts } from '../src/lib/app-connection-reattachment-service.js';
import { AppConnectionSessionService, type AppConnectionSessionRecord,
  type AppConnectionSessionAuthority } from '../src/lib/app-connection-session-service.js';

const digest = (letter: string) => 'sha256:' + letter.repeat(64);
function fixture() {
  let now = Date.parse('2026-10-10T00:00:00Z');
  const owner = randomUUID(), org = randomUUID(), installation = randomUUID(), operator = randomUUID();
  const scope = { org_id: org, owner_user_id: owner, installation_id: installation, app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), package_digest: digest('a'), grant_snapshot_digest: digest('b'), lifecycle_epoch: 1,
    grant_epoch: 1, target_key: 'primary', resource_key: 'inbox', resource_binding_id: randomUUID(),
    runtime_registration_id: randomUUID(), operator_user_id: operator, runtime_epoch: 1, profile_digest: digest('c'),
    consent_expires_at: new Date(now + 3_600_000).toISOString() };
  const profile = { schema_version: 'deft.app_connection_profile.v1' as const, key: 'fixture', provider_id: 'fixture',
    operator_user_id: operator, runtime_requirement_key: 'fixture', resource_key: 'inbox', action_keys: [],
    authorization_origin: 'https://provider.example', credential_custody: 'runtime' as const, executable: false as const };
  const source: AppConnectionSessionRecord = { session_id: randomUUID(), revision: 2, scope, profile, state: 'connected',
    callback_state_hash: 'a'.repeat(64), callback_consumed: true, callback_expires_at: new Date(now - 1).toISOString(),
    runtime_session_ref: 'historical_runtime_ref', account: { account_ref: randomUUID(), label: 'fixture@example.test' },
    created_at: new Date(now - 5000).toISOString(), updated_at: new Date(now - 1000).toISOString() };
  const current: AppConnectionSessionAuthority = { scope: { ...scope, app_version_id: randomUUID(), grant_snapshot_id: randomUUID(),
    package_digest: digest('d'), grant_snapshot_digest: digest('e'), lifecycle_epoch: 2, grant_epoch: 2,
    resource_binding_id: randomUUID(), runtime_registration_id: randomUUID() }, profile: structuredClone(profile), expires_at: now + 900_000 };
  const caller = { org_id: org, user_id: owner, sid: randomUUID(), access_expires_at: now + 900_000 };
  const records = new Map<string, AppConnectionSessionRecord>([[source.session_id, structuredClone(source)]]);
  const calls: string[] = []; let blocked = false, transport = digest('f'), mode = 'normal', activationCount = 0;
  let completed: unknown;
  const store: AppConnectionReattachmentPorts['store'] = {
    create: async record => { if (records.has(record.session_id)) return false; records.set(record.session_id, structuredClone(record)); return true; },
    read: async locator => { const record = records.get(locator.session_id); return record && locator.org_id === record.scope.org_id
      && locator.owner_user_id === record.scope.owner_user_id ? structuredClone(record) : null; },
    compareAndSet: async (locator, expected, record) => { if (records.get(locator.session_id)?.revision !== expected) return false;
      records.set(locator.session_id, structuredClone(record)); return true; },
  };
  const ports: AppConnectionReattachmentPorts = { store, currentAuthority: async () => current,
    transportDigest: async () => transport,
    assertNoActiveEffects: async () => { if (blocked) throw new Error('effect blocked'); },
    requestRuntime: async (record, request) => {
      calls.push(request.operation);
      if (request.operation === 'prepare') {
        const reply = { schema_version: request.schema_version, session_id: record.session_id, state: 'eligible',
          account: source.account, custody_generation: 4, custody_digest: digest('a') };
        if (mode === 'prepare-lost') { completed = structuredClone(reply); throw new Error('lost preparation response'); }
        return reply;
      }
      if (request.operation === 'status') return completed ?? { schema_version: request.schema_version, session_id: record.session_id, state: 'indeterminate' };
      activationCount++;
      const reply = { schema_version: request.schema_version, session_id: record.session_id, state: 'connected' as const,
        account: source.account!, runtime_session_ref: 'new_runtime_ref', custody_generation: 5, receipt_digest: '' };
      reply.receipt_digest = connectionReattachmentReceiptDigest(record, reply);
      completed = structuredClone(reply);
      if (mode === 'lost') throw new Error('lost response');
      if (mode === 'generation') reply.custody_generation++;
      if (mode === 'account') reply.account = { account_ref: randomUUID(), label: 'foreign@example.test' };
      return reply;
    } };
  const service = new AppConnectionReattachmentService(ports, () => now);
  const reviewInput = { installation_id: installation, target_key: 'primary', source_session_id: source.session_id, request_id: randomUUID() };
  return { source, current, caller, records, store, ports, calls, service, reviewInput,
    advance: (ms: number) => { now += ms; }, now: () => now,
    block: () => { blocked = true; }, mode: (value: string) => { mode = value; }, transport: (value: string) => { transport = value; },
    activationCount: () => activationCount };
}

test('fresh reviewed reattachment retains account identity and old history; one exact activation', async () => {
  const f = fixture(), before = structuredClone(f.source), review = await f.service.review(f.caller, f.reviewInput);
  assert.equal(review.schema_version, 'deft.app_connection_reattach_review.v1');
  assert.ok('review_digest' in review); assert.equal(review.account?.account_ref, f.source.account!.account_ref);
  assert.equal(JSON.stringify(review).includes('historical_runtime_ref'), false);
  const connected = await f.service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest });
  assert.equal(connected.state, 'connected'); assert.equal(connected.account!.account_ref, f.source.account!.account_ref);
  assert.deepEqual(f.records.get(f.source.session_id), before); assert.equal(f.activationCount(), 1);
  await assert.rejects(f.service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest }));
  assert.equal(f.activationCount(), 1);
});
test('same-current, foreign owner, target and reviewed profile cannot nominate custody', async () => {
  for (const mutation of ['version', 'owner', 'target', 'profile']) {
    const f = fixture();
    if (mutation === 'version') f.current.scope.app_version_id = f.source.scope.app_version_id;
    if (mutation === 'owner') f.source.scope.owner_user_id = randomUUID();
    if (mutation === 'target') f.source.scope.target_key = 'foreign';
    if (mutation === 'profile') f.source.profile.provider_id = 'foreign';
    f.records.set(f.source.session_id, structuredClone(f.source));
    await assert.rejects(f.service.review(f.caller, f.reviewInput)); assert.deepEqual(f.calls, []);
  }
});
test('pending or unknown effect blocks review before transport or new session', async () => {
  const f = fixture(); f.block(); await assert.rejects(f.service.review(f.caller, f.reviewInput));
  assert.equal(f.records.size, 1); assert.deepEqual(f.calls, []);
});
test('effect becoming pending after review blocks activation before runtime CAS', async () => {
  const f = fixture(), review = await f.service.review(f.caller, f.reviewInput); assert.ok('review_digest' in review);
  f.block(); const result = await f.service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest });
  assert.equal(result.state, 'indeterminate'); assert.equal(f.activationCount(), 0);
});
test('lost activation resolves exact journal after review expiry with a renewed current JWT; never replays activation', async () => {
  const f = fixture(), review = await f.service.review(f.caller, f.reviewInput); assert.ok('review_digest' in review);
  f.mode('lost'); const lost = await f.service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest });
  assert.equal(lost.state, 'indeterminate'); f.advance(301_000);
  f.caller.sid = randomUUID(); f.caller.access_expires_at = f.now() + 900_000; f.current.expires_at = f.caller.access_expires_at;
  const recovered = await new AppConnectionReattachmentService(f.ports, f.now).status(f.caller, { session_id: review.session_id });
  assert.equal(recovered.state, 'connected'); assert.deepEqual(f.calls, ['prepare', 'activate', 'status']); assert.equal(f.activationCount(), 1);
});
test('lost preparation and a crashed status check resolve only the prior eligible journal', async () => {
  const f = fixture(); f.mode('prepare-lost');
  const lost = await f.service.review(f.caller, f.reviewInput); assert.equal('state' in lost && lost.state, 'indeterminate');
  const checking = f.records.get(lost.session_id)!; checking.state = 'reattach_checking'; checking.revision++;
  const recovered = await new AppConnectionReattachmentService(f.ports, f.now).status(f.caller, { session_id: lost.session_id });
  assert.ok('review_digest' in recovered); assert.deepEqual(f.calls, ['prepare', 'status']); assert.equal(f.activationCount(), 0);
});
test('expired unactivated preparation resolves terminal without releasing a consumed activation', async () => {
  const f = fixture(); f.mode('prepare-lost');
  const lost = await f.service.review(f.caller, f.reviewInput); f.advance(301_000);
  const resolved = await f.service.status(f.caller, { session_id: lost.session_id });
  assert.equal('state' in resolved && resolved.state, 'not_connected');
  assert.equal(f.records.get(lost.session_id)!.callback_consumed, false); assert.equal(f.activationCount(), 0);
  assert.ok(f.records.get(lost.session_id)!.reattachment!.review);
  const g = fixture(), review = await g.service.review(g.caller, g.reviewInput); assert.ok('review_digest' in review);
  g.block(); const unknown = await g.service.activate(g.caller, { session_id: review.session_id, review_digest: review.review_digest });
  assert.equal(unknown.state, 'indeterminate'); assert.equal(g.records.get(review.session_id)!.callback_consumed, true);
  const service = new AppConnectionReattachmentService({ ...g.ports, requestRuntime: async record => ({
    schema_version: 'deft.app_connection_reattach_runtime.v1', session_id: record.session_id, state: 'eligible',
    account: g.source.account, custody_generation: 4, custody_digest: digest('a') }) }, g.now);
  await assert.rejects(service.status(g.caller, { session_id: review.session_id }));
  assert.equal(g.records.get(review.session_id)!.state, 'indeterminate');
});
test('concurrent activation callers cannot invoke two account moves', async () => {
  const f = fixture(), review = await f.service.review(f.caller, f.reviewInput); assert.ok('review_digest' in review);
  const input = { session_id: review.session_id, review_digest: review.review_digest };
  const results = await Promise.allSettled([f.service.activate(f.caller, input), f.service.activate(f.caller, input)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(f.activationCount(), 1); assert.equal(f.records.get(review.session_id)!.state, 'connected');
});
test('a shortened current authority deadline aborts a stalled transport at the shorter deadline', async () => {
  const f = fixture(), review = await f.service.review(f.caller, f.reviewInput); assert.ok('review_digest' in review);
  let checks = 0, aborted = false;
  const service = new AppConnectionReattachmentService({ ...f.ports,
    currentAuthority: async () => ({ ...f.current, expires_at: ++checks >= 3 ? f.now() + 20 : f.current.expires_at }),
    requestRuntime: async (_record, _input, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }) }, f.now);
  const started = Date.now();
  await assert.rejects(service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest }));
  assert.equal(aborted, true); assert.ok(Date.now() - started < 1000); assert.equal(f.records.get(review.session_id)!.state, 'indeterminate');
});
test('expired current JWT or current resource consent denies status even with a recorded activation', async () => {
  for (const kind of ['jwt', 'resource']) {
    const f = fixture(), review = await f.service.review(f.caller, f.reviewInput); assert.ok('review_digest' in review);
    f.mode('lost'); await f.service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest });
    if (kind === 'jwt') f.caller.access_expires_at = f.now() - 1;
    else f.current.scope.consent_expires_at = new Date(f.now() - 1).toISOString();
    await assert.rejects(f.service.status(f.caller, { session_id: review.session_id })); assert.equal(f.calls.length, 2);
  }
});
test('review expires before activation and digest mismatch cannot reach runtime', async () => {
  const f = fixture(), review = await f.service.review(f.caller, f.reviewInput); assert.ok('review_digest' in review);
  await assert.rejects(f.service.activate(f.caller, { session_id: review.session_id, review_digest: digest('0') }));
  f.advance(301_000); await assert.rejects(f.service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest }));
  assert.deepEqual(f.calls, ['prepare']);
});
test('exact source revision and transport must remain unchanged after review', async () => {
  for (const kind of ['source', 'transport']) {
    const f = fixture(), review = await f.service.review(f.caller, f.reviewInput); assert.ok('review_digest' in review);
    if (kind === 'source') f.records.get(f.source.session_id)!.revision++;
    else f.transport(digest('0'));
    await assert.rejects(f.service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest }));
    assert.equal(f.activationCount(), 0);
  }
});
test('wrong account or advanced generation cannot publish connected', async () => {
  for (const mode of ['account', 'generation']) {
    const f = fixture(), review = await f.service.review(f.caller, f.reviewInput); assert.ok('review_digest' in review); f.mode(mode);
    await assert.rejects(f.service.activate(f.caller, { session_id: review.session_id, review_digest: review.review_digest }));
    assert.equal(f.records.get(review.session_id)!.state, 'indeterminate');
  }
});
test('ordinary OAuth callback never consumes reattachment review', async () => {
  const f = fixture(), review = await f.service.review(f.caller, f.reviewInput);
  const oauth = new AppConnectionSessionService({ ...f.ports, registeredRuntime: async () => { throw new Error('must not run OAuth'); } }, f.now);
  await assert.rejects(oauth.callback(f.caller, { session_id: review.session_id, state: 'a'.repeat(43), outcome: 'denied' }));
  assert.deepEqual(f.calls, ['prepare']);
});
test('wire status resolves after old review expiry; prepare/activate and current consent remain bounded', async () => {
  const f = fixture(), source = f.source;
  const request = { schema_version: 'deft.app_connection_reattach_runtime.v1', session_id: randomUUID(), scope: f.current.scope,
    source: { session_id: source.session_id, session_revision: source.revision, scope: source.scope,
      runtime_session_ref: source.runtime_session_ref, account_ref: source.account!.account_ref }, transport_digest: digest('f'),
    operation: 'status', review: null, review_expires_at: new Date(f.now() - 1).toISOString(), expires_at: new Date(f.now() + 30_000).toISOString() };
  assert.equal(AppConnectionReattachRuntimeRequestSchema.safeParse(request).success, true);
  assert.equal(AppConnectionReattachAuthorityResultSchema.safeParse({ ...request, allowed: true }).success, true);
  assert.equal(AppConnectionReattachRuntimeRequestSchema.safeParse({ ...request, expires_at: '2027-01-01T00:00:00Z' }).success, false);
  assert.equal(AppConnectionReattachRuntimeRequestSchema.safeParse({ ...request, review_expires_at: '2027-01-01T00:00:00Z' }).success, false);
  assert.equal(AppConnectionReattachAuthorityResultSchema.safeParse({ ...request, allowed: true, review_expires_at: '2027-01-01T00:00:00Z' }).success, false);
  const { review: _, ...prepare } = request;
  assert.equal(AppConnectionReattachRuntimeRequestSchema.safeParse({ ...prepare, operation: 'prepare' }).success, false);
});

function v2Fixture() {
  const f=fixture(), actions=(scope:typeof f.source.scope)=>['mirror_drafts','organize_messages','send_message'].map(action_key=>{
    const id=randomUUID();return {action_key,action_binding_id:id,consent_id:id,authority_epoch:scope.runtime_epoch,
      consent_digest:digest('d'),expires_at:scope.consent_expires_at};
  });
  f.source.action_consents=actions(f.source.scope);f.current.action_consents=actions(f.current.scope);
  f.records.set(f.source.session_id,structuredClone(f.source));return f;
}
test('v2 multi-purpose reattachment tolerates cumulative live-check latency without another owner step',async()=>{
 const f=v2Fixture(),source=structuredClone(f.source);
 const service=new AppConnectionReattachmentService({...f.ports,currentAuthority:async()=>{f.advance(10_000);return f.current;}},f.now);
 const review=await service.review(f.caller,f.reviewInput);assert.ok('review_digest' in review);
 const connected=await service.activate(f.caller,{session_id:review.session_id,review_digest:review.review_digest});
 assert.equal('state' in connected&&connected.state,'connected');assert.equal(f.activationCount(),1);
 assert.deepEqual(f.calls,['prepare','activate']);assert.deepEqual(f.records.get(f.source.session_id),source);
 assert.match(f.records.get(review.session_id)!.reattachment!.receipt!.receipt_digest,/^sha256:[a-f0-9]{64}$/);
});
test('a longer reattachment phase never extends finite account or action permission',async()=>{
 for(const bound of ['account','action']){
  const f=v2Fixture(),expiry=new Date(f.now()+35_000).toISOString();
  if(bound==='account')f.current.scope.consent_expires_at=expiry;else f.current.action_consents![0]!.expires_at=expiry;
  const service=new AppConnectionReattachmentService({...f.ports,currentAuthority:async()=>{f.advance(10_000);return f.current;}},f.now);
  await assert.rejects(service.review(f.caller,f.reviewInput));
  assert.equal(f.activationCount(),0);assert.ok([...f.records.values()].every(row=>row.session_id===f.source.session_id||row.state!=='connected'));
 }
});
test('reattachment still rejects a reply outside its bounded phase even with live permission',async()=>{
 const f=v2Fixture();
 const service=new AppConnectionReattachmentService({...f.ports,requestRuntime:async(record,request,signal)=>{
  f.advance(130_000);return f.ports.requestRuntime(record,request,signal);
 }},f.now);
 await assert.rejects(service.review(f.caller,f.reviewInput));assert.equal(f.activationCount(),0);
 assert.equal(f.records.get(f.reviewInput.request_id)!.state,'indeterminate');
});
test('v2 retained custody pins fresh independent purposes and recovers exact lost activation after expiry',async()=>{
 const f=v2Fixture(),before=structuredClone(f.source),review=await f.service.review(f.caller,f.reviewInput);
 assert.ok('review_digest' in review);
 assert.deepEqual(f.records.get(review.session_id)!.action_consents,f.current.action_consents);
 f.mode('lost');assert.equal((await f.service.activate(f.caller,{session_id:review.session_id,review_digest:review.review_digest})).state,'indeterminate');
 f.advance(301000);f.current.action_consents=[];
 const recovered=await f.service.status(f.caller,{session_id:review.session_id});assert.equal('state' in recovered&&recovered.state,'connected');
 assert.equal(f.activationCount(),1);assert.deepEqual(f.records.get(f.source.session_id),before);
 await assert.rejects(f.service.review(f.caller,f.reviewInput));assert.equal(f.records.size,2);
});
test('v2 reattachment denies new purpose, protocol downgrade, revoked fresh consent, and stale source',async()=>{
 for(const change of ['purpose','protocol','consent','source']){
  const f=v2Fixture();
  if(change==='purpose'){f.current.action_consents!.pop();await assert.rejects(f.service.review(f.caller,f.reviewInput));assert.equal(f.records.size,1);continue;}
  if(change==='protocol'){delete f.current.action_consents;await assert.rejects(f.service.review(f.caller,f.reviewInput));assert.equal(f.records.size,1);continue;}
  const review=await f.service.review(f.caller,f.reviewInput);assert.ok('review_digest' in review);
  if(change==='consent')f.current.action_consents![0]!.consent_digest=digest('e');else f.records.get(f.source.session_id)!.revision++;
  await assert.rejects(f.service.activate(f.caller,{session_id:review.session_id,review_digest:review.review_digest}));assert.equal(f.activationCount(),0);
 }
});

function preJournalFixture() {
 const f=v2Fixture();
 const service=new AppConnectionReattachmentService({...f.ports,requestRuntime:async(record,request)=>{
  f.calls.push(request.operation);
  return request.operation==='status'
   ? {schema_version:'deft.app_connection_reattach_runtime.v2',session_id:record.session_id,state:'not_connected',reason:'prepare_not_started'}
   : {schema_version:request.schema_version,session_id:record.session_id,state:'indeterminate'};
 }},f.now);
 return {...f,service};
}
test('v2 exact expired pre-journal original closes without preparing or moving custody',async()=>{
 const f=preJournalFixture(),source=structuredClone(f.source);
 const original=await f.service.review(f.caller,f.reviewInput);assert.equal('state' in original&&original.state,'indeterminate');
 f.advance(301000);
 const closed=await f.service.status(f.caller,{session_id:original.session_id});
 assert.equal('state' in closed&&closed.state,'not_connected');
 const record=f.records.get(original.session_id)!;
 assert.equal(record.callback_consumed,false);assert.equal(record.account,null);assert.equal(record.runtime_session_ref,null);
 assert.equal(record.reattachment!.review,null);assert.equal(record.reattachment!.receipt,null);
 assert.deepEqual(f.records.get(f.source.session_id),source);assert.deepEqual(f.calls,['prepare','status']);assert.equal(f.activationCount(),0);
 await f.service.status(f.caller,{session_id:original.session_id});assert.deepEqual(f.calls,['prepare','status']);
 await assert.rejects(f.service.activate(f.caller,{session_id:original.session_id,review_digest:digest('a')}));
});
test('pre-journal negative cannot close an unexpired review or changed source',async()=>{
 for(const change of ['unexpired','source']){
  const f=preJournalFixture(),original=await f.service.review(f.caller,f.reviewInput);
  if(change==='source'){f.advance(301000);f.records.get(f.source.session_id)!.revision++;}
  await assert.rejects(f.service.status(f.caller,{session_id:original.session_id}));
  assert.notEqual(f.records.get(original.session_id)!.state,'not_connected');assert.equal(f.activationCount(),0);
 }
});
test('pre-journal negative cannot close reviewed or activation-consumed originals',async()=>{
 for(const change of ['review','activation']){
  const f=v2Fixture(),review=await f.service.review(f.caller,f.reviewInput);assert.ok('review_digest' in review);
  if(change==='activation'){f.mode('lost');await f.service.activate(f.caller,{session_id:review.session_id,review_digest:review.review_digest});}
  f.advance(301000);
  const service=new AppConnectionReattachmentService({...f.ports,requestRuntime:async record=>({schema_version:'deft.app_connection_reattach_runtime.v2',session_id:record.session_id,state:'not_connected',reason:'prepare_not_started'})},f.now);
  await assert.rejects(service.status(f.caller,{session_id:review.session_id}));
  assert.notEqual(f.records.get(review.session_id)!.state,'not_connected');
 }
});
test('unactivated status cannot recover eligibility while effects are pending',async()=>{
 const f=v2Fixture();f.mode('prepare-lost');const lost=await f.service.review(f.caller,f.reviewInput);
 f.block();const result=await f.service.status(f.caller,{session_id:lost.session_id});
 assert.equal('state' in result&&result.state,'indeterminate');assert.deepEqual(f.calls,['prepare']);assert.equal(f.activationCount(),0);
});
test('effect arriving during eligible status reply blocks fresh review disclosure',async()=>{
 const f=v2Fixture();f.mode('prepare-lost');const lost=await f.service.review(f.caller,f.reviewInput);
 const service=new AppConnectionReattachmentService({...f.ports,requestRuntime:async(record,request,signal)=>{
  const reply=await f.ports.requestRuntime(record,request,signal);f.block();return reply;
 }},f.now);
 const result=await service.status(f.caller,{session_id:lost.session_id});
 assert.equal('state' in result&&result.state,'indeterminate');assert.equal(f.activationCount(),0);
});
