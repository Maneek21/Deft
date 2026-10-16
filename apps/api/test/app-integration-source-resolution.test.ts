import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createAppIntegrationSource} from '../src/lib/app-integration-source.js';
import {AppIntegrationSourceIdentitySchema} from '../../../packages/app-kit/src/app-integration-source.js';
// Execute the real component closure with only DB/public transport ports replaced.
const source=readFileSync(new URL('../src/lib/app-integration-capture-runtime.ts',import.meta.url),'utf8');
const begin=source.indexOf(' const components='),end=source.indexOf('\n const human=components()',begin);
assert.ok(begin>=0&&end>begin);
const make=new Function('input','publication','now','denied','policyGuard','createAppIntegrationSource','createAppIntegrationSourceDispatcher','AppIntegrationSourceIdentitySchema',stripTypeScriptTypes(source.slice(begin,end),{mode:'transform'})+';return components;');
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash='sha256:'+'a'.repeat(64);
function fixture(change?:string){
 const caller={org_id:id(1),user_id:id(2),kind:'human',principal_id:id(3)},identity={installation_id:id(4),account_ref:'account_one',store_key:'drafts',ref:{resource_key:'inbox',record_id:id(7),content_digest:hash}},target={...identity,resource_binding_id:id(5),projection_id:id(6)};
 const resource={record_id:id(7),content_digest:hash,revision:'provider_revision',label:'Observed source',data:{logical_message_id:'opaque_app_identity'},tombstone:false,membership_generation:1,checkpoint_generation:1};
 const ops:string[]=[],published={target,checkpoint_id:id(16),generation:1,cursor_sequence:1,projection_revision:'revision',applied_sequence:1,payload_digest:hash,observed_at:'2026-10-16T04:00:00Z',partial:true};let revoked=false,bodyRead=false;
 const publication=Object.assign(async()=>({...published,...(change==='publication_changed'&&bodyRead?{cursor_sequence:2}:{})}),{resolve:async(_caller:unknown,_identity:unknown,_binding:unknown,value:typeof resource)=>{assert.equal(value.record_id,identity.ref.record_id);assert.equal(value.content_digest,identity.ref.content_digest);return target;}});
 const gateway={currentAccount:async()=>{if(revoked)throw Error('revoked');return {resource_binding_id:target.resource_binding_id,resource_key:'inbox',identity:'current-authority',expires_at:Date.now()+60000};}};
 const dispatcher=(_ports:unknown,content='presentation')=>async(_caller:unknown,_target:unknown,_purpose:unknown,signal?:AbortSignal)=>{
  signal?.throwIfAborted();ops.push(content);if(change==='revoked_after_resolve')revoked=true;if(content==='presentation')bodyRead=true;if(change==='metadata_unavailable')throw Error('metadata unavailable');
  return {resource:{...resource,...(change==='content_changed'&&bodyRead?{content_digest:'sha256:'+'b'.repeat(64)}:{})},presentation:content==='metadata'?{}:{plain_text:'Exact current source body'}};
 };
 const components=make({gateway,transaction:async(fn:any)=>fn({})},publication,Date.now,()=>Error('denied'),async()=>{},createAppIntegrationSource,dispatcher,AppIntegrationSourceIdentitySchema);
 const c=components();return {ops,caller,identity,metadata:components(undefined,'metadata'),human:c,deny:()=>{revoked=true},changePublication:()=>{published.cursor_sequence++},run:async(purpose:'read'|'transfer'='read')=>{const resolved=await c.resolve(caller,identity,purpose);return c.source.read(caller,resolved,purpose);}};
}
test('actual source opening resolves metadata once and reads presentation once without discarded body reads',async()=>{
 const f=fixture(),snapshot=await f.run();assert.deepEqual(f.ops,['metadata','presentation']);assert.equal(snapshot.presentation.plain_text,'Exact current source body');assert.ok(Object.isFrozen(snapshot.presentation));
});
test('metadata resolve retains current authority, exact content and publication checks',async()=>{
 for(const change of ['revoked_after_resolve','content_changed','publication_changed'])await assert.rejects(fixture(change).run(),change);
});

test('checked transfer navigation reuses the issued source and retains final guards',async()=>{
 const begin=source.indexOf(' const openSnapshot='),end=source.indexOf('\n const openIdentity=',begin);assert.ok(begin>=0&&end>begin);
 const makeNavigation=new Function('input','human','denied','and','eq','appVersions','appInstallations',stripTypeScriptTypes(source.slice(begin,end),{mode:'transform'})+';return openSnapshot;');
 for(const mode of ['current','revoked','changed_publication','foreign','forged']){
  const f=fixture(),snapshot=await f.run('transfer'),before=f.ops.length;
  if(mode==='revoked')f.deny();if(mode==='changed_publication')f.changePublication();
  const tx={select:()=>({from:()=>({innerJoin:()=>({where:()=>({limit:async()=>[{manifest:{record_stores:[{key:'drafts',source_projection:{navigation_entry_key:'main'}}],experiences:[{key:'main'}]}}]})})})})};
  const open=makeNavigation({transaction:async(fn:any)=>fn(tx)},f.human,()=>Error('denied'),()=>true,()=>true,{},{});
  if(mode==='current')assert.match(await open(f.caller,snapshot),/source_digest=/);else await assert.rejects(open(mode==='foreign'?{...f.caller,user_id:id(99)}:f.caller,mode==='forged'?structuredClone(snapshot):snapshot));
  assert.equal(f.ops.length,before,'navigation must not fetch another metadata/presentation pair');
 }
});

test('actual Task opening reuses checked status rather than reading the source twice',async()=>{
 const code=readFileSync(new URL('../src/lib/app-integration-destination-runtime.ts',import.meta.url),'utf8'),begin=code.indexOf('async openSource('),end=code.indexOf('}};}',begin);assert.ok(begin>=0&&end>begin);
 const body=stripTypeScriptTypes(code.slice(begin,end+1).replace('async openSource(','async function openSource('),{mode:'transform'}),snapshot={issued:true},events:string[]=[];
 const open=new Function('db','receipts','and','eq','service','shared',body+';return openSource;')({select:()=>({from:()=>({where:()=>({limit:async()=>[{destination:{kind:'task'},source:{}}]})})})},{},()=>true,()=>true,{statusWithSource:async()=>{events.push('checked-status');return {snapshot,result:{}};},status:async()=>{throw Error('duplicate status');}},{openSnapshot:async(_c:unknown,s:unknown)=>{assert.equal(s,snapshot);events.push('final-navigation');return '/apps/source';},openIdentity:async()=>{throw Error('second source read');}});
 assert.equal(await open({},id(1)),'/apps/source');assert.deepEqual(events,['checked-status','final-navigation']);
});

function policyFlow(f:ReturnType<typeof fixture>){
 const begin=source.indexOf('  async settings('),end=source.indexOf('  async related(',begin);assert.ok(begin>=0&&end>begin);let stores=0;
 const code=stripTypeScriptTypes('const flow={'+source.slice(begin,end)+'};',{mode:'transform'})+';return flow;';
 const store={settings:async()=>{stores++;return {configured:true};},writePolicy:async(_caller:unknown,_target:unknown,_policy:unknown,guard:(tx:unknown)=>Promise<void>)=>{await guard({});stores++;return {saved:true};}};
 const flow=new Function('input','metadata','human','store','readIdentity','schedule',code)({transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn({})},f.metadata,{source:{guard:()=>{throw Error('Wrong issued snapshot authority');}}},store,()=>{throw Error('Unexpected presentation read');},()=>{throw Error('No job dispatched in read test');});
 return {flow,stores:()=>stores};
}
test('actual Knowledge settings and policy write need exact current metadata without source presentation',async()=>{
 for(const method of ['settings','write']){const f=fixture(),p=policyFlow(f);await p.flow[method](f.caller,f.identity,{enabled:false});assert.deepEqual(f.ops,['metadata','metadata']);assert.equal(p.stores(),1);}
});
test('metadata-only policy reads and writes still deny revoked or changed source before store access',async()=>{
 for(const method of ['settings','write'])for(const reason of ['revoked','metadata_unavailable','revoked_after_resolve']){const f=fixture(reason==='revoked'?undefined:reason),p=policyFlow(f);if(reason==='revoked')f.deny();await assert.rejects(p.flow[method](f.caller,f.identity,{enabled:false}),reason==='metadata_unavailable'?/metadata unavailable/:/revoked/);assert.equal(p.stores(),0);}
});

test('actual missing-AI capture guard defers before source candidate, claim or budget work',async()=>{
 const begin=source.indexOf('  async run('),end=source.indexOf('\n  },',begin);assert.ok(begin>=0&&end>begin);
 const code=stripTypeScriptTypes('const flow={'+source.slice(begin,end+5)+'};',{mode:'transform'})+';return flow.run;';
 const events:string[]=[],row={id:id(1),org_id:id(2),owner_user_id:id(3),revision:1};
 class Retry extends Error{constructor(message:string,readonly delay:number){super(message);}}
 const tx={select:()=>({from:()=>({where:()=>({limit:async()=>[row]})})})};
 const run=new Function('input','policies','and','eq','policyGuard','hasAnyAIProvider','RetryLaterJobError','APP_INTEGRATION_CAPTURE_JOB','denied',code)({transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn(tx),gateway:{currentAccount:async()=>{assert.fail('no source dispatch while AI unavailable');}}},{},()=>true,()=>true,async()=>{events.push('current-policy');},async(org:string)=>{assert.equal(org,row.org_id);events.push('provider');return false;},Retry,'capture',()=>Error('denied'));
 await assert.rejects(run({id:id(4),name:'capture',lockToken:'current-lock',data:{policy_id:row.id,policy_revision:1}}),(error:unknown)=>error instanceof Retry&&error.delay===60000);assert.deepEqual(events,['current-policy','provider']);
});
