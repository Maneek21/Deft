import test from 'node:test';
import assert from 'node:assert/strict';
import {humanRecordSaveReceipt} from './app-data-human-save';
const id='11111111-1111-4111-8111-111111111111',foreign='22222222-2222-4222-8222-222222222222',digest='sha256:'+'a'.repeat(64);
const scope={org_id:id,owner_user_id:id,installation_id:id,app_version_id:id,grant_snapshot_id:id,package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,target_key:'mailbox',resource_key:'inbox',resource_binding_id:id,runtime_registration_id:id,operator_user_id:id,runtime_epoch:1,profile_digest:digest,consent_expires_at:'2025-01-01T00:00:00Z'};
const authority={scope,connection:{account_ref:'own_account'}};
const record={store_key:'preferences',record_id:id,revision:2,content_digest:digest};
const context={schema_version:'deft.app_data_authority.v1',request_id:id,scope,connection:{session_id:id,session_revision:1,runtime_session_ref:'runtime_session',account_ref:'own_account'},authority:{consent_id:id,consent_digest:digest,data_policy_digest:digest},expires_at:'2025-01-01T00:00:00Z',operation:'record_save',input_digest:digest};
const row={org_id:id,owner_user_id:id,request_id:id,state:'completed',revision:1,operation:'record_save',context,result:{request_id:id,operation:'record_save',input_digest:digest,outcome:'completed',...record}};
test('exact completed human Save yields only current record receipt, historical expiry never becomes permission',()=>{
 assert.deepEqual(humanRecordSaveReceipt(authority,record,[row]),{request_id:id,...record});
 const upgraded={...authority,scope:{...scope,app_version_id:foreign}};assert.deepEqual(humanRecordSaveReceipt(upgraded,record,[row]),{request_id:id,...record});
});
test('foreign principal/account/reference, unsettled Save, invalid pins and duplicate receipts cannot grant automatic behavior',()=>{
 const cases=[{...row,org_id:foreign},{...row,owner_user_id:foreign},{...row,request_id:foreign},{...row,state:'indeterminate'},{...row,revision:0},{...row,operation:'record_create'},
 {...row,context:{...context,scope:{...scope,owner_user_id:foreign}}},{...row,context:{...context,scope:{...scope,installation_id:foreign}}},{...row,context:{...context,connection:{...context.connection,account_ref:'foreign_account'}}},
 {...row,result:{...row.result,input_digest:'sha256:'+'b'.repeat(64)}},{...row,result:{...row.result,store_key:'signatures'}},{...row,result:{...row.result,record_id:foreign}},{...row,result:{...row.result,revision:3}},{...row,result:{...row.result,content_digest:'sha256:'+'b'.repeat(64)}},{...row,result:{...row.result,outcome:'conflict'}},{...row,context:{...context,extra:'denied'}}];
 for(const changed of cases)assert.equal(humanRecordSaveReceipt(authority,record,[changed]),undefined);
 assert.equal(humanRecordSaveReceipt(authority,record,[]),undefined);assert.equal(humanRecordSaveReceipt(authority,record,[row,row]),undefined);
});
