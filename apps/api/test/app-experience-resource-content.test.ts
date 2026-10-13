import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AppExperienceHumanActionService, type HumanActionAuthorityPort } from '../src/lib/app-experience-human-action-service.js';
import { AppRunError } from '../src/lib/app-run-errors.js';
import type { AppRunRuntime } from '../src/lib/app-run-runtime.js';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';
import { AppError } from '../src/lib/app-errors.js';
import { AppConnectionRegistry } from '../src/lib/app-connection-registry.js';
import type { AppConnectionAdapter, AppConnectionProjection } from '../src/lib/app-connection-contract.js';
import { AppExperienceResourceContentService, ExperienceResourceContentRequestSchema } from '../src/lib/app-experience-resource-content.js';

const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() }, sessionId = randomUUID();
const pins = { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: randomUUID(), app_version_id: randomUUID(),
  grant_snapshot_id: randomUUID(), target_key: 'personal', resource_key: 'inbox', resource_binding_id: randomUUID(), action_key: null, action_binding_id: null };
const recordId = randomUUID();
const document = { format: 'plain' as const, content: 'Private body', truncated: false };
const closed = (error: unknown) => error instanceof AppError && error.code === 'APP_ACTION_UNAVAILABLE'
  && !error.message.includes('Private body') && !error.message.includes('provider-secret');
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const state = { time: 1000, live: true, readOne: true, sourceReads: 0, setupReads: 0,
    reviewed: new Set(['read_document']),
    source: { installation_id: pins.installation_id, target_key: pins.target_key, resource_binding_id: pins.resource_binding_id,
      exposure_id: randomUUID(), exposure_epoch: 1, record: { record_id: recordId, revision: 'current-1', label: 'Private message',
        data: { id: 'host-retained-logical-id', subject: 'Private message' } } },
    projection: { ...pins, purpose: 'read_document', web_session_id: caller.sid, experience_session_id: sessionId,
      runtime_registration_id: randomUUID(), descriptor_digest: 'sha256:' + '1'.repeat(64), allowed_operations: ['list_summary', 'read_one'],
      content_policy: { document: { max_characters: 16384 } },
      lifecycle_epoch: 1, grant_epoch: 1, runtime_epoch: 1, checked_at: 1000, expires_at: 61_000 } as { -readonly [K in keyof AppConnectionProjection]: AppConnectionProjection[K] },
    inputs: [] as Parameters<NonNullable<AppConnectionAdapter['readResource']>>[0][],
    handle: (async () => structuredClone(document)) as NonNullable<AppConnectionAdapter['readResource']>,
  };
  const authority: ConstructorParameters<typeof AppExperienceResourceContentService>[0] = {
    async sourceRecord(actualCaller, actualSession, key, id) {
      state.sourceReads++;
      if (!state.live || actualCaller.org_id !== caller.org_id || actualCaller.user_id !== caller.user_id || actualCaller.sid !== caller.sid
        || actualSession !== sessionId || key !== pins.resource_key || id !== recordId) throw new AppError('Source unavailable', 'APP_ACTION_UNAVAILABLE', 409);
      return structuredClone(state.source);
    },
    async connectionSetup(actualCaller, actualSession, actualPins, _signal, purpose) {
      state.setupReads++;
      assert.deepEqual(actualCaller, caller); assert.equal(actualSession, sessionId); assert.deepEqual(actualPins, pins);
      if (!state.live || !state.reviewed.has(purpose!) || !state.readOne) throw new AppError('Read authority unavailable', 'APP_ACTION_UNAVAILABLE', 409);
      return { ...state.projection, purpose: purpose! };
    },
  };
  const adapter: AppConnectionAdapter = { handle: async () => { assert.fail('Read cannot invoke connection/send handler'); },
    async readResource(input, context) { state.inputs.push(input); return state.handle(input, context); } };
  const registry = new AppConnectionRegistry([{ pins, adapter }]);
  const service = new AppExperienceResourceContentService(authority, async () => registry, () => state.time);
  const read = (operation: 'read_document' = 'read_document', signal?: AbortSignal) => service.read(caller, sessionId, 'inbox', { operation, record_id: recordId }, signal);
  return { state, authority, registry, service, read };
}

test('content requests accept only a reviewed operation and a host record UUID', () => {
  const valid = { operation: 'read_document', record_id: recordId };
  assert.ok(ExperienceResourceContentRequestSchema.safeParse(valid).success);
  for (const key of ['owner_user_id', 'org_id', 'target_key', 'account_id', 'provider', 'url', 'revision', 'data'])
    assert.equal(ExperienceResourceContentRequestSchema.safeParse({ ...valid, [key]: 'attacker' }).success, false);
  assert.ok(ExperienceResourceContentRequestSchema.safeParse({...valid,operation:'read_source'}).success);
  for (const operation of ['search', 'send', 'connect', 'read_one'])
    assert.equal(ExperienceResourceContentRequestSchema.safeParse({ ...valid, operation }).success, false);
  assert.equal(ExperienceResourceContentRequestSchema.safeParse({ ...valid, record_id: 'provider-native-id' }).success, false);
});
test('HTML disclosure requires reviewed format and a bounded plain fallback while preserving legacy plain behavior',async()=>{
 const f=fixture();f.state.handle=async()=>({format:'html',content:'<b>Body</b><img src="https://remote.test/pixel">',plain_text:'Body',truncated:false});
 await assert.rejects(f.read(),closed);f.state.projection.content_policy!.document.formats=['plain','html'];
 assert.equal((await f.read()).document?.format,'html');
 f.state.handle=async()=>({format:'html',content:'Body',truncated:false});await assert.rejects(f.read(),closed);
});
test('named triage options require explicit reviewed policy, exact source and current read authority',async()=>{
 const f=fixture(),options={schema_version:'deft.experience_triage_options.v1',account_id:'current-account',provider:'gmail',destinations:[{id:'INBOX',label:'Inbox',kind:'folder'}],labels:[{id:'Label_1',label:'Review queue'}],complete:true,labels_supported:true};
 const adapter:AppConnectionAdapter={handle:async()=>new Response(),readTriageOptions:async()=>options};
 const service=new AppExperienceResourceContentService(f.authority,async()=>new AppConnectionRegistry([{pins,adapter}]),()=>f.state.time),read=()=>service.read(caller,sessionId,'inbox',{operation:'triage_options',record_id:recordId});
 f.state.reviewed.add('triage_options');await assert.rejects(read(),closed);f.state.projection.content_policy!.triage_options={max_options:100};assert.deepEqual((await read()).options,options);
 adapter.readTriageOptions=async()=>{f.state.live=false;return options;};await assert.rejects(read(),closed);
});
test('governed original source checks exact policy and zeroes withheld bytes after authority loss',async()=>{
 const f=fixture(),original=Buffer.from('From: original@example.test\r\n\r\nActual source.'),bytes=new Uint8Array(original);
 f.state.reviewed.add('read_source');f.state.projection.content_policy!.source={media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608};
 const adapter:AppConnectionAdapter={handle:async()=>new Response(),readSource:async()=>({bytes,media_type:'message/rfc822',filename:'message.eml'})};
 const service=new AppExperienceResourceContentService(f.authority,async()=>new AppConnectionRegistry([{pins,adapter}]),()=>f.state.time);
 const output=await service.read(caller,sessionId,'inbox',{operation:'read_source',record_id:recordId});assert.equal(output.kind,'source');if(output.kind==='source')assert.deepEqual(Buffer.from(output.bytes),original);
 adapter.readSource=async()=>{f.state.live=false;return {bytes,media_type:'message/rfc822',filename:'message.eml'};};
 await assert.rejects(service.read(caller,sessionId,'inbox',{operation:'read_source',record_id:recordId}),closed);assert.ok(bytes.every(value=>value===0));
});

test('plain read uses exact retained source and preserves generic document', async()=>{
 const f=fixture();const output=await f.read();assert.deepEqual(output.document,document);
 assert.equal(output.exposure_id,f.state.source.exposure_id);assert.equal(f.state.inputs.length,1);assert.equal(f.state.sourceReads,2);
 assert.deepEqual(f.state.inputs[0],{operation:'read_document',record:f.state.source.record});
});
test('foreign caller, record and binding cannot invoke adapter', async()=>{
 const f=fixture();
 for(const wrong of [{...caller,org_id:randomUUID()},{...caller,user_id:randomUUID()},{...caller,sid:randomUUID()}])await assert.rejects(f.service.read(wrong,sessionId,'inbox',{operation:'read_document',record_id:recordId}),closed);
 await assert.rejects(f.service.read(caller,sessionId,'inbox',{operation:'read_document',record_id:randomUUID()}),closed);
 f.state.source.record.record_id=randomUUID();await assert.rejects(f.read(),closed);f.state.source.record.record_id=recordId;
 f.state.source.resource_binding_id=randomUUID();await assert.rejects(f.read(),closed);assert.equal(f.state.inputs.length,0);
});
test('changed retained source or authority during read withholds output', async()=>{
 for(const change of [(f:ReturnType<typeof fixture>)=>{f.state.live=false},(f:ReturnType<typeof fixture>)=>{f.state.source.record.revision='changed'},(f:ReturnType<typeof fixture>)=>{f.state.projection.runtime_epoch++},(f:ReturnType<typeof fixture>)=>{f.state.projection.descriptor_digest='changed'},(f:ReturnType<typeof fixture>)=>{f.state.projection.expires_at=1001},(f:ReturnType<typeof fixture>)=>{f.state.projection.content_policy!.document.max_characters=1}]){
  const f=fixture();f.state.handle=async()=>{change(f);return structuredClone(document)};await assert.rejects(f.read(),closed);
 }
});
test('reviewed metadata contract is strict and provider-specific fields have no implicit authority', async()=>{
 const f=fixture();f.state.handle=async()=>({...document,metadata:{subject:'synthetic'}});
 await assert.rejects(f.read(),closed);
 f.state.handle=async(_input,context)=>{context.projection.content_policy!.document.metadata_schema={type:'object',properties:{subject:{type:'string',maxLength:20}},required:['subject'],additionalProperties:false};return {...document,metadata:{subject:'unreviewed'}}};
 await assert.rejects(f.read(),closed);assert.equal(f.state.projection.content_policy!.document.metadata_schema,undefined);
 f.state.handle=async()=>({...document,metadata:{subject:'synthetic'}});
 f.state.projection.content_policy!.document.metadata_schema={type:'object',properties:{subject:{type:'string',maxLength:20}},required:['subject'],additionalProperties:false};
 assert.deepEqual((await f.read()).document.metadata,{subject:'synthetic'});
 f.state.handle=async()=>{throw Error('provider-secret Private body')};await assert.rejects(f.read(),closed);
 for(const result of [{...document,format:'html'},{...document,content:'x'.repeat(16385)},{...document,metadata:{subject:'x'.repeat(21)}},{...document,metadata:{subject:'ok',account_id:'forged'}},{...document,reply_context:{from:'forged'}}]){
  f.state.handle=async()=>result as never;await assert.rejects(f.read(),closed);
 }
});
test('timeout covers held registry, preauthorization, provider and postauthorization', async()=>{
 for(const phase of ['source-pre','registry','pre','provider','post','source-post']){
  const f=fixture(),held=deferred(),original=f.authority.connectionSetup,originalSource=f.authority.sourceRecord;let setup=0,sourceReads=0;
  f.authority.sourceRecord=async(...args)=>{sourceReads++;if(phase==='source-pre'&&sourceReads===1||phase==='source-post'&&sourceReads===2)await held.promise;return originalSource(...args)};
  if(phase==='provider')f.state.handle=async()=>{await held.promise;return structuredClone(document)};
  f.authority.connectionSetup=async(...args)=>{setup++;if(phase==='pre'&&setup===1||phase==='post'&&setup===3)await held.promise;return original(...args)};
  const registry=async()=>{if(phase==='registry')await held.promise;return f.registry};
  const service=new AppExperienceResourceContentService(f.authority,registry,()=>f.state.time,15);
  await assert.rejects(service.read(caller,sessionId,'inbox',{operation:'read_document',record_id:recordId}),closed);held.resolve();
 }
});

test('read purpose, current capability, finite expiry and policy are required before provider I/O',async()=>{
 for(const change of [(f:ReturnType<typeof fixture>)=>{f.state.readOne=false},(f:ReturnType<typeof fixture>)=>{f.state.reviewed.clear()},(f:ReturnType<typeof fixture>)=>{f.state.projection.expires_at=NaN},(f:ReturnType<typeof fixture>)=>{f.state.projection.owner_user_id=randomUUID()},(f:ReturnType<typeof fixture>)=>{f.state.projection.content_policy=undefined}]){
  const f=fixture();change(f);await assert.rejects(f.read(),closed);assert.equal(f.state.inputs.length,0);
 }
});

test('parent nomination requires a host resolver and an exact saved draft before source reads or capture',async()=>{
 const session={id:sessionId,app_installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),artifact_digest:'a'.repeat(64),expires_at:new Date(61000)};
 const schema={type:'object',properties:{parent_record_id:{type:'string',format:'resource_record_list',maxLength:36,maxItems:1,minLength:1,resourceKey:'inbox'}},required:['parent_record_id'],additionalProperties:false};
 let captured=0,resolved=0,draftReads=0;
 const tx={select:()=>{draftReads++;throw Error('Invalid saved draft')}} as unknown as AppRunTransaction;
 const runtime={liveAuthorization:{captureReviewedRuntimeInTransaction:async(_tx:unknown,scope:unknown)=>{assert.deepEqual(scope,{org_id:caller.org_id,user_id:caller.user_id,runtime_binding_id:pins.resource_binding_id});return {protocol_version:'7',binding:{app_installation_id:session.app_installation_id,app_version_id:session.app_version_id,grant_snapshot_id:session.grant_snapshot_id},action:{input_schema:schema}}}}} as unknown as AppRunRuntime;
 for(const resolver of [undefined,async()=>{resolved++;throw new AppRunError('APP_RUN_AUTHORIZATION_STALE')}]){
  const authority:HumanActionAuthorityPort={withHumanAction:async(_c,_s,_a,use)=>use(tx,{session,runtime_binding_id:pins.resource_binding_id,action_label:'Reply',current_authority_expires_at:new Date(61000),authorization_identity:{consent_grant_id:null,consent_epoch:null,exposure_id:randomUUID(),exposure_epoch:1},action_payload_declaration:{state_key:'drafts',max_payload_bytes:65536},...(resolver?{resolveActionResources:resolver}:{})},async()=>{})};
  const capture={capture:async()=>{captured++;throw Error('unexpected capture')}};
  const service=new AppExperienceHumanActionService(authority,runtime,()=>new Date(1000),capture);
  await assert.rejects(service.snapshot(caller,sessionId,'reply',{input:{parent_record_id:recordId},draft_ref:{draft_state_key:'drafts',draft_id:randomUUID(),expected_revision:1}}));
 }
 assert.equal(captured,0);assert.equal(resolved,0);assert.equal(draftReads,0);
});
