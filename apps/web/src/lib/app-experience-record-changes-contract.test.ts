import assert from 'node:assert/strict';import test from 'node:test';
import {AppRecordChangeRuntimeRequestSchema,AppRecordChangeAuthorityRequestSchema,AppRecordPrepareChangeInputSchema} from '../../../../packages/app-kit/src/record-change';
import {AppDataRuntimeRequestSchema,AppDataRuntimeAuthorityRequestSchema,RecordStoreDeclarationsSchema,AppDataRequestSchema} from '../../../../packages/app-kit/src/app-data';
import {fixture,hash,uuid} from './app-experience-record-changes-test-fixture';
test('v2 permits exactly two operations and ordered distinct complete store proofs; legacy envelope cannot carry them',()=>{
 const f=fixture(),runtime={schema_version:'deft.app_data_runtime.v2',request_id:uuid(),scope:f.scope,connection:f.connection,record_authorities:f.proofs,operation:'record_prepare_change',input:f.input,expires_at:new Date(Date.now()+30000).toISOString()};
 assert.ok(AppRecordChangeRuntimeRequestSchema.safeParse(runtime).success);const {input,...authority}=runtime;
 assert.ok(AppRecordChangeAuthorityRequestSchema.safeParse({...authority,schema_version:'deft.app_data_authority.v2',input_digest:hash}).success);
 for(const patch of [{record_authorities:null},{record_authorities:[f.proofs[0]]},{record_authorities:[f.proofs[1],f.proofs[0]]},{record_authorities:[f.proofs[0],{...f.proofs[1],store_key:'drafts'}]},
 {record_authorities:[f.proofs[0],{...f.proofs[1],extra:true}]},{authority:{}},{operation:'record_save'},{expires_at:new Date(Date.now()+7200000).toISOString()},{input:{...f.input,source:{...f.input.source,value:{}}}}])assert.equal(AppRecordChangeRuntimeRequestSchema.safeParse({...runtime,...patch}).success,false);
 const v1={...runtime,schema_version:'deft.app_data_runtime.v1',authority:{consent_id:uuid(),consent_digest:hash,data_policy_digest:hash}};delete (v1 as any).record_authorities;
 assert.equal(AppDataRuntimeRequestSchema.safeParse(v1).success,false);const {input:_,...v1auth}=v1;assert.equal(AppDataRuntimeAuthorityRequestSchema.safeParse({...v1auth,schema_version:'deft.app_data_authority.v1',input_digest:hash}).success,false);
 assert.equal(AppDataRequestSchema.safeParse({schema_version:'deft.app_data_request.v1',request_id:runtime.request_id,operation:runtime.operation,input}).success,true);
 assert.equal(AppRecordPrepareChangeInputSchema.safeParse({...input,source:{...input.source,store_key:'drafts'}}).success,false);
});
test('record change declarations bind an existing distinct store to the same resource and runtime',()=>{const f=fixture();assert.ok(RecordStoreDeclarationsSchema.safeParse([f.destination.store,f.source.store]).success);
 for(const stores of [[f.destination.store],[f.destination.store,{...f.source.store,resource_key:'foreign'}],[f.destination.store,{...f.source.store,runtime_requirement_key:'foreign'}],[{...f.destination.store,record_changes:[{key:'template_replace',source_store_key:'drafts'}]},f.source.store]])assert.equal(RecordStoreDeclarationsSchema.safeParse(stores).success,false);});
