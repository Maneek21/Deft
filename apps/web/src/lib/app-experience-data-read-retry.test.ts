import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';

const installation='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222',account='33333333-3333-4333-8333-333333333333',hash='sha256:'+'a'.repeat(64);
const declaration={schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'inbox',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400};
const expiry=new Date(Date.now()+600000).toISOString();
const context=()=>({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{target_key:'primary',session_id:session,account:{account_ref:account,label:'Fixture'},resource_key:'inbox',identities:[],stores:[{declaration,consent:{consent_id:account,consent_digest:hash,expires_at:expiry}}]}]});
const denied=(prefix='EMAIL')=>Response.json({error:'The app Runtime could not confirm current permission for this data.',code:'APP_RUNTIME_ACCESS_DENIED',details:{runtime_code:prefix+'_RUNTIME_AUTHORITY_DENIED'}},{status:403});
const input={store_key:'drafts',resource_key:'inbox',cursor:null,limit:10,query:'Deft Email Stage 1'};
const match={record_id:account,content_digest:hash,revision:'provider-r1',label:'Deft Email Stage 1 matching message',data:{subject:'Deft Email Stage 1 matching message'},tombstone:false,membership_generation:1,checkpoint_generation:1};

test('a resource list read quietly retries one transient failure under a fresh identical account and consent',async()=>{
 for(const unavailable of [denied,()=>denied('APPLET'),()=>Response.json({error:'App data request unavailable',code:'APP_PROVIDER_UNAVAILABLE'},{status:503})]){
  let resolutions=0;const requests:Array<{request_id:string;operation:string;input:Record<string,unknown>}>=[];
  const client=createExperienceDataClient({installationId:installation,targetKey:'primary',current:()=>true,fetch:async(path,options)=>{
   if(path.endsWith('/resolve')){resolutions++;return Response.json(context());}
   const request=JSON.parse(String(options.body));requests.push(request);if(requests.length===1)return unavailable();
   return Response.json({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',items:[match],next_cursor:null,search:{status:'supported',original_query:input.query,unsupported:[],limitations:[],query_complete:true}});
  }});
  const result=await client.request('drafts','resource_list',input,new AbortController().signal);assert.equal(result.outcome,'completed');assert.equal(result.items?.[0].record_id,match.record_id);assert.equal(result.search?.original_query,input.query);
  assert.equal(resolutions,2);assert.equal(requests.length,2);assert.notEqual(requests[0].request_id,requests[1].request_id);assert.deepEqual(requests[0].input,requests[1].input);
 }
});

test('a read retry cannot cross changed account, connection, declaration, consent or ended local authority',async()=>{
 for(const change of ['account','session','policy','consent','expiry','local','forbidden'] as const){let resolutions=0,requests=0,live=true;
  const client=createExperienceDataClient({installationId:installation,targetKey:'primary',current:()=>live,fetch:async(path)=>{
   if(path.endsWith('/resolve')){resolutions++;const value=context();if(resolutions===2){const target=value.targets[0];if(change==='account')target.account.account_ref=installation;if(change==='session')target.session_id=installation;if(change==='policy')target.stores[0].declaration={...declaration,max_files:1};if(change==='consent')target.stores[0].consent.consent_id=installation;if(change==='expiry')target.stores[0].consent.expires_at=new Date(Date.parse(expiry)+1000).toISOString();}return Response.json(value);}
   requests++;if(change==='local')live=false;return change==='forbidden'?Response.json({error:'Access ended',code:'APP_ACCESS_DENIED'},{status:403}):denied();
  }});
  await assert.rejects(client.request('drafts','resource_list',input,new AbortController().signal));assert.equal(requests,1);if(change==='local'||change==='forbidden')assert.equal(resolutions,1);
 }
});

test('failed writes and repeatedly unavailable reads are never replayed indefinitely',async()=>{
 for(const operation of ['record_create','resource_list'] as const){let requests=0;const client=createExperienceDataClient({installationId:installation,targetKey:'primary',current:()=>true,fetch:async(path)=>{
  if(path.endsWith('/resolve'))return Response.json(context());requests++;return denied();
 }});await assert.rejects(client.request('drafts',operation,operation==='resource_list'?input:{store_key:'drafts',record_id:installation,value:{}},new AbortController().signal));assert.equal(requests,operation==='resource_list'?2:1);}
});
