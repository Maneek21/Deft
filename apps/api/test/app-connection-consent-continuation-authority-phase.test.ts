import assert from 'node:assert/strict';
import test from 'node:test';
import {appConnectionConsentContinuationRuntimePhaseAllowed as allowed,appConnectionConsentContinuationProposedScope as project} from '../src/lib/app-connection-consent-continuation-authority.js';

const review={digest:'sha256:'+'a'.repeat(64)} as any;
const phase=(state:string,activation_started:boolean)=>({state,activation_started}) as any;
const request=(operation:'prepare'|'activate'|'status',value:unknown=null)=>({operation,review:value}) as any;

test('renewal projection replaces optional lifetime mode without changing source identity or history',()=>{
 const identity={org_id:'fixture-org',resource_binding_id:'fixture-binding',grant_epoch:7},expiry='2030-01-01T00:00:00.000Z';
 const finite=Object.freeze({...identity,consent_expires_at:expiry}),persistent=Object.freeze({...identity,consent_expires_at:null,consent_lifetime:'until_revoked'});
 assert.deepEqual(project(finite as any,null,'until_revoked'),persistent);
 assert.deepEqual(project(persistent as any,expiry),finite);
 assert.deepEqual(project(persistent as any,null,'until_revoked'),persistent);
 assert.equal(persistent.consent_lifetime,'until_revoked');assert.equal(finite.consent_expires_at,expiry);
});

test('reviewed status cannot authorize Runtime publication before Host activation starts',()=>{
 assert.equal(allowed(phase('reviewed',false),request('status',review)),false);
 assert.equal(allowed(phase('reviewed',false),request('status',null)),true);
 assert.equal(allowed(phase('indeterminate',true),request('status',review)),true);
 assert.equal(allowed(phase('indeterminate',true),request('status',null)),false);
});

test('continuation Runtime authority retains existing operation phase fences',()=>{
 assert.equal(allowed(phase('preparing',false),request('prepare')),true);
 assert.equal(allowed(phase('reviewed',false),request('prepare')),false);
 assert.equal(allowed(phase('activating',true),request('activate',review)),true);
 assert.equal(allowed(phase('indeterminate',true),request('activate',review)),true);
 assert.equal(allowed(phase('connected',true),request('status',review)),false);
 assert.equal(allowed(phase('not_connected',false),request('status',null)),false);
 assert.equal(allowed(phase('committing',true),request('status',review)),false);
});
