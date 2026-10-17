import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createExperienceAccountRouting,ExperienceAccountVisibilityEndedError} from './app-experience-account-routing';
import {AppDataRequestSchema,AppDataRecordMetaSchema} from '../../../../packages/app-kit/src/app-data';
const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');
const begin=source.indexOf('async appData(_pin,key,input,signal){'),end=source.indexOf('        async dialog(',begin);
const callback=ts.transpileModule('const callback={'+source.slice(begin,end)+'};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText+';return callback.appData;';
function fixture(denyAt=0){
 let checks=0,requests=0,catalogKeys=['mail','other'];const targets:string[]=[];
 const accounts=createExperienceAccountRouting({current:()=>true,catalog:async()=>catalogKeys.map(key=>({key,label:key})),open:async key=>({targetKey:key,accountRef:'account:'+key,label:key,value:{client:{request:async()=>{requests++;targets.push(key);return {outcome:'completed',items:[],next_cursor:null};}}}}),validate:async()=>++checks!==denyAt,retire:()=>{}});
 const appData=new Function('exposure','locallyCurrent','session','resourceTarget','AppDataRequestSchema','AppDataRecordMetaSchema','ExperienceAccountVisibilityEndedError','accounts','createdRecords','routedRuns','sourceChild','bridge',callback)(true,()=>true,{bundle:{record_store_keys:['drafts'],resource_keys:['inbox']},resource_target_key:'mail'},null,AppDataRequestSchema,AppDataRecordMetaSchema,ExperienceAccountVisibilityEndedError,accounts,new Map(),new Map(),()=>{throw Error('Unexpected source');},{sendUiEvent:async()=>{}});
 return {appData,targets,setCatalog:(keys:string[])=>{catalogKeys=keys;},counts:()=>({checks,requests}),close:()=>accounts.close()};
}
test('actual default mailbox broker performs only fresh dispatch and disclosure account validations',async()=>{
 for(const operation of ['resource_list','record_list']){const f=fixture();try{
  const result=await f.appData({},'drafts',{operation,input:{store_key:'drafts',...(operation==='resource_list'?{resource_key:'inbox'}:{}),cursor:null,limit:10}},new AbortController().signal);
  assert.equal(result.outcome,'completed');assert.deepEqual(f.counts(),{checks:2,requests:1});
 }finally{f.close();}}
});

test('actual broker refreshes the nominated account through fresh dispatch and disclosure checks',async()=>{
 const f=fixture();try{
  const result=await f.appData({},'drafts',{operation:'resource_refresh',target_key:'other',input:{store_key:'drafts',resource_key:'inbox'}},new AbortController().signal);
  assert.equal(result.outcome,'completed');assert.deepEqual(f.targets,['other']);assert.deepEqual(f.counts(),{checks:2,requests:1});
 }finally{f.close();}
});

test('targeted refresh does not release work or results after revocation and cannot nominate unknown accounts',async()=>{
 for(const denyAt of [1,2]){const f=fixture(denyAt);try{
  const result=await f.appData({},'drafts',{operation:'resource_refresh',target_key:'other',input:{store_key:'drafts',resource_key:'inbox'}},new AbortController().signal);
  assert.deepEqual(result,{outcome:'not_found',items:[],account_state:'denied'});
  assert.equal(f.counts().requests,denyAt===1?0:1);
 }finally{f.close();}}
 const f=fixture();try{await assert.rejects(f.appData({},'drafts',{operation:'resource_refresh',target_key:'foreign',input:{store_key:'drafts',resource_key:'inbox'}},new AbortController().signal));assert.equal(f.counts().requests,0);}finally{f.close();}
});
test('untargeted refresh uses the current account and maps dispatch or disclosure revocation to denied',async()=>{
 for(const denyAt of [1,2]){const f=fixture(denyAt);try{
  const result=await f.appData({},'drafts',{operation:'resource_refresh',input:{store_key:'drafts',resource_key:'inbox'}},new AbortController().signal);
  assert.deepEqual(result,{outcome:'not_found',items:[],account_state:'denied'});assert.deepEqual(f.targets,denyAt===1?[]:['mail']);
 }finally{f.close();}}
});
test('targeted refresh reports a catalogued account removed before dispatch as denied',async()=>{
 const f=fixture();try{
  const catalog=await f.appData({},'drafts',{operation:'account_catalog',input:{}},new AbortController().signal);
  assert.deepEqual(catalog.targets.map((row:{key:string})=>row.key),['mail','other']);f.setCatalog(['mail']);
  const result=await f.appData({},'drafts',{operation:'resource_refresh',target_key:'other',input:{store_key:'drafts',resource_key:'inbox'}},new AbortController().signal);
  assert.deepEqual(result,{outcome:'not_found',items:[],account_state:'denied'});assert.deepEqual(f.counts(),{checks:0,requests:0});
 }finally{f.close();}
});
test('default mailbox dispatch and disclosure revocation never releases protected items',async()=>{
 for(const denyAt of [1,2]){const f=fixture(denyAt);try{
  const result=await f.appData({},'drafts',{operation:'resource_list',input:{store_key:'drafts',resource_key:'inbox',cursor:null,limit:10}},new AbortController().signal);
  assert.deepEqual(result,{outcome:'not_found',items:[],account_state:'denied'});assert.equal(f.counts().requests,denyAt===1?0:1);
 }finally{f.close();}}
});
