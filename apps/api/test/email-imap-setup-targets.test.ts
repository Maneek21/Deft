import test from 'node:test';
import assert from 'node:assert/strict';
import {getTableName} from 'drizzle-orm';
import {PostgresEmailImapSetupTargets} from '../src/lib/email-imap-setup-targets.js';
const binding='11111111-1111-4111-8111-111111111111',actor={user_id:'owner',web_session_id:'sid',access_expires_at:10000};
function fixture(){
 const state={now:1000,events:[] as string[],member:{active:true,role:'member',version:1,kind:'human',is_agent:false},session:{id:'sid',org_id:'org',user_id:'owner',expires_at:new Date(10000),revoked_at:null as Date|null},accounts:[] as any[],credential:0,constructors:true,pinsChanged:false,foreign:false,late:undefined as (()=>void)|undefined,count:1,graph:1};
 const query=(table:string)=>{const result=()=>table==='web_sessions'?[{...state.session}]:table==='org_members'?[{...state.member}]:table==='email_accounts'?state.accounts:table==='email_imap_credentials'?(state.credential?[{revision:state.credential}]:[]):Array.from({length:state.count},()=>({id:binding}));
  const value={innerJoin:()=>value,where:()=>value,orderBy:()=>value,limit:()=>value,for:(lock:string)=>{state.events.push(table+'-'+lock);return value;},then:(resolve:any)=>{state.events.push(table);return Promise.resolve(result()).then(resolve);}};return value;};
 const tx={select:()=>({from:(table:any)=>query(getTableName(table))})},database={...tx,transaction:async(run:any)=>run(tx)};
 const service=new PostgresEmailImapSetupTargets(database as any,{now:()=>new Date(state.now),loadBinding:async(_tx,input)=>{state.events.push('legacy');state.late?.();return {binding:{id:binding,org_id:'org',owner_user_id:state.foreign?'other':'owner',target_key:'primary',app_version_id:'version',grant_snapshot_id:'grant',resource_key:'mail',consent_expires_at:new Date(10000),reviewed_at:new Date(500)},installation:{id:'installation'},registration:{operator_user_id:'owner'},epoch:state.graph,checked_at:new Date(state.now)} as any;},getRegistry:async()=>({select:()=>({pins:{org_id:'org',owner_user_id:'owner',installation_id:'installation',resource_binding_id:state.pinsChanged?'other':binding,target_key:'primary',app_version_id:'version',grant_snapshot_id:'grant',resource_key:'mail'}} as any)}),hasConstructors:()=>state.constructors});
 return {state,service};
}
test('reviewed IMAP targets have deterministic IDs and metadata only; graph/native/SID lock order holds',async()=>{
 const f=fixture(),view=await f.service.list(actor,'org');assert.equal(view.items.length,1);assert.match(view.items[0]!.account_id,/^imap_[a-f0-9]{64}$/);assert.equal(view.items[0]!.credential_revision,0);assert.equal(view.items[0]!.state,'available');assert.deepEqual(await f.service.list(actor,'org'),view);assert.doesNotMatch(JSON.stringify(view),/password|envelope|principal|constructor/);
 const legacy=f.state.events.indexOf('legacy'),native=f.state.events.indexOf('email_accounts-share'),sid=f.state.events.indexOf('web_sessions-share',legacy);assert.ok(legacy<native&&native<sid);
 f.state.accounts=[{account_id:'existing',provider:'imap_smtp',state:'paused'}];f.state.credential=2;const current=await f.service.list(actor,'org');assert.equal(current.items[0]!.account_id,'existing');assert.equal(current.items[0]!.credential_revision,2);assert.equal(current.items[0]!.state,'needs_attention');
});
test('foreign owner, stale registry pins and non-IMAP constructors never produce setup nominations',async()=>{
 for(const key of ['foreign','pinsChanged','constructors'] as const){const f=fixture();if(key==='constructors')f.state[key]=false;else f.state[key]=true;assert.equal((await f.service.list(actor,'org')).items.length,0);}
 const f=fixture();f.state.accounts=[{provider:'gmail',account_id:'wrong'},{provider:'imap_smtp',account_id:'second'}];assert.equal((await f.service.list(actor,'org')).items.length,0);
});
test('late revocation, member changes and expiry deny metadata after waits, including an empty scan',async()=>{
 for(const mutation of [(f:ReturnType<typeof fixture>)=>{f.state.session.revoked_at=new Date(1000);},(f:ReturnType<typeof fixture>)=>{f.state.member.version++;},(f:ReturnType<typeof fixture>)=>{f.state.now=10000;}]){const f=fixture();f.state.late=()=>mutation(f);await assert.rejects(f.service.list(actor,'org'),/EMAIL_ACCESS_DENIED/);}
 const empty=fixture();empty.state.count=0;empty.state.member.kind='agent';await assert.rejects(empty.service.list(actor,'org'),/EMAIL_ACCESS_DENIED/);
 const abort=fixture(),controller=new AbortController();controller.abort(Error('stopped'));await assert.rejects(abort.service.list(actor,'org',controller.signal),/stopped/);assert.equal(abort.state.events.length,0);
});
