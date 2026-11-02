import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';
import type {AppDataRequest,DeftExperienceRecordFormNode,RecordStoreDeclaration} from '../../../../packages/app-kit/src/app-data';

// Synthetic-latency guard for the 2 s compose-open target. The numbers model the
// plan's p50 authority cost: one resolve ~= 2 admissions, one invocation ~= 4
// admissions + a runtime callback, and one provider read for the source seed.
const RESOLVE_MS=700,INVOKE_MS=900,PROVIDER_MS=300;

type SeedRow={id:string;owner:string;recordId:string};
function fakeIndexedDb(){
 const stores=new Map<string,Map<string,SeedRow>>();
 const open=()=>{
  const request:any={};
  queueMicrotask(()=>{
   const database:any={
    createObjectStore:(name:string)=>{if(!stores.has(name))stores.set(name,new Map());return {keyPath:'id'};},
    close:()=>{},
    transaction:(name:string)=>{
     const data=stores.get(name)!;let pending=0,aborted=false;const tx:any={};
     const settle=()=>{if(!aborted&&pending===0)queueMicrotask(()=>{if(!aborted)tx.oncomplete?.();});};
     const read=(run:(request:any)=>void)=>{pending++;const result:any={};queueMicrotask(()=>{run(result);result.onsuccess?.();pending--;settle();});return result;};
     const table={
      get:(id:string)=>read(result=>{result.result=data.get(id);}),
      getAll:()=>read(result=>{result.result=[...data.values()];}),
      add:(row:SeedRow)=>{data.set(row.id,row);},
      delete:(id:string)=>{data.delete(id);},
     };
     tx.objectStore=()=>table;
     tx.abort=()=>{aborted=true;queueMicrotask(()=>tx.onabort?.());};
     return tx;
    },
   };
   request.result=database;request.onupgradeneeded?.();request.onsuccess?.();
  });
  return request;
 };
 return {open};
}
(globalThis as unknown as {indexedDB:unknown}).indexedDB=fakeIndexedDb();

const id='11111111-1111-4111-8111-111111111111',connection='22222222-2222-4222-8222-222222222222',installation='33333333-3333-4333-8333-333333333333',hash='sha256:'+'a'.repeat(64);
const expires=new Date(Date.now()+60000).toISOString();
const store:RecordStoreDeclaration={schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'library',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400};
const marker={schema_version:'example.source_seed.v1',source:{resource_key:'library',record_id:connection,content_digest:hash}};
const initial={to:'sender@example.test',subject:'Re: Thread',body:'Quoted body',body_html:'',attachments:[],record_seed:marker};
const node:DeftExperienceRecordFormNode={kind:'record_form',id:'form',label:'Draft',store_key:'drafts',record_id:id,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),
 seed:{schema_version:'deft.record_form_seed.v1',value:initial},
 profile:{schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}}};
const context=()=>({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{session_id:connection,target_key:'primary',account:{account_ref:id,label:'Own'},resource_key:'library',identities:[{address:'own@example.test',label:'Own'}],stores:[{declaration:store,consent:{consent_id:id,consent_digest:hash,expires_at:expires}}]}]});
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function completed(request:AppDataRequest){
 return {schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};
}
async function result(request:AppDataRequest){
 return {...await completed(request),outcome:'not_found'};
}

test('synthetic opening latency stays under 2.2 s',async()=>{
 let resolves=0,invokes=0;
 const fetch=async(path:string,options:RequestInit)=>{
  if(path.endsWith('/resolve')||path.endsWith('/context')){resolves++;await wait(RESOLVE_MS);return json(context());}
  assert.ok(path.endsWith('/requests'),path);
  const request=JSON.parse(String(options.body)) as AppDataRequest;invokes++;
  await wait(INVOKE_MS+(request.operation==='connection_metadata'?PROVIDER_MS:0));
  if(request.operation==='record_read')return json(await result(request));
  if(request.operation==='connection_metadata')return json({...await completed(request),record_seed_value:initial,identities:[{address:'own@example.test',label:'Own'}]});
  throw Error('unexpected '+request.operation);
 };
 const signal=new AbortController().signal,client=createExperienceDataClient({installationId:installation,targetKey:'primary',accountRef:()=>id,principal:{orgId:id,userId:connection},current:()=>true,fetch});
 const started=performance.now();
 const [seed,load]=await Promise.allSettled([client.ports.resolveSeed!(node,signal),client.ports.load(node,signal)]);
 const wall_ms=Math.round(performance.now()-started);
 console.log(JSON.stringify({event:'compose_open',resolves,invokes,wall_ms}));
 assert.equal(seed.status,'fulfilled');assert.equal(load.status,'fulfilled');
 assert.equal(resolves,1);assert.equal(invokes,2);
 assert.ok(wall_ms<2200,`opening took ${wall_ms} ms`);
});
