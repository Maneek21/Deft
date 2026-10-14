import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createExperienceDataClient, appDataInputDigest } from './app-experience-data-client';
import { createExperienceBridge, type ExperiencePin, type ExperiencePort } from './app-experience-bridge';
import { AppDataRecordMetaSchema } from '../../../../packages/app-kit/src/app-data';

const installation='33333333-3333-4333-8333-333333333333',connection='22222222-2222-4222-8222-222222222222',hash='sha256:'+'a'.repeat(64);
const context={schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{session_id:connection,target_key:'sender',account:{account_ref:'owned',label:'Synthetic sender'},resource_key:'inbox',identities:[],stores:[{declaration:{schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400},consent:{consent_id:connection,consent_digest:hash,expires_at:new Date(Date.now()+60000).toISOString()}}]}]};
const pin:ExperiencePin={org_id:'org',user_id:'owner',app_installation_id:installation,app_version_id:'version',grant_snapshot_id:'grant',lifecycle_epoch:1,grant_epoch:1,session_id:'session_12345678',session_epoch:1};
class Port implements ExperiencePort {onmessage:((event:MessageEvent)=>void)|null=null;sent:any[]=[];postMessage(value:unknown){this.sent.push(value);}close(){}}
// Exercise the actual installed broker's closed projection, rather than a
// separately copied approximation. It is plain JS over already validated data.
const installed=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');
const start=installed.indexOf('const {presentation:_presentation,');
const returnStatement='return {...metadata,...(record?{record:{...record,account_target_key:owner.targetKey}}:{})};';
const end=installed.indexOf(returnStatement,start);
assert.ok(start>=0&&end>start,'Actual installed metadata projection located');
const project=new Function('result','request','AppDataRecordMetaSchema','owner',installed.slice(start,end+returnStatement.length));

test('validated unsupported search diagnostics reach the actual bounded Worker reply with no invented freshness or full content',async()=>{
 const search={status:'unsupported',original_query:'unsupported:synthetic',unsupported:[{index:0,field:'unsupported',reason:'This search field is unsupported.'}],limitations:['Provider-specific coverage applies.'],query_complete:false};
 const client=createExperienceDataClient({installationId:installation,targetKey:'sender',current:()=>true,fetch:async(path,options)=>{
  if((path.endsWith('/context')||path.endsWith('/resolve')))return Response.json(context);const request=JSON.parse(String(options.body));
  return Response.json({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',items:[],next_cursor:null,search,presentation:{content:'PRIVATE BODY'}});
 }});
 const verified=await client.request('drafts','resource_list',{store_key:'drafts',resource_key:'inbox',cursor:null,limit:10,query:search.original_query},new AbortController().signal);assert.deepEqual(verified.search,search);
 const port=new Port(),bridge=createExperienceBridge({port,pin,resourceKeys:['inbox'],storeKeys:['drafts'],actionKeys:[],onView:()=>{},broker:{isLive:()=>true,appData:async(_pin,key,value,signal)=>{
  const request=value as {operation:'resource_list';input:Record<string,unknown>};return project(await client.request(key,request.operation,request.input,signal),request,AppDataRecordMetaSchema,{targetKey:'sender'});
 }}});
 port.onmessage!({data:{version:'deft.experience_bridge.v1',kind:'request',session_id:pin.session_id,sequence:1,request_id:'request_1',operation:'app_data',key:'drafts',input:{operation:'resource_list',input:{store_key:'drafts',resource_key:'inbox',cursor:null,limit:10,query:search.original_query}}}} as MessageEvent);
 for(let i=0;i<20&&!port.sent.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(port.sent.length,1);const reply=port.sent[0];assert.equal(reply.ok,true,JSON.stringify(reply));assert.deepEqual(reply.output.search,search);assert.deepEqual(reply.output.items,[]);assert.equal(reply.output.next_cursor,null);assert.equal('freshness' in reply.output,false);assert.equal('presentation' in reply.output,false);assert.doesNotMatch(JSON.stringify(reply),/PRIVATE BODY/);assert.equal(bridge.active,true);bridge.revoke();
});
test('malformed search metadata and search diagnostic on a different operation are withheld by the real host data client',async()=>{
 for(const operation of ['resource_list','connection_metadata'] as const){
  let dispatched=false;const client=createExperienceDataClient({installationId:installation,targetKey:'sender',current:()=>true,fetch:async(path,options)=>{
   if((path.endsWith('/context')||path.endsWith('/resolve')))return Response.json(context);dispatched=true;const request=JSON.parse(String(options.body));return Response.json({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation,input_digest:await appDataInputDigest(operation,request.input),outcome:'completed',items:[],next_cursor:null,search:{status:'unsupported',original_query:'test',unsupported:[{index:null,field:null,reason:'Unsupported'}],limitations:[],query_complete:operation==='resource_list'}});
  }});
  await assert.rejects(client.request('drafts',operation,operation==='resource_list'?{store_key:'drafts',resource_key:'inbox',cursor:null,limit:10,query:'test'}:{store_key:'drafts'},new AbortController().signal));assert.equal(dispatched,true);
 }
});


test('current target routing avoids full-account metadata and re-resolves before each actual request',async()=>{
 const calls:string[]=[];let allowed=true;
 const client=createExperienceDataClient({installationId:installation,targetKey:'sender',current:()=>true,fetch:async(path,options)=>{
  calls.push(path);
  assert.ok(!path.endsWith('/context'),'normal data routing must not load every account or fetch provider identities');
  if(path.endsWith('/resolve')){
   assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(String(options.body)),{schema_version:'deft.app_data_resolve.v1',target_key:'sender',store_key:'drafts'});
   return allowed?Response.json(context):Response.json({error:'revoked'},{status:403});
  }
  assert.equal(path,`/api/app-data/connections/${connection}/requests`);
  const request=JSON.parse(String(options.body));return Response.json({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',items:[],next_cursor:null});
 }});
 await client.request('drafts','record_list',{store_key:'drafts',cursor:null,limit:10},new AbortController().signal);
 assert.equal(calls.length,2);allowed=false;
 await assert.rejects(client.request('drafts','record_list',{store_key:'drafts',cursor:null,limit:10},new AbortController().signal));
 assert.equal(calls.length,3,'revoked routing must not use a cached account or dispatch');
});
test('routing rejects mismatched or ambiguous account replies before content dispatch',async()=>{
 for(const targets of [[],[...context.targets,...context.targets],[{...context.targets[0],target_key:'foreign'}],[{...context.targets[0],stores:[]}]]){
  let calls=0;const client=createExperienceDataClient({installationId:installation,targetKey:'sender',current:()=>true,fetch:async path=>{calls++;assert.ok(path.endsWith('/resolve'));return Response.json({...context,targets});}});
  await assert.rejects(client.request('drafts','record_list',{store_key:'drafts',cursor:null,limit:10},new AbortController().signal));assert.equal(calls,1);
 }
});
