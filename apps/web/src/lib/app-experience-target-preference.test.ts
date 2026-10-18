import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceTargetPreference,experienceTargetPreferenceKey} from './app-experience-target-preference';
const scope={orgId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',installationId:'33333333-3333-4333-8333-333333333333'};
const catalog=[{key:'recipient'},{key:'sender'}];
function fixture(){const values=new Map<string,string>();return {values,preference:createExperienceTargetPreference({getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);}})};}
test('successful current sender selection restores only its fresh catalog nomination after reload',()=>{
 const f=fixture();assert.equal(f.preference.select(scope,catalog,()=>true),'recipient');
 assert.equal(f.preference.remember(scope,catalog,'sender',()=>true),true);assert.equal(f.preference.select(scope,catalog,()=>true),'sender');
 assert.deepEqual([...f.values.values()],['sender']);assert.equal(f.preference.select(scope,catalog,()=>true,'recipient'),'recipient');
});
test('org, owner and installation preferences cannot cross scopes',()=>{
 const f=fixture();f.preference.remember(scope,catalog,'sender',()=>true);
 for(const field of ['orgId','userId','installationId'] as const){const foreign={...scope,[field]:'44444444-4444-4444-8444-444444444444'};assert.equal(f.preference.select(foreign,catalog,()=>true),'recipient');}
});
test('removed, revoked or stale target cannot acquire authority from a saved preference',()=>{
 const f=fixture();f.preference.remember(scope,catalog,'sender',()=>true);
 assert.equal(f.preference.select(scope,[{key:'recipient'}],()=>true),'recipient');assert.equal(f.preference.select(scope,catalog,()=>false),null);
 assert.equal(f.preference.remember(scope,catalog,'recipient',()=>false),false);assert.equal(f.preference.remember(scope,[{key:'recipient'}],'sender',()=>true),false);
 assert.equal(f.preference.select(scope,catalog,()=>true),'sender');
});
test('selection does not persist an unconfirmed switch and storage/catalog denial is bounded',()=>{
 const f=fixture();f.preference.remember(scope,catalog,'sender',()=>true);
 assert.equal(f.preference.select(scope,catalog,()=>true,'recipient'),'recipient');assert.equal(f.preference.select(scope,catalog,()=>true),'sender');
 assert.equal(f.preference.select(scope,[{key:'sender'},{key:'sender'}],()=>true),null);assert.equal(f.preference.select({...scope,userId:'foreign'},catalog,()=>true),null);
 let live=true;const storage=createExperienceTargetPreference({getItem:()=>{live=false;return 'sender';},setItem:()=>{throw Error('denied');}});assert.equal(storage.select(scope,catalog,()=>live),null);
 const denied=createExperienceTargetPreference({getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}});assert.equal(denied.select(scope,catalog,()=>true),'recipient');assert.equal(denied.remember(scope,catalog,'sender',()=>true),false);
 assert.equal(experienceTargetPreferenceKey(scope),`deft.experience.target.v1:${JSON.stringify([scope.orgId,scope.userId,scope.installationId])}`);
});
