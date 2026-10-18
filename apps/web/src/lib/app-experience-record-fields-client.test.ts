import assert from 'node:assert/strict';import test from 'node:test';
import {createExperienceDataClient,appDataInputDigest} from './app-experience-data-client';
import type {DeftExperienceRecordFormV2Node} from '../../../../packages/app-kit/src/app-data';
const id='11111111-1111-4111-8111-111111111111',installation='22222222-2222-4222-8222-222222222222',session='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444',hash='sha256:'+'a'.repeat(64),date=new Date().toISOString();
const node:DeftExperienceRecordFormV2Node={kind:'record_form',id:'settings',label:'Settings',record_id:id,store_key:'templates',expected_revision:1,content_digest:hash,profile:{schema_version:'deft.record_form_profile.v2',max_record_bytes:65536,fields:[{kind:'text',field:'title',label:'Title',required:true,max_characters:120}]}};
const value={title:'saved'},row={schema_version:'deft.app_record.v1',store_key:'templates',record_id:id,revision:2,content_revision:2,content_digest:hash,status:'draft',value,files:[],created_at:date,updated_at:date};
const store={schema_version:'deft.app_record_store.v1',key:'templates',resource_key:'mail',runtime_requirement_key:'sync_provider',max_record_bytes:65536,max_files:0,max_file_bytes:26214400,max_total_file_bytes:26214400};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const context=(declaration=store)=>({schema_version:'deft.app_data_context.v1',installation_id:installation,targets:[{target_key:'sender',session_id:session,account:{account_ref:id,label:'Synthetic'},resource_key:'mail',identities:[],stores:[{declaration,consent:{consent_id:id,consent_digest:hash,expires_at:new Date(Date.now()+60000).toISOString()}}]}]});
test('original save status pins operation/input/record/revision/digest before reading recovered values',async()=>{
 const input={store_key:'templates',record_id:id,expected_revision:1,expected_content_digest:hash,value},inputDigest=await appDataInputDigest('record_save',input);
 for(const change of [{},{operation:'file_upload'},{input_digest:'sha256:'+'b'.repeat(64)},{record_id:installation},{revision:3},{content_digest:'sha256:'+'b'.repeat(64)},{state:'indeterminate'}]){
  const calls:string[]=[],client=createExperienceDataClient({installationId:installation,targetKey:'sender',current:()=>true,fetch:async(path,options)=>{
   if((path.endsWith('/context')||path.endsWith('/resolve')))return json(context());const request=JSON.parse(String(options.body));calls.push(request.operation);const result={schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed'};
   return json(request.operation==='request_status'?{...result,request_status:{request_id:requestId,operation:'record_save',input_digest:inputDigest,state:'completed',record_id:id,revision:2,content_digest:hash,...change}}:{...result,record:row});}});
  const task=client.ports.saveStatus!(node,1,value,requestId,hash,new AbortController().signal);
  if(!Object.keys(change).length){assert.equal((await task)?.revision,2);assert.deepEqual(calls,['request_status','record_read']);}
  else if(change.state){assert.equal(await task,null);assert.deepEqual(calls,['request_status']);}
  else {await assert.rejects(task);assert.equal(calls.includes('record_save'),false);if(!change.content_digest)assert.deepEqual(calls,['request_status']);}
 }
});
test('settings ports deny foreign store replies and file-capable declarations before any full settings disclosure',async()=>{
 let reads=0;const wrong=createExperienceDataClient({installationId:installation,targetKey:'sender',current:()=>true,fetch:async(path,options)=>{
  if((path.endsWith('/context')||path.endsWith('/resolve')))return json(context());reads++;const request=JSON.parse(String(options.body));return json({schema_version:'deft.app_data_result.v1',request_id:request.request_id,operation:request.operation,input_digest:await appDataInputDigest(request.operation,request.input),outcome:'completed',record:{...row,store_key:'foreign'}});}});
 await assert.rejects(wrong.ports.load(node,new AbortController().signal));assert.equal(reads,1);
 const files=createExperienceDataClient({installationId:installation,targetKey:'sender',current:()=>true,fetch:async(path)=>{if(!(path.endsWith('/context')||path.endsWith('/resolve')))reads++;return json(context({...store,max_files:1}));}});
 await assert.rejects(files.ports.load(node,new AbortController().signal));assert.equal(reads,1);
});
