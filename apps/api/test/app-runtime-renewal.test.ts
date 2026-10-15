import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeRenewalDeadline,runtimeRenewalOptedIn} from '../src/lib/app-runtime-renewal.js';
import {AppRuntimeSessionIssueInputSchema,AppRuntimeRenewRequestSchema} from '../src/lib/app-runtime-contract.js';
test('renewal deadlines use current authority, finite immutable ceilings and exact expected state',()=>{
 const now=new Date(),at=(delta:number)=>new Date(now.getTime()+delta);
 const base={now,current_expires_at:at(60_000),expected_expires_at:at(60_000),renewable_until:at(3_600_000),principal_expires_at:at(7_200_000)};
 assert.equal(runtimeRenewalDeadline(base)?.getTime(),at(900_000).getTime());
 assert.equal(runtimeRenewalDeadline({...base,renewable_until:at(120_000)})?.getTime(),at(120_000).getTime());
 assert.equal(runtimeRenewalDeadline({...base,target_expires_at:at(180_000)})?.getTime(),at(180_000).getTime());
 assert.equal(runtimeRenewalDeadline({...base,expected_expires_at:at(-1)})?.getTime(),base.current_expires_at.getTime(),'stale enrollment only returns Host current state');
 for(const delta of [{now:at(60_000)},{now:at(60_001)},{renewable_until:new Date(NaN)},{principal_expires_at:at(30_000)},{target_expires_at:at(30_000)},{expected_expires_at:at(60_001)}])assert.equal(runtimeRenewalDeadline({...base,...delta}),null);
 assert.equal(runtimeRenewalOptedIn({renewable_until:null,renewal_web_session_id:null,renewal_operator_role:null}),false);
 assert.equal(runtimeRenewalOptedIn({renewable_until:null,renewal_web_session_id:'partial',renewal_operator_role:null}),true,'partial pins are not treated as legacy');
});
test('issuer and renewal schemas do not accept caller nominated principal, ceiling or scope pins',()=>{
 assert.ok(AppRuntimeSessionIssueInputSchema.safeParse({}).success);
 assert.ok(AppRuntimeSessionIssueInputSchema.safeParse({technical_renewal:{requested_until:new Date().toISOString()}}).success);
 for(const key of ['sid','role','renewable_until','runtime_epoch','owner_resource_binding_id'])assert.equal(AppRuntimeSessionIssueInputSchema.safeParse({technical_renewal:{requested_until:new Date().toISOString(),[key]:'nominated'}}).success,false);
 const request={schema_version:'deft.app_runtime_channel.v1',session_id:'id',session_token:'a'.repeat(32),expected_expires_at:new Date().toISOString()};
 assert.ok(AppRuntimeRenewRequestSchema.safeParse(request).success);
 for(const key of ['renewable_until','sid','role','resource_binding_id','expires_at'])assert.equal(AppRuntimeRenewRequestSchema.safeParse({...request,[key]:'nominated'}).success,false);
});


test('explicit persistent permission renews only a live finite lease; expired/implicit/mixed mode fail',()=>{
 const now=new Date('2099-10-15T12:00:00.000Z'),current=new Date(now.getTime()+60000);
 const base={now,current_expires_at:current,expected_expires_at:current,renewable_until:null,principal_expires_at:null,renewal_lifetime:'until_revoked' as const};
 assert.equal(runtimeRenewalDeadline(base)?.getTime(),now.getTime()+15*60000);
 assert.equal(runtimeRenewalDeadline({...base,expected_expires_at:new Date(now.getTime()-60000)})?.getTime(),current.getTime());
 assert.equal(runtimeRenewalDeadline({...base,current_expires_at:now,expected_expires_at:now}),null);
 assert.equal(runtimeRenewalDeadline({...base,renewal_lifetime:undefined}),null);
 assert.equal(runtimeRenewalDeadline({...base,renewable_until:current}),null);
 assert.equal(runtimeRenewalDeadline({...base,principal_expires_at:current}),null);
});
