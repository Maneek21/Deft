import assert from 'node:assert/strict';
import test from 'node:test';
import {AppDataOperationInputSchema,type AppDataResult,type RecordStoreDeclaration} from '@deft/app-kit/core';
import {appDataSeedSnapshotRequest,assertAppDataSeedSnapshotResult,assertAppDataSeedSnapshotPins,sealAppDataSeedSnapshotExpiry} from '../src/lib/app-data-seed-snapshot.js';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',hash='sha256:'+'a'.repeat(64),date=new Date().toISOString();
const store:RecordStoreDeclaration={schema_version:'deft.app_record_store.v1',key:'records',resource_key:'inbox',runtime_requirement_key:'provider',max_record_bytes:1024,max_files:1,max_file_bytes:10,max_total_file_bytes:10};
const operation=()=>AppDataOperationInputSchema.parse({operation:'connection_metadata',input:{store_key:'records',seed:{operation_key:'record_seed_snapshot',destination_store_key:'records',value:{schema_version:'deft.record_seed_snapshot_request.v1',record_id:id,expected:{account_ref:id,target_key:'primary',data_policy_digest:hash,consent_id:id,consent_digest:hash},value:{body:'Initial'}}}}});
const row=()=>({schema_version:'deft.app_record.v1' as const,store_key:'records',record_id:id,revision:2,content_revision:2,content_digest:hash,status:'draft' as const,value:{body:'Saved'},files:[],created_at:date,updated_at:date});
const result=(record:unknown=null,value:unknown={body:'Quoted'})=>({schema_version:'deft.app_data_result.v1',request_id:id,operation:'connection_metadata',input_digest:hash,outcome:'completed',record_seed_value:{schema_version:'deft.record_seed_snapshot.v1',record_id:id,account_ref:id,record,value}} as AppDataResult);
test('compound metadata opts into record-read consent and validates exact nomination',()=>{
 assert.equal(appDataSeedSnapshotRequest(operation())?.record_id,id);
 const plain=AppDataOperationInputSchema.parse({operation:'connection_metadata',input:{store_key:'records'}});assert.equal(appDataSeedSnapshotRequest(plain),null);
 for(const mode of ['destination','uuid','extra'] as const){const op=operation();if(op.operation!=='connection_metadata'||!op.input.seed)throw Error('fixture');if(mode==='destination')op.input.seed.destination_store_key='other';if(mode==='uuid')op.input.seed.value.record_id='invalid';if(mode==='extra')op.input.seed.value.extra=true;assert.throws(()=>appDataSeedSnapshotRequest(op),Error,mode);}
});
test('compound absent and persisted result retain exact UUID, source, byte and file limits',()=>{
 assert.doesNotThrow(()=>assertAppDataSeedSnapshotResult(operation(),result(), 'inbox',store,id));assert.doesNotThrow(()=>assertAppDataSeedSnapshotResult(operation(),result(row(),null),'inbox',store,id));
 for(const mode of ['account','id','store','source','bytes','file','both','neither','schema','outcome'] as const){let reply=result(row(),null);const snapshot=reply.record_seed_value!,record=snapshot.record as ReturnType<typeof row>;
  if(mode==='account')snapshot.account_ref=other;if(mode==='id')snapshot.record_id=other;if(mode==='store')record.store_key='foreign';if(mode==='source')Object.assign(record,{source_refs:[{resource_key:'foreign',record_id:id,content_digest:hash}]});
  if(mode==='bytes')record.value.body='x'.repeat(2048);if(mode==='file')Object.assign(record,{files:[{file_id:id,filename:'x.txt',media_type:'text/plain',size_bytes:11,sha256:hash,upload_revision:1}]});
  if(mode==='both')snapshot.value={body:'Both'};if(mode==='neither')snapshot.record=null;if(mode==='schema')snapshot.schema_version='unknown';if(mode==='outcome')reply.outcome='not_found';
  assert.throws(()=>assertAppDataSeedSnapshotResult(operation(),reply,'inbox',store,id),Error,mode);
 }
});

test('pre-storage pins must match fresh entry authority and Host seals the final shortest proof deadline',()=>{
 const current={connection:{account_ref:id},scope:{target_key:'primary'},data_policy_digest:hash,consent:{consent_id:id,consent_digest:hash}} as Parameters<typeof assertAppDataSeedSnapshotPins>[1];
 assert.doesNotThrow(()=>assertAppDataSeedSnapshotPins(operation(),current));
 for(const key of ['account_ref','target_key','data_policy_digest','consent_id','consent_digest']){const op=operation();if(op.operation!=='connection_metadata'||!op.input.seed)throw Error('fixture');const expected=op.input.seed.value.expected as Record<string,unknown>;expected[key]=key==='target_key'?'other':key.endsWith('digest')?'sha256:'+'b'.repeat(64):other;assert.throws(()=>assertAppDataSeedSnapshotPins(op,current),Error,key);}
 assert.throws(()=>assertAppDataSeedSnapshotPins(operation(),{...current,consent:null}));
 const reply=result(),now=Date.now();sealAppDataSeedSnapshotExpiry(operation(),reply,now+1000,now+30000);assert.equal(reply.record_seed_value!.expires_at,new Date(now+1000).toISOString());
 const reply2=result();sealAppDataSeedSnapshotExpiry(operation(),reply2,now+60000,now+30000);assert.equal(reply2.record_seed_value!.expires_at,new Date(now+30000).toISOString());
 assert.throws(()=>sealAppDataSeedSnapshotExpiry(operation(),result(),now-1,now+30000));
});

test('compound API retains the Kit opaque account reference contract',()=>{
 const account='provider_opaque_account',op=operation();if(op.operation!=='connection_metadata'||!op.input.seed)throw Error('fixture');
 (op.input.seed.value.expected as Record<string,unknown>).account_ref=account;const reply=result();reply.record_seed_value!.account_ref=account;
 assert.doesNotThrow(()=>assertAppDataSeedSnapshotResult(op,reply,'inbox',store,account));
});
