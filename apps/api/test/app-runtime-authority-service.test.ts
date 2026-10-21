import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';

const registration={org_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),
 runtime_epoch:1,profile_digest:'sha256:'+'a'.repeat(64),target_key:'account',resource_key:'records'};
const installation_id=randomUUID(),scope={...registration,installation_id,owner_user_id:registration.operator_user_id,
 consent_expires_at:null,consent_lifetime:'until_revoked'};
let currentScope={...scope},authenticated=true,allowed=true,member=true,enrolled=true,currentReads=0;
const enrollment={role:'owner'};
function query(rows:unknown[]){const value:any={then:(resolve:any)=>Promise.resolve(rows).then(resolve)};
 for(const key of ['from','where','limit','for','orderBy'])value[key]=()=>value;return value;}
const tx={select:()=>query(enrolled?[enrollment]:[])};
mock.module(new URL('../src/lib/db.ts',import.meta.url).href,{namedExports:{db:{select:()=>query([{app_installation_id:installation_id}]),transaction:async(work:any)=>work(tx)}}});
mock.module(new URL('../src/lib/app-connection-session-registry.ts',import.meta.url).href,{namedExports:{getAppConnectionSessionRegistry:async()=>({authenticate:(s:any,authorization:string)=>{
 if(!authenticated||authorization!=='Bearer service'||s.installation_id!==installation_id||s.operator_user_id!==registration.operator_user_id)throw Error('credential denied');
}})}});
mock.module(new URL('../src/lib/app-connection-session-authority.ts',import.meta.url).href,{namedExports:{currentAppConnectionReadAuthority:async(caller:any,target:any,_guard:any,action:any)=>{
 currentReads++;assert.equal(caller.user_id,registration.operator_user_id);assert.equal(target.installation_id,installation_id);assert.equal(action,'none');
 if(!allowed)throw Error('current authority revoked');return {scope:currentScope,profile:{}};
}}});
mock.module(new URL('../src/lib/app-runtime-renewal.ts',import.meta.url).href,{namedExports:{runtimeRenewalPersistentPrincipal:async()=>member}});
const {runtimeBackgroundAccessAuthority,isRuntimeServiceGuard,RuntimeBackgroundAccessRequestSchema}=await import('../src/lib/app-runtime-authority-service.js');
const input={registration};
function reset(){currentScope={...scope};authenticated=true;allowed=true;member=true;enrolled=true;currentReads=0;}

test('expired technical enrollment reacquires through deployment authority without a live browser',async()=>{
 reset();const result=await runtimeBackgroundAccessAuthority(input,'Bearer service');
 assert.equal(result.caller.sid,'runtime-service:'+registration.runtime_registration_id);assert.equal(result.actor.actor_id,scope.owner_user_id);
 assert.equal(isRuntimeServiceGuard(result.guard),true);assert.equal(isRuntimeServiceGuard(Object.assign(async()=>{},{current_web_session_expires_at:()=>new Date()})),false);
 await result.guard(tx as never);assert.equal(currentReads,2);
});

test('service credential cannot nominate another owner, installation or broaden a grant',async()=>{
 for(const change of [{owner_user_id:randomUUID()},{runtime_registration_id:randomUUID()},{consent_lifetime:undefined},{profile_digest:'sha256:'+'b'.repeat(64)}]){
  reset();currentScope={...scope,...change} as typeof scope;await assert.rejects(runtimeBackgroundAccessAuthority(input,'Bearer service'));
 }
 reset();authenticated=false;await assert.rejects(runtimeBackgroundAccessAuthority(input,'Bearer service'));assert.equal(currentReads,0);
 assert.equal(RuntimeBackgroundAccessRequestSchema.safeParse({...input,owner_user_id:randomUUID()}).success,false);
});

test('revoked grant, removed member and absent operator membership deny fresh issuance',async()=>{
 reset();allowed=false;await assert.rejects(runtimeBackgroundAccessAuthority(input,'Bearer service'));
 reset();member=false;await assert.rejects(runtimeBackgroundAccessAuthority(input,'Bearer service'));
 reset();enrolled=false;await assert.rejects(runtimeBackgroundAccessAuthority(input,'Bearer service'));
});

test('service issuance guard rechecks revocation and operator membership at the live transaction boundary',async()=>{
 reset();const result=await runtimeBackgroundAccessAuthority(input,'Bearer service');
 allowed=false;await assert.rejects(result.guard(tx as never));allowed=true;
 enrolled=false;await assert.rejects(result.guard(tx as never));enrolled=true;
 member=false;await assert.rejects(result.guard(tx as never));member=true;
 authenticated=false;await assert.rejects(result.guard(tx as never));
});
