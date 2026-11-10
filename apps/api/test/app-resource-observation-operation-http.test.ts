import assert from 'node:assert/strict';
import test,{mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {drizzle} from 'drizzle-orm/node-postgres';
import {Hono} from 'hono';
// Ported from wip a2ea3394: the public observation route reaches ONE runner
// operation through the v3 channel, with no separate heartbeat call.
process.env.DATABASE_URL='postgresql://fixture@127.0.0.1:1/operation_http_no_database';
process.env.ENCRYPTION_KEY='synthetic-operation-http-key-only32';
const ring=(name:string)=>({current:name,keys:{[name]:Buffer.alloc(32,name.charCodeAt(0)).toString('base64')}});
process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',
 run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fingerprint')});
Object.assign(process.env,{DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',
 DEFT_APP_OWNER_CONNECTIONS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true'});
const {AppAttachmentSyncChannel}=await import('../src/lib/app-attachment-sync-channel.js');
const {hashAppAttachmentSessionToken}=await import('../src/lib/app-attachment-policy.js');
const token='a'.repeat(43),org=randomUUID(),binding=randomUUID(),session=randomUUID();
let locators=0,missing=false,runnerCalls=0,heartbeatCalls=0,lastInput:any;
const database=drizzle({client:{async query(config:{text:string},params:unknown[]){
 locators++;assert.ok(config.text.includes('"app_runtime_sessions"."audience"'));
 assert.ok(config.text.includes('"app_runtime_sessions"."runtime_binding_id" is null'));
 assert.ok(params.includes(session));assert.ok(params.includes(hashAppAttachmentSessionToken(token)));
 assert.ok(params.includes('app_resource_sync'));assert.ok(!params.includes(token));
 return {rows:missing?[]:[[org,binding,hashAppAttachmentSessionToken(token)]]};
}} as never});
const bounded={transaction:async(work:(tx:any)=>Promise<any>)=>work(database)};
const channel=new AppAttachmentSyncChannel({
 async resourceObservationAuthority(input:any){runnerCalls++;lastInput=input;return {...input.request,allowed:true};},
 async heartbeatResourceSyncAttempt(){heartbeatCalls++;return {run_id:randomUUID()};},
} as never,bounded as never);
mock.module(new URL('../src/lib/app-attachment-runtime.ts',import.meta.url).href,{namedExports:{
 getAppAttachmentRuntime:async()=>({channel}),shutdownAppAttachmentRuntime:async()=>{},
}});
const {appResourceObservationRoutes}=await import('../src/routes/app-resource-observations.js');
const app=new Hono().route('/observations',appResourceObservationRoutes);
const request=()=>({schema_version:'deft.app_resource_observation_authority.v1',audience:'app_resource_sync',session_id:session,
 run_id:randomUUID(),attempt_id:randomUUID(),claim_token:randomUUID(),sequence:1,expires_at:new Date(Date.now()+15000).toISOString()});
function reset(){locators=0;runnerCalls=0;heartbeatCalls=0;missing=false;lastInput=undefined;}
const post=(value:unknown,authorization='AppRuntime '+token,extra:Record<string,string>={},suffix='')=>app.request('/observations/runtime/authority'+suffix,
 {method:'POST',headers:{'content-type':'application/json',authorization,...extra},body:JSON.stringify(value)});

test('public HTTP route and channel derive exact organization/token identity without the old separate heartbeat',async()=>{
 reset();const value=request(),response=await post(value);
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(locators,1);assert.equal(runnerCalls,1);assert.equal(heartbeatCalls,0);
 assert.deepEqual(lastInput,{org_id:org,token_hash:hashAppAttachmentSessionToken(token),request:value});
 assert.equal((await response.json()).allowed,true);
});

test('HTTP rejects cookies, wrong token syntax, body scope nomination and expired/overlong authority before locator',async()=>{
 for(const [value,auth,headers,status,suffix] of [
  [request(),'Bearer '+token,{},403,''],[request(),'AppRuntime bad',{},403,''],
  [request(),'AppRuntime '+token,{cookie:'sid=synthetic'},403,''],
  [{...request(),org_id:org},'AppRuntime '+token,{},400,''],
  [{...request(),expires_at:new Date(Date.now()-1).toISOString()},'AppRuntime '+token,{},403,''],
  [{...request(),expires_at:new Date(Date.now()+60000).toISOString()},'AppRuntime '+token,{},403,''],
  [request(),'AppRuntime '+token,{},400,'?unexpected=true'],
 ] as const){reset();assert.equal((await post(value,auth,headers,suffix)).status,status);assert.equal(locators,0);assert.equal(runnerCalls,0);}
});

test('denied runner operation maps to 403 without a second call',async()=>{
 reset();const original=channel.resourceObservationAuthority.bind(channel);
 (channel as any).resourceObservationAuthority=async()=>null;
 try{const response=await post(request());assert.equal(response.status,403);assert.equal((await response.json()).code,'APP_ACCESS_DENIED');}
 finally{(channel as any).resourceObservationAuthority=original;}
 assert.equal(heartbeatCalls,0);
});

test('channel revalidates the closed envelope and locator absence never calls the operation',async()=>{
 reset();await assert.rejects(channel.resourceObservationAuthority({...request(),skip_guard:true},token));assert.equal(locators,0);
 assert.equal(await channel.resourceObservationAuthority(request(),'bad'),null);assert.equal(locators,0);
 missing=true;assert.equal(await channel.resourceObservationAuthority(request(),token),null);assert.equal(locators,1);assert.equal(runnerCalls,0);
});

test('generic channel heartbeat remains a distinct unchanged v3 entrance',async()=>{
 reset();const {expires_at,schema_version,...value}=request();
 assert.ok(await channel.heartbeat({...value,schema_version:'deft.app_runtime_channel.v3',session_token:token}));
 assert.equal(locators,1);assert.equal(heartbeatCalls,1);assert.equal(runnerCalls,0);
});
