import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import ts from 'typescript';
const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('./app-experience-revalidation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:module.exports,module,Response,setTimeout});
const {readExperienceAuthorityPair}=module.exports;
test('live and exposure reads start together, without cached or assumed authority',async()=>{
 let release;const started=[];const pending=readExperienceAuthorityPair(()=>true,async()=>{started.push('live');await new Promise(resolve=>release=resolve);return new Response();},async()=>{started.push('exposure');return new Response(null,{status:403});});
 await new Promise(resolve=>setTimeout(resolve,0));try{assert.deepEqual(started,['live','exposure']);}finally{release();}
 const [live,exposure]=await pending;assert.equal(live.status,200);assert.equal(exposure.status,403);
});
test('identity ending during concurrent reads suppresses both results',async()=>{
 let current=true;const result=await readExperienceAuthorityPair(()=>current,async()=>{current=false;return new Response();},async()=>new Response());assert.deepEqual(Array.from(result),[null,null]);
});
