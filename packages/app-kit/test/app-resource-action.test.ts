import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AppResourceActionPlanInputSchema,AppResourceActionPrepareSchema,AppResourceActionDialogInputSchema,
  AppDataPreparedResourceActionSchema,AppResourceActionReleasedInputSchema,AppResourceActionReviewSchema} from '../src/app-resource-action.js';
import {AppDataOperationInputSchema,AppDataRuntimeRequestSchema,AppDataResultSchema} from '../src/app-data.js';
const hash='sha256:'+'a'.repeat(64),record=randomUUID(),snapshot=randomUUID(),account=randomUUID();
const sources=[{resource_key:'inbox',record_id:record,content_digest:hash}];
const plan={store_key:'drafts',resource_key:'inbox',action_key:'organize_messages',operation_key:'archive',sources};
const prepared={schema_version:'deft.app_prepared_resource_action.v1',snapshot_id:snapshot,snapshot_digest:hash,account_ref:account,
  action_key:'organize_messages',operation_key:'archive',resource_key:'inbox',source_manifest_digest:hash,item_count:1,
  input:{snapshot_id:snapshot,account_ref:account,operation_key:'archive',source_manifest_digest:hash,item_count:1,plan_digest:hash},
  preview:{title:'Archive one item',count:1,items:[{record_id:record,label:'Reviewed source',before:'Inbox',after:'Archive'}]},
  expires_at:'2030-01-01T00:00:00.000Z'};
test('public resource action nominations are closed, scoped and limited to25 unique references',()=>{
 assert.deepEqual(AppResourceActionDialogInputSchema.parse(plan),plan);
 assert.ok(AppResourceActionPrepareSchema.safeParse({store_key:'drafts',resource_key:'inbox',operation_key:'archive',sources,
  connection_session_id:randomUUID(),idempotency_key:randomUUID()}).success);
 for(const bad of [{...plan,options:{delete:true}},{...plan,sources:[]},{...plan,sources:[...sources,...sources]},
  {...plan,sources:[{...sources[0],resource_key:'foreign'}]},{...plan,sources:Array.from({length:26},()=>({...sources[0],record_id:randomUUID()}))}])
  assert.equal(AppResourceActionPlanInputSchema.safeParse(bad).success,false);
});
test('prepared resource plan and13scalar release pins preserve exact immutable identities',()=>{
 assert.ok(AppDataPreparedResourceActionSchema.safeParse(prepared).success);
 for(const bad of [{...prepared,input:{...prepared.input,plan_digest:'sha256:'+'b'.repeat(64)}},
  {...prepared,input:{...prepared.input,account_ref:randomUUID()}},{...prepared,preview:{...prepared.preview,count:2}},
  {...prepared,preview:{...prepared.preview,items:[{...prepared.preview.items[0],label:'<script>'}]}},
  {...prepared,input:{...prepared.input,sources:JSON.stringify(sources)}}])assert.equal(AppDataPreparedResourceActionSchema.safeParse(bad).success,false);
 const input={...prepared.input,resource_action_version:prepared.schema_version,resource_store_key:'drafts',connection_session_id:randomUUID(),
  connection_revision:1,data_consent_id:randomUUID(),data_consent_digest:hash,prepared_digest:hash};
 assert.equal(Object.keys(AppResourceActionReleasedInputSchema.parse(input)).length,13);
 assert.equal(AppResourceActionReleasedInputSchema.safeParse({...input,record_action_version:'legacy'}).success,false);
 const review={schema_version:'deft.app_resource_action_review.v1',prepared,input,ticket:'sealed',input_digest:hash,expires_at:prepared.expires_at};
 assert.ok(AppResourceActionReviewSchema.safeParse(review).success);
 assert.equal(AppResourceActionReviewSchema.safeParse({...review,input:{...input,operation_key:'trash'}}).success,false);
 assert.equal(AppResourceActionReviewSchema.safeParse({...review,expires_at:'2031-01-01T00:00:00.000Z'}).success,false);
});
test('planning uses explicit existing data operations and cannot appear as an ordinary result',()=>{
 assert.ok(AppDataOperationInputSchema.safeParse({operation:'prepare_resource_action',input:plan}).success);
 assert.ok(AppDataOperationInputSchema.safeParse({operation:'read_prepared_resource_action',input:{store_key:'drafts',resource_key:'inbox',snapshot_id:snapshot,snapshot_digest:hash}}).success);
 const result={schema_version:'deft.app_data_result.v1',request_id:randomUUID(),operation:'prepare_resource_action',input_digest:hash,outcome:'completed',prepared_resource:prepared};
 assert.ok(AppDataResultSchema.safeParse(result).success);
 assert.equal(AppDataResultSchema.safeParse({...result,operation:'record_read'}).success,false);
});
