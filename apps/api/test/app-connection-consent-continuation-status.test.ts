import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {AppConnectionConsentContinuationService} from '../src/lib/app-connection-consent-continuation-service.js';

test('reviewed unactivated status is read-only and never invokes Runtime',async()=>{
 const id=randomUUID(),owner=randomUUID(),digest='sha256:'+'a'.repeat(64),session_id=randomUUID();
 const scope={org_id:id,owner_user_id:owner,installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
  package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,target_key:'account',resource_key:'inbox',
  resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:owner,runtime_epoch:1,profile_digest:digest,
  consent_expires_at:'2030-01-01T13:00:00.000Z'};
 const account={account_ref:'synthetic_account',label:'Synthetic account'};
 const record:any={session_id,revision:4,state:'reviewed',activation_started:false,scope,review_expires_at:'2030-01-01T12:00:00.000Z',
  review:{digest,custody_generation:2,custody_digest:digest,account}};
 const before=structuredClone(record),service:any=new AppConnectionConsentContinuationService({org_id:id,user_id:owner,sid:randomUUID(),access_expires_at:Date.now()+60000} as any,async()=>{});
 let runtimeCalls=0,ownerChecks=0,writes=0;
 service.store={metadata:async()=>({record,revision:record.revision}),cas:async()=>{writes++;throw Error('unexpected write');}};
 service.retainWebOwner=async()=>{ownerChecks++;};
 service.invoke=async()=>{runtimeCalls++;throw Error('unexpected Runtime call');};
 const result=await service.status({session_id});
 assert.equal(result.state,'indeterminate');assert.equal(result.session_id,session_id);
 assert.equal(ownerChecks,1);assert.equal(runtimeCalls,0);assert.equal(writes,0);assert.deepEqual(record,before);
 service.retainWebOwner=async()=>{throw Error('synthetic revoked resource');};
 await assert.rejects(service.status({session_id}),/synthetic revoked resource/);
 assert.equal(runtimeCalls,0);assert.equal(writes,0);assert.deepEqual(record,before);
});
