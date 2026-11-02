import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSessionResumable,runtimeResumeDeadline} from '../src/lib/app-runtime-renewal.js';
import {deriveBackgroundHealth} from '../src/lib/app-integration-capture-store.js';
import {APP_RUNTIME_SESSION_RESUME_GRACE_MS} from '../src/lib/app-runtime-contract.js';

const at=(ms:number)=>new Date(ms);
const GRACE=APP_RUNTIME_SESSION_RESUME_GRACE_MS;

test('runtimeSessionResumable admits only a lapsed lease inside the fixed grace window',()=>{
  const now=at(1_000_000),expires=at(0);
  assert.equal(runtimeSessionResumable(expires,now),true,'within window');
  assert.equal(runtimeSessionResumable(expires,new Date(0+GRACE)),true,'exactly at the window edge');
  assert.equal(runtimeSessionResumable(expires,new Date(0+GRACE+1)),false,'beyond the window');
  assert.equal(runtimeSessionResumable(at(now.getTime()+1),now),false,'a live lease is never a resume');
  assert.equal(runtimeSessionResumable(expires,new Date(NaN)),false);
});

test('runtimeResumeDeadline extends one rolling window and never resurrects live or mismatched state',()=>{
  const now=at(1_000_000),expired=at(900_000);
  assert.equal(runtimeResumeDeadline({now,current_expires_at:expired,expected_expires_at:expired})?.getTime(),now.getTime()+15*60_000);
  assert.equal(runtimeResumeDeadline({now,current_expires_at:now,expected_expires_at:now}),null,'live expiry is not a resume');
  assert.equal(runtimeResumeDeadline({now,current_expires_at:at(now.getTime()+1),expected_expires_at:at(now.getTime()+1)}),null,'future expiry is not a resume');
  assert.equal(runtimeResumeDeadline({now,current_expires_at:expired,expected_expires_at:at(expired.getTime()+1)}),null,'mismatched expectation rejected');
  assert.equal(runtimeResumeDeadline({now:new Date(NaN),current_expires_at:expired,expected_expires_at:expired}),null);
});

test('deriveBackgroundHealth reports healthy, paused and ended and never crosses a tenant',()=>{
  const now=at(2_000_000);
  const live={expires_at:at(now.getTime()+60_000),revoked_at:null,updated_at:at(1_000_000)};
  assert.deepEqual(deriveBackgroundHealth([live],now),{state:'healthy',since:live.updated_at.toISOString(),reason:'live'});
  const lapsed={expires_at:at(now.getTime()-20*60_000),revoked_at:null,updated_at:at(1_000_000)};
  assert.deepEqual(deriveBackgroundHealth([lapsed],now),{state:'paused',since:lapsed.expires_at.toISOString(),reason:'lapsed'});
  const ended={expires_at:at(now.getTime()-25*60*60_000),revoked_at:null,updated_at:at(1_000_000)};
  assert.deepEqual(deriveBackgroundHealth([ended],now),{state:'ended',since:new Date(ended.expires_at.getTime()+GRACE).toISOString(),reason:'expired'});
  const revoked={expires_at:at(now.getTime()+60_000),revoked_at:at(now.getTime()-1),updated_at:at(1_000_000)};
  assert.deepEqual(deriveBackgroundHealth([revoked],now),{state:'ended',since:revoked.revoked_at!.toISOString(),reason:'revoked'});
  assert.equal(deriveBackgroundHealth([],now),null,'no background lease reports null');
  // Worst state wins across several leases.
  assert.equal(deriveBackgroundHealth([live,revoked],now)!.state,'ended');
  assert.equal(deriveBackgroundHealth([live,lapsed],now)!.state,'paused');
});
