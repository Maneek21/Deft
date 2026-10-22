import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {drizzle} from 'drizzle-orm/node-postgres';

const org=randomUUID(),owner=randomUUID(),session=randomUUID(),resource=randomUUID();
const input={org_id:org,owner_user_id:owner,session_id:session,purpose:'saved_read' as const};
let flags={upgrade:false,pending_form:false,continuation:false,current_form:false},validForm=true,formChecks=0,effectPurpose=0,effectSuperseded=0;
let afterResourceWait=()=>{},afterFormWait=()=>{};
const statements:{text:string;params:unknown[]}[]=[];
mock.module(new URL('../src/lib/app-connection-consent-continuation-store.ts',import.meta.url).href,{namedExports:{ConsentContinuationRecordSchema:{},continuationDenied:()=>Error('denied')}});
mock.module(new URL('../src/lib/app-connection-consent-continuation-service.ts',import.meta.url).href,{namedExports:{continuationRequest:()=>({}),continuationDigest:()=>''}});
mock.module(new URL('../src/lib/app-connection-form-carrier.ts',import.meta.url).href,{namedExports:{validateFormCarrierPair:()=>{
 formChecks++;if(!validForm)throw Error('APP_CONNECTION_FORM_SPLIT_STATE');return {form:{state:'connected',receipt:{}}};
}}});
mock.module(new URL('../src/lib/app-connection-credential-repair-fence.ts',import.meta.url).href,{namedExports:{
 appConnectionCredentialRepairPurposeIsAvailable:async()=>{effectPurpose++;return true;},
 appConnectionCredentialRepairSourceIsSuperseded:async()=>{effectSuperseded++;return false;},
}});
const database=drizzle({client:{query:async(config:{text:string},params:unknown[])=>{
 const text=config.text;statements.push({text,params});
 if(text.startsWith('select exists'))return {rows:[[flags.upgrade,flags.pending_form,flags.continuation,flags.current_form]]};
 if(text.includes('from "app_connection_forms"')&&text.includes('inner join')){
  afterFormWait();return {rows:flags.current_form?[[{},{}]]:[]};
 }
 if(text.includes('from "app_connection_forms"'))return {rows:flags.pending_form?[[session]]:[]};
 if(text.includes('from "app_connection_consent_continuations"'))return {rows:flags.continuation?[[session]]:[]};
 if(text.includes("->'credential_repair' IS NULL")){afterResourceWait();return {rows:[[session]]};}
 if(text.includes("->'upgrade'->'begin_consumed'"))return {rows:flags.upgrade?[[session]]:[]};
 if(text.includes('select "record"'))return {rows:[[{scope:{resource_binding_id:resource}}]]};
 if(text.includes("->'scope'->>'resource_binding_id'"))return {rows:[[resource]]};
 return {rows:[[session]]};
}} as never});
const {appConnectionUpgradeSourceIsAvailable}=await import('../src/lib/app-connection-upgrade-fence.js');
const read=()=>appConnectionUpgradeSourceIsAvailable(database as never,input);
function reset(){flags={upgrade:false,pending_form:false,continuation:false,current_form:false};validForm=true;formChecks=0;effectPurpose=0;effectSuperseded=0;afterResourceWait=()=>{};afterFormWait=()=>{};statements.length=0;}

test('saved reads use three fresh scoped statements and retain source/resource custody locks',async()=>{
 reset();assert.equal(await read(),true);assert.equal(statements.length,3);
 assert.ok(statements[0]!.text.endsWith('for share'));assert.ok(statements[1]!.text.endsWith('for share'));
 assert.deepEqual(statements[0]!.params,[org,session,owner,1]);
 const batch=statements[2]!;assert.ok(batch.text.startsWith('select exists'));
 assert.ok(batch.params.filter(value=>value===org).length>=5);assert.ok(batch.params.filter(value=>value===owner).length>=5);
 for(const retained of ["->'upgrade'->'begin_consumed'","->'activation_started'",'"source_session_id"',"->'input_consumed'","->'receipt'",'"owner_user_id"'])assert.ok(batch.text.includes(retained),retained);
 assert.equal(effectPurpose,0);assert.equal(effectSuperseded,0);
 await read();assert.equal(statements.length,6,'a later boundary repeats every mutable absence read');
});

test('upgrade replay, pending form and continuation insertion after a custody wait each fence saved reads',async()=>{
 for(const key of ['upgrade','pending_form','continuation'] as const){
  reset();afterResourceWait=()=>{flags[key]=true;};assert.equal(await read(),false,key);
  assert.equal(statements.length,3);
 }
});

test('present form journals keep locked pair validation and reread all absence facts after that lock wait',async()=>{
 reset();flags.current_form=true;assert.equal(await read(),true);assert.equal(formChecks,1);assert.equal(statements.length,6);
 assert.equal(statements.filter(row=>row.text.startsWith('select exists')).length,2);
 reset();flags.current_form=true;validForm=false;assert.equal(await read(),false);assert.equal(formChecks,1);
 reset();flags.current_form=true;afterFormWait=()=>{flags.continuation=true;};
 assert.equal(await read(),false,'activation inserted during a form wait must be seen by the fresh final batch');
 assert.equal(statements.filter(row=>row.text.startsWith('select exists')).length,2);
});

test('effect admission retains its independent credential-repair, form and continuation path',async()=>{
 reset();assert.equal(await appConnectionUpgradeSourceIsAvailable(database as never,{...input,purpose:'effect'}),true);
 assert.equal(effectPurpose,1);assert.equal(effectSuperseded,1);
 assert.equal(statements.filter(row=>row.text.startsWith('select exists')).length,0);
});
