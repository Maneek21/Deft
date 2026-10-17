import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {currentConnectionContextView,currentConnectionReattachmentContext} from '../src/lib/app-connection-session-context.js';
import {connectionProfileDigest} from '../src/lib/app-connection-session-registry.js';
import type {AppConnectionSessionRecord} from '../src/lib/app-connection-session-service.js';

function fixture(){
 const profile={schema_version:'deft.app_connection_profile.v1' as const,key:'provider',provider_id:'provider',operator_user_id:randomUUID(),runtime_requirement_key:'sync',resource_key:'messages',
  action_keys:[],authorization_origin:'https://provider.example.test',credential_custody:'runtime' as const,executable:false as const};
 const scope={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),package_digest:'sha256:'+'1'.repeat(64),
  grant_snapshot_digest:'sha256:'+'2'.repeat(64),lifecycle_epoch:1,grant_epoch:1,target_key:'account',resource_key:'messages',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),
  operator_user_id:profile.operator_user_id,runtime_epoch:1,profile_digest:connectionProfileDigest(profile),consent_expires_at:'2030-01-01T00:00:00Z'};
 const record:AppConnectionSessionRecord={session_id:randomUUID(),revision:0,scope,profile,state:'starting',callback_state_hash:'a'.repeat(64),callback_consumed:false,callback_expires_at:'2029-01-01T00:00:00Z',
  runtime_session_ref:'private_runtime_reference',account:null,created_at:'2028-01-01T00:00:00Z',updated_at:'2028-01-01T00:00:00Z'};
 return {record,current:{scope,profile,expires_at:Date.parse('2030-01-01T00:00:00Z')}};
}
test('reattachment context nominates only exact owned predecessor metadata and restores pending intent without secrets',()=>{
 const {record,current}=fixture();
 const previous={...record,state:'connected' as const,revision:2,account:{account_ref:'stable_account',label:'Mailbox'},
  callback_consumed:true,scope:{...record.scope,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),lifecycle_epoch:0,grant_epoch:0}};
 const candidate=currentConnectionReattachmentContext(null,previous,current);
 assert.deepEqual(candidate.candidate,{source_session_id:previous.session_id,source_revision:2,account:previous.account});
 assert.equal(JSON.stringify(candidate).includes('private_runtime_reference'),false);
 for(const patch of [{owner_user_id:randomUUID()},{target_key:'foreign'},{profile_digest:'sha256:'+'9'.repeat(64)},
  {app_version_id:current.scope.app_version_id},{lifecycle_epoch:current.scope.lifecycle_epoch}])
  assert.equal(currentConnectionReattachmentContext(null,{...previous,scope:{...previous.scope,...patch}},current).candidate,null);
 const pending={...record,state:'reattach_reviewed' as const,reattachment:{schema_version:'deft.app_connection_reattachment.v1' as const,
  source:{session_id:previous.session_id,session_revision:2,scope:previous.scope,runtime_session_ref:'private_runtime_reference',account_ref:'stable_account'},
  transport_digest:'sha256:'+'8'.repeat(64),review_expires_at:record.callback_expires_at,
  review:{digest:'sha256:'+'7'.repeat(64),custody_generation:1,custody_digest:'sha256:'+'6'.repeat(64),account:previous.account},receipt:null}};
 const context=currentConnectionReattachmentContext(pending,previous,current);
 assert.equal(context.candidate,null);assert.equal(context.pending!.session_id,pending.session_id);
 assert.equal(context.pending!.activation_started,false);assert.ok(context.pending!.review);
 assert.equal(JSON.stringify(context).includes('private_runtime_reference'),false);
 const activated=currentConnectionReattachmentContext({...pending,state:'indeterminate',callback_consumed:true},previous,current);
 assert.equal(activated.pending!.activation_started,true);assert.equal(activated.pending!.review,null);assert.equal(activated.candidate,null);
 const resolved=currentConnectionReattachmentContext({...pending,state:'not_connected'},previous,current);
 assert.ok(resolved.candidate);assert.equal(resolved.pending,null);
 for(const state of ['checking','disconnecting','indeterminate'] as const){
  const completed=currentConnectionReattachmentContext({...pending,state,callback_consumed:true,
   reattachment:{...pending.reattachment,receipt:{custody_generation:2,receipt_digest:'sha256:'+'5'.repeat(64)}}},previous,current);
  assert.equal(completed.pending,null);assert.equal(completed.candidate,null);
 }
});
test('context recovers durable unknown Begin without nonce, runtime reference or automatic I/O',()=>{
 const {record,current}=fixture();
 for(const state of ['starting','connecting','checking','disconnecting','indeterminate'] as const){
  const view=currentConnectionContextView({...record,state},current)!;assert.equal(view.state,'indeterminate');assert.equal(view.session_id,record.session_id);
  assert.deepEqual(Object.keys(view).sort(),['account','expires_at','schema_version','scope','session_id','state']);
  assert.equal(JSON.stringify(view).includes(record.runtime_session_ref!),false);assert.equal(JSON.stringify(view).includes(record.callback_state_hash),false);
 }
 assert.equal(currentConnectionContextView({...record,state:'awaiting_callback'},current)!.state,'awaiting_callback');
});
test('context session projection rejects foreign and stale version/grant/resource/runtime/profile pins',()=>{
 const {record,current}=fixture();assert.equal(currentConnectionContextView(null,current),null);
 for(const field of ['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','resource_binding_id','runtime_registration_id','operator_user_id'] as const)
  assert.equal(currentConnectionContextView({...record,scope:{...record.scope,[field]:randomUUID()}},current),null,field);
 for(const field of ['lifecycle_epoch','grant_epoch','runtime_epoch'] as const)
  assert.equal(currentConnectionContextView({...record,scope:{...record.scope,[field]:2}},current),null,field);
 assert.equal(currentConnectionContextView({...record,profile:{...record.profile,authorization_origin:'https://other.example.test'}},current),null);
});

test('v2 pending reattachment recovers exact reviewed independent purposes without source credential reference',()=>{
 const {record,current}=fixture(),id=randomUUID(),actions=[{action_key:'send_message',action_binding_id:id,consent_id:id,authority_epoch:1,consent_digest:'sha256:'+'a'.repeat(64),expires_at:record.scope.consent_expires_at}];
 const source={...record,session_id:randomUUID(),revision:2,state:'connected' as const,action_consents:actions,account:{account_ref:'stable_account',label:'Mailbox'},scope:{...record.scope,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),lifecycle_epoch:0,grant_epoch:0}};
 const pending={...record,action_consents:actions,state:'reattach_reviewed' as const,reattachment:{schema_version:'deft.app_connection_reattachment.v1' as const,
  source:{session_id:source.session_id,session_revision:2,scope:source.scope,runtime_session_ref:'private_runtime_reference',account_ref:'stable_account'},transport_digest:'sha256:'+'b'.repeat(64),review_expires_at:record.callback_expires_at,
  review:{digest:'sha256:'+'c'.repeat(64),custody_generation:1,custody_digest:'sha256:'+'d'.repeat(64),account:source.account},receipt:null}};
 const context=currentConnectionReattachmentContext(pending,source,current);assert.equal(context.pending!.review!.schema_version,'deft.app_connection_reattach_review.v2');
 assert.deepEqual('action_consents' in context.pending!.review!&&context.pending!.review.action_consents,actions);assert.equal(JSON.stringify(context).includes('private_runtime_reference'),false);
});
