import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';
import type {AppDataRequest,DeftExperienceRecordFormNode,RecordStoreDeclaration} from '../../../../packages/app-kit/src/app-data';
import type {ExperienceRecordOpening} from '../components/apps/experience-record-form';

// The locator writes only opaque UUIDs. Node has no IndexedDB, so this test
// supplies the same tiny key/value surface the browser implementation uses.
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
const expires=new Date(Date.now()+60000).toISOString(),date=new Date().toISOString();
const store:RecordStoreDeclaration={schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'library',runtime_requirement_key:'sync_provider',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400};
const marker={schema_version:'example.source_seed.v1',source:{resource_key:'library',record_id:connection,content_digest:hash}};
const initial={to:'sender@example.test',subject:'Re: Thread',body:'Quoted body',body_html:'',attachments:[],record_seed:marker};
const node:DeftExperienceRecordFormNode={kind:'record_form',id:'form',label:'Draft',store_key:'drafts',record_id:id,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),
 seed:{schema_version:'deft.record_form_seed.v1',value:initial},
 profile:{schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}}};
const context=(target='primary',declaration:RecordStoreDeclaration=store)=>({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{session_id:connection,target_key:target,account:{account_ref:id,label:'Own'},resource_key:'library',identities:[{address:'own@example.test',label:'Own'}],stores:[{declaration,consent:{consent_id:id,consent_digest:hash,expires_at:expires}}]}]});
const row=(status:'draft'|'submitted'|'archived'='draft')=>({schema_version:'deft.app_record.v1',store_key:'drafts',record_id:id,revision:7,content_revision:4,content_digest:hash,status,value:initial,files:[],created_at:date,updated_at:date});
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function completed(request:AppDataRequest,record?:unknown){
 const base={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};
 return record?{...base,record}:base;
}
async function result(request:AppDataRequest,record?:unknown){
 return record?completed(request,record):{...await completed(request),outcome:'not_found'};
}
function harness(){
 let resolves=0,invokes=0,inFlight=0,maxInFlight=0,order=0;const operations:string[]=[],invokePaths:string[]=[],hops:{operation:string;start:number;end:number}[]=[];
 const fetch=async(path:string,options:RequestInit)=>{
  if(path.endsWith('/resolve')||path.endsWith('/context')){resolves++;return json(context());}
  assert.ok(path.endsWith('/requests'),path);
  const request=JSON.parse(String(options.body)) as AppDataRequest;invokes++;operations.push(request.operation);invokePaths.push(path);
  const start=++order;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
  await new Promise<void>(resolve=>setTimeout(resolve,5));inFlight--;
  hops.push({operation:request.operation,start,end:++order});
  if(request.operation==='record_read')return json(await result(request));
  if(request.operation==='record_create')return json(await completed(request,{...row(),revision:1,content_revision:1,value:request.input.value}));
  if(request.operation==='connection_metadata')return json({...await completed(request),record_seed_value:initial,identities:[{address:'own@example.test',label:'Own'}]});
  throw Error('unexpected '+request.operation);
 };
 return {fetch,counts:()=>({resolves,invokes,operations:[...operations],invokePaths:[...invokePaths],maxInFlight,hops:[...hops]}),reset:()=>{resolves=0;invokes=0;operations.length=0;invokePaths.length=0;hops.length=0;maxInFlight=0;}};
}

test('reply seed opens with one resolve and two runtime invocations',async()=>{
 const h=harness(),signal=new AbortController().signal;
 const client=createExperienceDataClient({installationId:installation,targetKey:'primary',accountRef:()=>id,principal:{orgId:id,userId:connection},current:()=>true,fetch:h.fetch});
 const [seed,load]=await Promise.allSettled([client.ports.resolveSeed!(node,signal),client.ports.load(node,signal)]);
 assert.equal(seed.status,'fulfilled');assert.equal(load.status,'fulfilled');
 const counts=h.counts();
 assert.equal(counts.resolves,1,'one opening resolve for the whole handshake');
 assert.equal(counts.invokes,2,'fresh-draft read + seed metadata only');
 assert.deepEqual(counts.operations.sort(),['connection_metadata','record_read']);
 assert.equal(counts.maxInFlight,2,'both invocations are in flight together');
 const overlap=counts.hops.length===2&&Math.max(...counts.hops.map(h=>h.start))<Math.min(...counts.hops.map(h=>h.end));
 assert.equal(overlap,true,'neither invocation resolves before the other starts');
 assert.ok(counts.invokePaths.every(path=>path.includes(`/connections/${connection}/requests`)),'both invocations share the resolved target');
 if(load.status!=='fulfilled')throw Error('unreachable');
 const opening=(load.value as Omit<ExperienceRecordOpening,'node'>).openingRecovery;
 assert.ok(opening,'load returns the opening recovery scope');
 assert.equal(opening.scope.accountId,id);assert.equal(opening.scope.resourceTargetKey,'primary');assert.equal(opening.scope.recordId,id);assert.equal(opening.scope.stateKey,'drafts');
 assert.ok(opening.expiresAt>Date.now());
 // The form prefers openingRecovery, so the fallback recoveryScope resolve is never needed.
 assert.equal(h.counts().resolves,1,'no recoveryScope resolve is required for the opening');
});

test('opening target is not reused across two openings',async()=>{
 const realNow=Date.now;let now=realNow();Date.now=()=>now;
 try{
  const h=harness(),signal=new AbortController().signal;
  const client=createExperienceDataClient({installationId:installation,targetKey:'primary',accountRef:()=>id,principal:{orgId:id,userId:connection},current:()=>true,fetch:h.fetch});
  await client.ports.load(node,signal);assert.equal(h.counts().resolves,1);
  now+=6000;
  await client.ports.load(node,signal);assert.equal(h.counts().resolves,2,'a later opening resolves a fresh target');
 }finally{Date.now=realNow;}
});

test('a save clears the opening target',async()=>{
 const h=harness(),signal=new AbortController().signal;
 const client=createExperienceDataClient({installationId:installation,targetKey:'primary',accountRef:()=>id,principal:{orgId:id,userId:connection},current:()=>true,fetch:h.fetch});
 await client.ports.load(node,signal);
 await client.ports.save(node,0,initial,id,node.content_digest,signal);
 const before=h.counts().resolves;
 await client.ports.load(node,signal);
 assert.equal(h.counts().resolves,before+1,'a mutation invalidates the opening target');
});

test('an account switch during the opening rejects before dispatch',async()=>{
 const h=harness(),signal=new AbortController().signal;let expected=id,requests=0;
 const client=createExperienceDataClient({installationId:installation,targetKey:'primary',accountRef:()=>expected,principal:{orgId:id,userId:connection},current:()=>true,fetch:async(path,options)=>{if(path.endsWith('/requests'))requests++;return h.fetch(path,options);}});
 await client.ports.load(node,signal);expected=connection;requests=0;
 await assert.rejects(client.ports.load(node,signal),/account|target|store|scope/i);
 assert.equal(requests,0,'no runtime invocation is dispatched after the account pin changes');
 const other=harness();let secondExpected=id;
 const second=createExperienceDataClient({installationId:installation,targetKey:'primary',accountRef:()=>secondExpected,principal:{orgId:id,userId:connection},current:()=>true,fetch:other.fetch});
 await second.ports.load(node,signal);secondExpected=connection;
 await assert.rejects(second.ports.resolveSeed!(node,signal),/account|target|store|scope/i);
 assert.equal(other.counts().invokes,2,'the locator never reaches storage after the account pin changes');
});

test('new-compose opening with a signature default stays within two resolves and four invocations',async()=>{
 const h=harness(),signal=new AbortController().signal;
 const destination={...store,record_changes:[{key:'signature_default',source_store_key:'signatures'}]};
 const source={...store,key:'signatures',max_record_bytes:65536,max_files:0,max_file_bytes:1,max_total_file_bytes:1};
 const composeNode={...node,initial_change:{operation_key:'signature_default',source_store_key:'signatures',source_identity_field:'address'}};
 const twoStores=()=>({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{session_id:connection,target_key:'primary',account:{account_ref:id,label:'Own'},resource_key:'library',identities:[{address:'own@example.test',label:'Own'}],stores:[{declaration:destination,consent:{consent_id:id,consent_digest:hash,expires_at:expires}} ,{declaration:source,consent:{consent_id:id,consent_digest:hash,expires_at:expires}}]}]});
 let resolves=0,invokes=0;
 const client=createExperienceDataClient({installationId:installation,targetKey:'primary',accountRef:()=>id,principal:{orgId:id,userId:connection},current:()=>true,fetch:async(path,options)=>{
  if(path.endsWith('/resolve')||path.endsWith('/context')){resolves++;return json(twoStores());}
  const request=JSON.parse(String(options.body)) as AppDataRequest;invokes++;
  if(request.operation==='record_read')return json(await result(request));
  if(request.operation==='connection_metadata')return json({...await completed(request),record_seed_value:initial,identities:[{address:'own@example.test',label:'Own'}]});
  throw Error('unexpected '+request.operation);
 }});
 const [seed,load]=await Promise.allSettled([client.ports.resolveSeed!(composeNode,signal),client.ports.load(composeNode,signal)]);
 assert.equal(seed.status,'fulfilled');assert.equal(load.status,'fulfilled');
 assert.equal(resolves,1,'the signature default shares the opening resolve');
 assert.equal(invokes,3,'record read + destination metadata + source default');
 assert.ok(resolves<=2&&invokes<=4);
});
