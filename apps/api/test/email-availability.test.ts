import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {AppConnectionRegistry} from '../src/lib/app-connection-registry.js';
import {currentLegacyEmailInstallationIds,listEmailConnectionTargets} from '../src/lib/email-availability.js';

const org=randomUUID(),owner=randomUUID(),foreign=randomUUID();
const pins=(installation_id:string,selectedOwner=owner)=>({org_id:org,owner_user_id:selectedOwner,installation_id,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),target_key:'primary',resource_key:'mailbox',resource_binding_id:randomUUID(),action_key:null,action_binding_id:null});
const adapter=(methods:('account'|'page')[]=['account','page'])=>({handle:async()=>({}),...(methods.includes('account')?{nativeEmailAccount:async()=>({})}:{}),...(methods.includes('page')?{nativeEmailPage:async()=>({})}:{})});
test('availability IDs require both registered adapter methods and an exact live reviewed edge',async()=>{
 const registry=new AppConnectionRegistry([
  {pins:pins(randomUUID()),adapter:adapter() as any},{pins:pins(randomUUID()),adapter:adapter(['account']) as any},
  {pins:pins(randomUUID(),foreign),adapter:adapter() as any},{pins:pins(randomUUID()),adapter:adapter() as any},
 ]);
 const ownerEntries=registry.retainedOwnerEntriesForOwner({org_id:org,owner_user_id:owner}),a=ownerEntries[0]!.pins.installation_id,d=ownerEntries[2]!.pins.installation_id;
 const checked:string[]=[];const ids=await currentLegacyEmailInstallationIds({org_id:org,owner_user_id:owner,registry,
  live:async entry=>{checked.push(entry.pins.installation_id);return entry.pins.installation_id===a||entry.pins.installation_id===d;}});
 assert.deepEqual(ids,[a,d].sort());assert.deepEqual(checked,[a,d]);
});
test('connection targets use owner-status results and return only the closed nomination shape',async()=>{
 const registry=new AppConnectionRegistry([{pins:pins(randomUUID()),adapter:adapter() as any},{pins:pins(randomUUID(),foreign),adapter:adapter() as any}]);
 const entry=registry.retainedOwnerEntriesForOwner({org_id:org,owner_user_id:owner})[0]!;let active=0,maxActive=0;
 const result=await listEmailConnectionTargets({user_id:owner,web_session_id:randomUUID(),access_expires_at:Date.now()+60000},org,registry,async()=>{
  active++;maxActive=Math.max(active,maxActive);await new Promise(resolve=>setTimeout(resolve,2));active--;
   return {state:'connected',account:{account_id:'account-safe',provider:'gmail',health:'connected',primary_address:'owner@example.com',display_label:'Owner'},
   native_email:{account_id:'account-safe',resource_binding_id:entry.pins.resource_binding_id,state:'available'},secret:'must-not-return'};
 },async()=> 'absent');
 assert.ok(maxActive<=2);assert.equal(result.targets.length,1);assert.deepEqual(Object.keys(result.targets[0]!).sort(),['display_label','native_email','primary_address','provider']);
 assert.equal(result.targets[0]!.native_email.state,'available');assert.equal(result.unavailable_count,0);
});
