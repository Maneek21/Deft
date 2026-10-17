import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AppDataResourceActionService} from '../src/lib/app-data-resource-action-service.js';
import {AppExperienceHumanActionService} from '../src/lib/app-experience-human-action-service.js';
import {appDataConnectionActionSelection,appDataRuntimeConnectionActionSelection} from '../src/lib/app-data-read-authority.js';
import {AppDataService} from '../src/lib/app-data-service.js';
import {appDataDigest} from '../src/lib/app-data-authority.js';
const hash='sha256:'+'a'.repeat(64),session=randomUUID(),record=randomUUID(),account=randomUUID();
const sources=[{resource_key:'inbox',record_id:record,content_digest:hash}];
const caller={org_id:randomUUID(),user_id:randomUUID(),sid:randomUUID(),access_expires_at:Date.now()+300000};
function fixture(revokeAt=Infinity,alter=false){
 let guards=0,tickets=0,plans=0;const selections:unknown[]=[];
 const current={scope:{resource_key:'inbox'},store:{key:'drafts'},connection:{session_id:session,session_revision:1,account_ref:account},
  consent:{consent_id:randomUUID(),consent_digest:hash},expires_at:Date.now()+60000};
 const snapshot=randomUUID(),prepared={schema_version:'deft.app_prepared_resource_action.v1',snapshot_id:snapshot,snapshot_digest:hash,
  account_ref:account,action_key:'organize_messages',operation_key:'archive',resource_key:'inbox',source_manifest_digest:appDataDigest(sources),item_count:1,
  input:{snapshot_id:snapshot,account_ref:account,operation_key:'archive',source_manifest_digest:appDataDigest(sources),item_count:1,plan_digest:hash},
  preview:{title:'Archive one item',count:1,items:[{record_id:alter?randomUUID():record,label:'Reviewed item',before:'Inbox',after:'Archive'}]},
  expires_at:new Date(current.expires_at).toISOString()};
 const data={caller,current:async(...args:any[])=>{selections.push(appDataConnectionActionSelection(args[3]));return current;},prepareResource:async()=>{plans++;return {prepared,authority:current};}};
 const human={prepareReviewedResource:async(_caller:any,_experience:any,_action:any,input:any)=>{
  tickets++;assert.equal(Object.keys(input.input).length,13);assert.equal(input.input.prepared_digest,hash);
  return {ticket:'sealed',input_digest:appDataDigest(input.input),expires_at:prepared.expires_at};}};
 class Broker extends AppDataResourceActionService{
  protected override async assertTarget(){if(++guards>=revokeAt)throw Object.assign(Error('revoked'),{code:'APP_ACCESS_DENIED'});}
 }
 const broker=new Broker(data as any,human as any,{} as any,{} as any);
 return {broker,counts:()=>({guards,tickets,plans,selections}),request:{connection_session_id:session,store_key:'drafts',resource_key:'inbox',
  operation_key:'archive',sources,idempotency_key:randomUUID()}};
}
test('trusted broker seals13 pins and authoritative preview only after current independent action checks',async()=>{
 const f=fixture(),review=await f.broker.prepareResource(randomUUID(),'target','organize_messages',f.request);
 assert.equal(review.prepared.preview.items[0]!.record_id,record);assert.equal(review.input.account_ref,account);
 assert.equal(review.input.item_count,1);assert.equal(f.counts().guards,3);assert.equal(f.counts().tickets,1);
});
test('action revocation before or after planning prevents a review ticket; foreign source plan denies',async()=>{
 for(const revoke of [1,2]){const f=fixture(revoke);await assert.rejects(f.broker.prepareResource(randomUUID(),'target','organize_messages',f.request),{code:'APP_ACCESS_DENIED'});
  assert.equal(f.counts().tickets,0);assert.equal(f.counts().plans,revoke===1?0:1);}
 const f=fixture(Infinity,true);await assert.rejects(f.broker.prepareResource(randomUUID(),'target','organize_messages',f.request),{code:'APP_ACCESS_DENIED'});
 assert.equal(f.counts().tickets,0);
});
test('ordinary human scalar preparation cannot nominate either trusted plan marker or interchange brokers',async()=>{
 const experience=randomUUID(),installation=randomUUID(),version=randomUUID(),grant=randomUUID();
 let progressed=0;
 const authority={withHumanAction:async(_caller:any,_session:any,_action:any,use:any)=>use({},
  {session:{id:experience,app_installation_id:installation,app_version_id:version,grant_snapshot_id:grant},runtime_binding_id:randomUUID()},async()=>{progressed++;})};
 for(const marker of ['record_action_version','resource_action_version']){
  const runtime={liveAuthorization:{captureReviewedRuntimeInTransaction:async()=>({protocol_version:'7',binding:{app_installation_id:installation,
    app_version_id:version,grant_snapshot_id:grant},action:{input_schema:{type:'object',properties:{[marker]:{type:'string',maxLength:64}},required:[marker],additionalProperties:false}}})}};
  const human=new AppExperienceHumanActionService(authority as any,runtime as any);
  const input={[marker]:marker==='record_action_version'?'deft.app_prepared_record_action.v1':'deft.app_prepared_resource_action.v1'};
  await assert.rejects(human.prepare(caller,experience,'organize_messages',{input,idempotency_key:randomUUID()}),{code:'APP_RUN_AUTHORIZATION_STALE'});
  const wrong=marker==='record_action_version'?human.prepareReviewedResource.bind(human):human.prepareReviewedRecord.bind(human);
  await assert.rejects(wrong(caller,experience,'organize_messages',{input,idempotency_key:randomUUID()}),{code:'APP_RUN_AUTHORIZATION_STALE'});
 }
 assert.equal(progressed,0);
});

test('resource review captures data-only authority at every data preflight, keeping action guards',async()=>{const f=fixture();await f.broker.prepareResource(randomUUID(),'target','organize_messages',f.request);assert.deepEqual(f.counts().selections,['none','none']);assert.equal(f.counts().guards,3);});
test('resource plan operations omit unrelated actions but record effects retain them',()=>{for(const op of ['prepare_resource_action','read_prepared_resource_action'])assert.equal(appDataConnectionActionSelection(op),'none');for(const op of ['prepare_action','read_prepared','prepared_action_commit',undefined])assert.equal(appDataConnectionActionSelection(op),undefined);});

test('immutable record callback introspection omits unrelated actions without changing outer review or effect authority',()=>{
 for(const op of ['prepare_action','read_prepared']){assert.equal(appDataRuntimeConnectionActionSelection(op),'none');assert.equal(appDataConnectionActionSelection(op),undefined);}
 for(const op of ['prepared_action_commit','prepared_action_restore','unrecognized'])assert.equal(appDataRuntimeConnectionActionSelection(op),undefined);
});
test('inner resource preparation uses data-only expiry preflight',async()=>{const selections:unknown[]=[];const authority={expires_at:Date.now()+60000};class Probe extends AppDataService {override async current(...args:any[]):Promise<any>{selections.push(appDataConnectionActionSelection(args[3]));return authority;}override async invoke():Promise<any>{return {result:{outcome:'completed',prepared_resource:{expires_at:new Date(Date.now()+60000).toISOString()}},authority};}}await new Probe(caller,(async()=>{}) as any).prepareResource(session,{store_key:'drafts'});assert.deepEqual(selections,['none']);});
