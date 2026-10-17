import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HumanActionConfirmSchema, HumanActionPrepareSchema, humanActionDigest,
  sealHumanActionTicket, openHumanActionTicket } from '../src/lib/app-experience-human-action-contract.js';
import type { AppRunKeyProvider } from '../src/lib/app-run-keyrings.js';
import { AppExperienceHumanActionService, type HumanActionAuthorityPort } from '../src/lib/app-experience-human-action-service.js';
import type { AppRunRuntime } from '../src/lib/app-run-runtime.js';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';
import { AppPrivateStateSecrets } from '../src/lib/app-private-state-secrets.js';
const key = Buffer.alloc(32, 31);
const keys: AppRunKeyProvider = { current: () => ({ key_id: 'v1', key: Buffer.from(key) }),
  read: (_, id) => id === 'v1' ? { key_id: id, key: Buffer.from(key) } : null, keyIds: () => ['v1'] };
const input = { recipient: 'synthetic@example.test', body: 'Private exact text' };
const ticket = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID(), session_id: randomUUID(),
  action_key: 'write', runtime_binding_id: randomUUID(), authority_digest: humanActionDigest({ version: 'v1' }),
  input, input_digest: humanActionDigest(input), idempotency_key: 'host:one', expires_at: new Date(Date.now() + 60_000).toISOString() };
test('review context, snapshot, preparation and confirmation explicitly reserve capacity while lookup and policy do not', async () => {
  const stopped = new Error('synthetic authority boundary'), purposes: unknown[] = [];
  const authority: HumanActionAuthorityPort = {
    async withHumanAction(_caller, _session, _action, _use, _signal, _draft, _transaction, purpose) {
      purposes.push(purpose); throw stopped;
    },
  };
  const service = new AppExperienceHumanActionService(authority, { keys } as AppRunRuntime);
  const caller = { org_id: ticket.org_id, user_id: ticket.user_id, sid: ticket.sid };
  const draft_ref = { draft_state_key: 'drafts', draft_id: randomUUID(), expected_revision: 1 };
  const calls = [
    () => service.context(caller, ticket.session_id, ticket.action_key),
    () => service.snapshot(caller, ticket.session_id, ticket.action_key, { input, draft_ref }),
    () => service.prepare(caller, ticket.session_id, ticket.action_key, { input, idempotency_key: 'host:one' }),
    () => service.confirm(caller, ticket.session_id, { ticket: sealHumanActionTicket(keys, ticket), expected_input_digest: ticket.input_digest }),
    () => service.lookup(caller, ticket.session_id, ticket.action_key, randomUUID()),
    () => service.agentPolicy(caller, ticket.session_id, ticket.action_key),
  ];
  for (const call of calls) await assert.rejects(async () => call(), error => error === stopped);
  assert.deepEqual(purposes, ['human_action_preparation', 'human_action_preparation', 'human_action_preparation',
    'human_action_confirmation', undefined, undefined]);
});
test('sealed ticket roundtrip hides exact private input and retains authority', () => {
  const sealed = sealHumanActionTicket(keys, ticket);
  assert(!sealed.includes(input.body)); assert(!sealed.includes(input.recipient));
  assert.deepEqual(openHumanActionTicket(keys, sealed), ticket);
});

test('draft-bound tickets seal the exact private reference and require its paired digest', () => {
  const draft_ref = { draft_state_key: 'drafts', draft_id: randomUUID(), expected_revision: 7 };
  const bound = { ...ticket, idempotency_key: draft_ref.draft_id, draft_ref, draft_digest: humanActionDigest({ body: 'Saved exact text' }) };
  assert.deepEqual(openHumanActionTicket(keys, sealHumanActionTicket(keys, bound)), bound);
  assert.throws(() => sealHumanActionTicket(keys, { ...ticket, draft_ref }));
  assert.throws(() => sealHumanActionTicket(keys, { ...ticket, draft_digest: bound.draft_digest }));
  assert.throws(() => HumanActionPrepareSchema.parse({ input, idempotency_key: draft_ref.draft_id, draft_ref: { ...draft_ref, expected_revision: 0 } }));
  assert.throws(() => HumanActionPrepareSchema.parse({ input, idempotency_key: draft_ref.draft_id, draft_ref: { ...draft_ref, owner_user_id: randomUUID() } }));
});
test('ticket tampering and foreign encryption keys fail closed', () => {
  const sealed = sealHumanActionTicket(keys, ticket);
  assert.throws(() => openHumanActionTicket(keys, sealed.slice(0, -1) + (sealed.endsWith('A') ? 'B' : 'A')));
  const foreign = { ...keys, read: () => ({ key_id: 'v1', key: Buffer.alloc(32, 23) }) };
  assert.throws(() => openHumanActionTicket(foreign, sealed));
});
test('confirm rejects replacement input, actor and fabricated click facts', () => {
  const request = { ticket: 'opaque', expected_input_digest: ticket.input_digest };
  assert(HumanActionConfirmSchema.safeParse(request).success);
  for (const extra of [{ input }, { initiating_actor: 'human' }, { trusted_click: true }, { policy: 'never' }]) {
    assert(!HumanActionConfirmSchema.safeParse({ ...request, ...extra }).success);
  }
});
test('prepare is closed scalar input; bounded and stable exact digest', () => {
  assert(HumanActionPrepareSchema.safeParse({ input, idempotency_key: 'host:one' }).success);
  assert(!HumanActionPrepareSchema.safeParse({ input: { body: ['unsafe'] }, idempotency_key: 'host:one' }).success);
  assert.notEqual(humanActionDigest(input), humanActionDigest({ ...input, body: 'changed' }));
  assert.equal(humanActionDigest(input), humanActionDigest({ body: input.body, recipient: input.recipient }));
});
test('foreign identity, expired ticket and substituted digest are rejected before authority work', async () => {
  let calls = 0;
  const authority = { async withHumanAction<T>(): Promise<T> { calls++; throw Error('unexpected authority access'); } };
  const service = new AppExperienceHumanActionService(authority, { keys } as AppRunRuntime);
  const caller = { org_id: ticket.org_id, user_id: ticket.user_id, sid: ticket.sid };
  const request = { ticket: sealHumanActionTicket(keys, ticket), expected_input_digest: ticket.input_digest };
  await assert.rejects(async () => service.confirm({ ...caller, sid: randomUUID() }, ticket.session_id, request));
  await assert.rejects(async () => service.confirm({ ...caller, org_id: randomUUID() }, ticket.session_id, request));
  await assert.rejects(async () => service.confirm(caller, ticket.session_id, { ...request, expected_input_digest: humanActionDigest('substitution') }));
  await assert.rejects(async () => service.confirm(caller, ticket.session_id, { ...request,
    ticket: sealHumanActionTicket(keys, { ...ticket, expires_at: new Date(0).toISOString() }) }));
  assert.equal(calls, 0);
});


test('ticket final fence includes database skew and elapsed final authority wait', async () => {
  const {assertHumanActionTicketDeadline}=await import('../src/lib/app-experience-human-action-contract.js');
  const deadline=new Date(1000).toISOString();
  assert.doesNotThrow(()=>assertHumanActionTicketDeadline(deadline,100,900,99));
  assert.throws(()=>assertHumanActionTicketDeadline(deadline,100,900,100));
  assert.throws(()=>assertHumanActionTicketDeadline(deadline,1000,100,0));
});

function delayedDatabaseSampleFixture() {
  const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
  const sessionId = randomUUID(), installationId = randomUUID(), versionId = randomUUID();
  const grantId = randomUUID(), bindingId = randomUUID(), exposureId = randomUUID();
  const hostNow = 1_000, databaseNow = 2_000, expiresAt = new Date(databaseNow + 50);
  let delaySample = false, released = false;
  const tx = {
    async execute() {
      // The database sampled before its response was held. The host clock is
      // behind that sample, so only dispatch-to-response elapsed time fences it.
      if (delaySample) await new Promise<void>(resolve => setTimeout(resolve, 100));
      return { rows: [{ now: new Date(databaseNow), now_ms: String(databaseNow) }] };
    },
  } as unknown as AppRunTransaction;
  const authority: HumanActionAuthorityPort = {
    async withHumanAction(_caller, _session, _action, use) {
      let retainedCheck: (() => void) | undefined;
      const final = async (_executor: AppRunTransaction, check?: () => void) => {
        if (check) retainedCheck = check;
        retainedCheck?.();
      };
      const output = await use(tx, {
        session: { id: sessionId, app_installation_id: installationId, app_version_id: versionId,
          grant_snapshot_id: grantId, artifact_digest: humanActionDigest('artifact'), expires_at: expiresAt },
        runtime_binding_id: bindingId, action_label: 'Write', current_authority_expires_at: expiresAt,
        authorization_identity: { consent_grant_id: null, consent_epoch: null, exposure_id: exposureId, exposure_epoch: 1 },
      }, final);
      await final(tx);
      return output;
    },
  };
  const runtime = {
    keys,
    liveAuthorization: { captureReviewedRuntimeInTransaction: async () => ({
      protocol_version: '7',
      binding: { app_installation_id: installationId, app_version_id: versionId, grant_snapshot_id: grantId },
      action: { input_schema: { type: 'object', properties: { body: { type: 'string', maxLength: 100 } },
        required: ['body'], additionalProperties: false }, contract_digest: humanActionDigest('contract') },
      authorization_snapshot: {}, provider_snapshot_digest: humanActionDigest('provider'),
      installation_lifecycle_epoch: 1, installation_grant_epoch: 1,
    }) },
    service: {
      async submitReviewedRuntime(_caller: unknown, _input: unknown, _parent: unknown,
        guard: (executor: AppRunTransaction) => Promise<void>) {
        await guard(tx);
        released = true;
        throw new Error('Expired submission crossed the final guard');
      },
    },
  } as unknown as AppRunRuntime;
  const service = new AppExperienceHumanActionService(authority, runtime, () => new Date(hostNow));
  return { caller, sessionId, service, request: { input: { body: 'Saved exact text' }, idempotency_key: 'host:one' },
    delay: () => { delaySample = true; }, released: () => released };
}

const staleAuthorization = (error: unknown) => error instanceof Error && 'code' in error
  && error.code === 'APP_RUN_AUTHORIZATION_STALE';
test('native source facts are immutable from host prepare through confirm and retained under the exact Run input',async()=>{
 const caller={org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID()},sessionId=randomUUID(),installationId=randomUUID(),versionId=randomUUID(),grantId=randomUUID(),bindingId=randomUUID(),resourceId=randomUUID(),recordId=randomUUID(),runId=randomUUID(),exposureId=randomUUID(),expires=new Date(Date.now()+60000);
 let label='Named native message',submitted=0,retained:any;
 const context={session:{id:sessionId,app_installation_id:installationId,app_version_id:versionId,grant_snapshot_id:grantId,artifact_digest:humanActionDigest('artifact'),expires_at:expires},runtime_binding_id:bindingId,action_label:'Triage',current_authority_expires_at:expires,authorization_identity:{consent_grant_id:null,consent_epoch:null,exposure_id:exposureId,exposure_epoch:1},resolveActionResources:async()=>({record_ids:[{record_id:recordId,resource_key:'inbox',resource_binding_id:resourceId,revision:'native-1',label,data:{subject:label},provider_source:{message_id:'private-native'}}]})};
 const tx={execute:async()=>({rows:[{now:new Date(),now_ms:String(Date.now()),owner_user_id:caller.user_id,consent_grant_id:null,consent_epoch:null,exposure_id:exposureId,exposure_epoch:1,snapshot_id:null,snapshot_digest:null}]}),select:()=>({from:()=>({where:()=>({limit:async()=>[{id:'approval'}]})})})} as unknown as AppRunTransaction;
 const authority:HumanActionAuthorityPort={withHumanAction:async(_caller,_session,_action,use)=>use(tx,context,async(_tx,guard)=>{guard?.();})};
 const schema={type:'object',properties:{record_ids:{type:'string',format:'resource_record_list',resourceKey:'inbox',maxItems:25,maxLength:925}},required:['record_ids'],additionalProperties:false};
 const run={id:runId,state:'pending',execution_release_kind:'approved',input_expires_at:expires};
 const runtime={keys,liveAuthorization:{captureReviewedRuntimeInTransaction:async()=>({protocol_version:'7',binding:{app_installation_id:installationId,app_version_id:versionId,grant_snapshot_id:grantId},action:{input_schema:schema,contract_digest:humanActionDigest('contract')},authorization_snapshot:{},provider_snapshot_digest:humanActionDigest('provider'),installation_lifecycle_epoch:1,installation_grant_epoch:1})},service:{submitReviewedRuntime:async(_caller:any,_input:any,_parent:any,guard:any)=>{await guard(tx);submitted++;return run;}},secretRepository:{retainActionResources:async(_tx:any,value:any)=>{retained=value;}},approvalResolver:{approveInTransaction:async()=>({status:'approved'})},repository:{lockRun:async()=>run}} as unknown as AppRunRuntime;
 const service=new AppExperienceHumanActionService(authority,runtime),prepared=await service.prepare(caller,sessionId,'triage',{input:{record_ids:recordId},idempotency_key:randomUUID()}),confirm={ticket:prepared.ticket,expected_input_digest:prepared.input_digest};
 label='Changed source';await assert.rejects(service.confirm(caller,sessionId,confirm),staleAuthorization);assert.equal(submitted,0);
 label='Named native message';await service.confirm(caller,sessionId,confirm);assert.equal(submitted,1);assert.equal(retained.run_id,runId);assert.equal(retained.value.input_digest,prepared.input_digest);assert.equal(retained.value.resources.record_ids[0].record_id,recordId);assert.equal(retained.value.owner_id,caller.user_id);assert.equal(retained.value.runtime_binding_id,bindingId);
});

test('prepare denies a delayed database sample after ticket expiry with the host clock behind', async () => {
  const fixture = delayedDatabaseSampleFixture();
  fixture.delay();
  await assert.rejects(fixture.service.prepare(fixture.caller, fixture.sessionId, 'write', fixture.request), staleAuthorization);
});

test('confirm denies a delayed database sample before a reviewed operation can be released', async () => {
  const fixture = delayedDatabaseSampleFixture();
  const prepared = await fixture.service.prepare(fixture.caller, fixture.sessionId, 'write', fixture.request);
  fixture.delay();
  await assert.rejects(fixture.service.confirm(fixture.caller, fixture.sessionId, {
    ticket: prepared.ticket, expected_input_digest: prepared.input_digest,
  }), staleAuthorization);
  assert.equal(fixture.released(), false);
});

test('empty retained idempotency candidates cannot broaden the metadata lookup', async()=>{
  let selects=0;
  const authority={withHumanAction:async(_caller:unknown,_session:string,_action:string,use:any)=>use(
    {select:()=>{selects++;throw Error('unexpected unbounded select');}},
    {session:{app_installation_id:'install',app_version_id:'version',grant_snapshot_id:'grant'}},async()=>{})};
  const runtime={liveAuthorization:{captureReviewedRuntimeInTransaction:async()=>({protocol_version:'7',
    binding:{app_installation_id:'install',app_version_id:'version',grant_snapshot_id:'grant'}})},
    service:{retainedIdempotencyCandidates:()=>[]}} as unknown as AppRunRuntime;
  await assert.rejects(new AppExperienceHumanActionService(authority,runtime).lookup(
    {org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID()},randomUUID(),'action',randomUUID()));
  assert.equal(selects,0);
});

test('snapshot tickets require exact explicit confirmation and never accept a scalar downgrade', async () => {
  const draft_ref = { draft_state_key: 'drafts', draft_id: randomUUID(), expected_revision: 3 };
  const snapshot_ref = { snapshot_id: randomUUID(), digest: 'a'.repeat(64) };
  const bound = { ...ticket, draft_ref, snapshot_ref, idempotency_key: draft_ref.draft_id, draft_digest: humanActionDigest(input) };
  assert.deepEqual(openHumanActionTicket(keys, sealHumanActionTicket(keys, bound)), bound);
  assert.equal(HumanActionPrepareSchema.safeParse({ input, idempotency_key: 'one', snapshot_ref }).success, false);
  let calls = 0;
  const service = new AppExperienceHumanActionService({ withHumanAction: async () => { calls++; throw Error('unexpected authority'); } }, { keys } as AppRunRuntime);
  const caller = { org_id: ticket.org_id, user_id: ticket.user_id, sid: ticket.sid };
  const request = { ticket: sealHumanActionTicket(keys, bound), expected_input_digest: bound.input_digest };
  for (const digest of [undefined, 'b'.repeat(64)]) await assert.rejects(async () => service.confirm(caller, ticket.session_id,
    { ...request, ...(digest ? { expected_snapshot_digest: digest } : {}) }), staleAuthorization);
  await assert.rejects(async () => service.confirm(caller, ticket.session_id, { ticket: sealHumanActionTicket(keys, ticket),
    expected_input_digest: ticket.input_digest, expected_snapshot_digest: snapshot_ref.digest }), staleAuthorization);
  assert.equal(calls, 0);
});

test('current payload policy rejects omitted refs and old scalar tickets before submission work', async () => {
  let captures = 0;
  const authority = { async withHumanAction(_caller: unknown, _session: string, _action: string, use: any) {
    return use({}, { action_payload_declaration: { state_key: 'drafts', max_payload_bytes: 4194304 } }, async () => {});
  } } as HumanActionAuthorityPort;
  const runtime = { keys, liveAuthorization: { captureReviewedRuntimeInTransaction: async () => { captures++; throw Error('unexpected capture'); } } } as unknown as AppRunRuntime;
  const service = new AppExperienceHumanActionService(authority, runtime);
  const caller = { org_id: ticket.org_id, user_id: ticket.user_id, sid: ticket.sid };
  await assert.rejects(service.prepare(caller, ticket.session_id, 'write', { input, idempotency_key: 'one' }), staleAuthorization);
  const draft_ref = { draft_state_key: 'other_drafts', draft_id: randomUUID(), expected_revision: 1 };
  await assert.rejects(service.prepare(caller, ticket.session_id, 'write', { input, idempotency_key: draft_ref.draft_id,
    draft_ref, snapshot_ref: { snapshot_id: randomUUID(), digest: 'a'.repeat(64) } }), staleAuthorization);
  await assert.rejects(service.confirm(caller, ticket.session_id, { ticket: sealHumanActionTicket(keys, ticket),
    expected_input_digest: ticket.input_digest }), staleAuthorization);
  assert.equal(captures, 0);
});

test('file-free legacy draft remains compatible but prepare and confirm cannot silently discard attached files', async () => {
  const now = 1000, expires = new Date(61000), caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
  const sessionId = randomUUID(), installationId = randomUUID(), versionId = randomUUID(), grantId = randomUUID(), bindingId = randomUUID();
  const draft_ref = { draft_state_key: 'drafts', draft_id: randomUUID(), expected_revision: 3 };
  const schema = { type: 'object' as const, properties: { body: { type: 'string' as const, maxLength: 100 } }, required: ['body'], additionalProperties: false as const };
  const declaration = { key: 'drafts', label: 'Drafts', schema, max_record_bytes: 1024, max_records: 8, max_total_bytes: 8192, retention_days: 1,
    files: { max_file_bytes: 2097152, max_files_per_record: 1, max_total_bytes_per_record: 2097152, allowed_media_types: ['application/pdf' as const] } };
  const artifact_digest = humanActionDigest('artifact'), declaration_digest = humanActionDigest(declaration), value = { body: 'Saved exact text' };
  const row = { revision: 3, deleted_at: null, artifact_digest, declaration_digest, expires_at: expires,
    resource_target_key: 'primary', updated_at: new Date(now), body: new AppPrivateStateSecrets(keys).seal({ org_id: caller.org_id,
      owner_user_id: caller.user_id, installation_id: installationId, state_key: 'drafts', record_id: draft_ref.draft_id,
      revision: 3, artifact_digest, declaration_digest }, value) };
  const tx = { execute: async () => ({ rows: [{ now_ms: String(now) }] }), select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [row] }) }) }) }) } as unknown as AppRunTransaction;
  const authority: HumanActionAuthorityPort = { async withHumanAction(_caller, _session, _action, use) {
    return use(tx, { session: { id: sessionId, app_installation_id: installationId, app_version_id: versionId,
      grant_snapshot_id: grantId, artifact_digest, expires_at: expires }, draft_declaration: declaration,
      runtime_binding_id: bindingId, action_label: 'Reply', current_authority_expires_at: expires,
      authorization_identity: { consent_grant_id: null, consent_epoch: null, exposure_id: randomUUID(), exposure_epoch: 1 } },
      async (_tx, check) => { check?.(); }); } };
  const identity = { consent_grant_id: null, consent_epoch: null, exposure_id: randomUUID(), exposure_epoch: 1 };
  // Keep the reviewed authorization identity stable across prepare/confirm.
  const stableAuthority: HumanActionAuthorityPort = { withHumanAction: (c, s, a, use, signal, state) => authority.withHumanAction(c, s, a,
    (executor, current, final) => use(executor, { ...current, authorization_identity: identity }, final), signal, state) };
  const runtime = { keys, liveAuthorization: { captureReviewedRuntimeInTransaction: async () => ({ protocol_version: '7',
    binding: { app_installation_id: installationId, app_version_id: versionId, grant_snapshot_id: grantId },
    action: { input_schema: schema, contract_digest: humanActionDigest('contract') }, authorization_snapshot: {},
    provider_snapshot_digest: humanActionDigest('provider'), installation_lifecycle_epoch: 1, installation_grant_epoch: 1 }) } } as unknown as AppRunRuntime;
  let attached = false, reads = 0;
  const custody = { loadPayload: async () => { throw Error('unexpected payload'); }, resolveDraftFiles: async () => {
    reads++; return attached ? [{ file_id: randomUUID() }] : [];
  } } as unknown as NonNullable<ConstructorParameters<typeof AppExperienceHumanActionService>[4]>;
  const service = new AppExperienceHumanActionService(stableAuthority, runtime, () => new Date(now), undefined, custody);
  const request = { input: value, draft_ref, idempotency_key: draft_ref.draft_id };
  const prepared = await service.prepare(caller, sessionId, 'reply', request);
  assert.equal('snapshot_ref' in prepared, false);
  attached = true;
  await assert.rejects(service.prepare(caller, sessionId, 'reply', request), staleAuthorization);
  await assert.rejects(async () => service.confirm(caller, sessionId, { ticket: prepared.ticket, expected_input_digest: prepared.input_digest }), staleAuthorization);
  assert.equal(reads, 3);
});
