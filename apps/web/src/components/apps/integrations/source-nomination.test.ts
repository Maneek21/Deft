import {test} from 'node:test';import assert from 'node:assert/strict';import {parseSourceNomination,openSourceNomination,resolveSourceNominationAccount,createSourceNominationLoader} from './source-nomination';
const q=()=>new URLSearchParams({account_ref:'account_one',source_store_key:'drafts',source_resource_key:'inbox',source_record_id:'00000000-0000-4000-8000-000000000001',source_digest:'sha256:'+'a'.repeat(64)});
test('closed nominations reject duplicate and missing source fields',()=>{assert.equal(parseSourceNomination(new URLSearchParams()),null);const query=q();query.append('account_ref','other');assert.throws(()=>parseSourceNomination(query));query.delete('source_digest');assert.throws(()=>parseSourceNomination(query));});
test('current exact account and signed declarations precede reviewed read',async()=>{const nomination=parseSourceNomination(q())!;let reads=0;const ports={current:()=>true,storeKeys:['drafts'],resourceKeys:['inbox'],select:async()=>({account:{account_ref:'foreign'}}),read:async()=>{reads++;return 'private'}};await assert.rejects(openSourceNomination(nomination,ports,new AbortController().signal));assert.equal(reads,0);ports.select=async()=>({account:{account_ref:'account_one'}});assert.equal(await openSourceNomination(nomination,ports,new AbortController().signal),'private');assert.equal(reads,1);});
test('account changes after read prevent disclosure',async()=>{const nomination=parseSourceNomination(q())!;let calls=0;await assert.rejects(openSourceNomination(nomination,{current:()=>true,storeKeys:['drafts'],resourceKeys:['inbox'],select:async()=>({account:{account_ref:++calls===1?'account_one':'foreign'}}),read:async()=> 'private'},new AbortController().signal));});

test('reproduction: sender backlink against default recipient rejects before source read',async()=>{const nomination=parseSourceNomination(q())!;let reads=0;await assert.rejects(openSourceNomination(nomination,{current:()=>true,storeKeys:['drafts'],resourceKeys:['inbox'],select:async()=>({account:{account_ref:'default_recipient'}}),read:async()=>{reads++;return 'private';}},new AbortController().signal),/Source account review required/);assert.equal(reads,0);});

test('sender nomination resolves current admitted child instead of default recipient',async()=>{const nomination=parseSourceNomination(q())!,signal=new AbortController().signal;const seen:string[]=[];const owner=await resolveSourceNominationAccount(nomination,{current:()=>true,catalog:async()=>[{key:'recipient'},{key:'sender'}],child:async key=>{seen.push(key);return {accountRef:key==='sender'?'account_one':'recipient',key};}},signal);assert.equal(owner.key,'sender');assert.deepEqual(seen,['recipient','sender','sender']);assert.equal(await openSourceNomination(nomination,{current:()=>true,storeKeys:['drafts'],resourceKeys:['inbox'],select:async()=>({account:{account_ref:owner.accountRef}}),read:async()=> 'exact sender source'},signal),'exact sender source');});
test('foreign, revoked and ambiguous accounts cannot resolve',async()=>{const n=parseSourceNomination(q())!,signal=new AbortController().signal;for(const child of [async()=>({accountRef:'foreign'}),async()=>{throw Error('revoked');}])await assert.rejects(resolveSourceNominationAccount(n,{current:()=>true,catalog:async()=>[{key:'sender'}],child},signal));await assert.rejects(resolveSourceNominationAccount(n,{current:()=>true,catalog:async()=>[{key:'one'},{key:'two'}],child:async()=>({accountRef:'account_one'})},signal),/ambiguous/);});
test('stale session or aborted nomination never returns account',async()=>{const n=parseSourceNomination(q())!,controller=new AbortController();let current=true;await assert.rejects(resolveSourceNominationAccount(n,{current:()=>current,catalog:async()=>[{key:'sender'}],child:async()=>{current=false;return {accountRef:'account_one'};}},controller.signal));controller.abort();await assert.rejects(resolveSourceNominationAccount(n,{current:()=>true,catalog:async()=>[],child:async()=>({accountRef:'account_one'})},controller.signal));});

test('account revoked during catalog traversal is denied before presentation',async()=>{const n=parseSourceNomination(q())!;let calls=0;await assert.rejects(resolveSourceNominationAccount(n,{current:()=>true,catalog:async()=>[{key:'sender'}],child:async()=>{if(++calls>1)throw Error('revoked');return {accountRef:'account_one'};}},new AbortController().signal),/revoked/);});

test('failed readonly source navigation has an explicit fresh retry and no overlapping attempts',async()=>{
 let attempts=0,release!:()=>void;const states:string[]=[],controller=new AbortController();
 const loader=createSourceNominationLoader({current:()=>true,signal:controller.signal,change:state=>states.push(state),load:async signal=>{attempts++;signal.throwIfAborted();if(attempts===1)throw Error('temporary read failure');await new Promise<void>(resolve=>{release=resolve;});signal.throwIfAborted();}});
 await loader.run();assert.deepEqual(states,['pending','failed']);
 const retry=loader.run();await loader.run();assert.equal(attempts,2);release();await retry;assert.deepEqual(states,['pending','failed','pending','opened']);loader.dispose();await loader.run();assert.equal(attempts,2);
});
test('disposed or replaced source load cannot disclose a late result or revive its retry',async()=>{
 for(const reason of ['dispose','current','abort']){let release!:()=>void,current=true,received:AbortSignal|undefined;const states:string[]=[],controller=new AbortController();
 const loader=createSourceNominationLoader({current:()=>current,signal:controller.signal,change:state=>states.push(state),load:async signal=>{received=signal;await new Promise<void>(resolve=>{release=resolve;});}});
 const pending=loader.run();if(reason==='dispose')loader.dispose();else if(reason==='abort')controller.abort();else current=false;release();await pending;assert.deepEqual(states,['pending']);await loader.run();assert.deepEqual(states,['pending']);if(reason!=='current')assert.equal(received?.aborted,true);
 }
});

import {readFileSync} from 'node:fs';
import ts from 'typescript';

test('actual successful native source surface outlives only its read deadline, never its parent lifetime',async()=>{
 const source=readFileSync(new URL('../installed-app-experience.tsx',import.meta.url),'utf8'),begin=source.indexOf('    const nominateSource=async('),end=source.indexOf('    const sourceLoader=',begin);assert.ok(begin>=0&&end>begin);
 const code=ts.transpileModule(source.slice(begin,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText+';return nominateSource;';
 for(const parentEndsBeforePublish of [false,true]){
  const read=new AbortController(),parent=new AbortController(),nomination=parseSourceNomination(q())!;let surface:any;
  const owner={accountRef:nomination.account_ref,value:{client:{select:async()=>({account:{account_ref:nomination.account_ref}}),request:async()=>{if(parentEndsBeforePublish)parent.abort();return {presentation:{plain_text:'Current governed source'}};}},session:{bundle:{record_store_keys:['drafts'],resource_keys:['inbox']}},lease:{valid:()=>true,value:{exposure:{expires_at:new Date(Date.now()+600000).toISOString()}}},exposure:{}}};
  const nominate=new Function('openSourceNomination','accounts','parseExperienceDataPresentation','setNominatedSource','installationId','sessionCacheScope','session','locallyCurrent','appDataInputDigest','createdRecords',code)(openSourceNomination,{read:async(_owner:unknown,_signal:unknown,work:()=>Promise<unknown>)=>work(),retain:()=>{}},(presentation:unknown)=>({presentation}),(value:unknown)=>{surface=value;},'installation','scope',{pin:{org_id:'org',user_id:'owner'}},()=>true,()=>{},new Map());
  await nominate(nomination,owner,()=>true,read.signal,'task',parent.signal);
  if(parentEndsBeforePublish){assert.equal(surface,undefined);continue;}
  assert.equal(surface.current(),true);read.abort();assert.equal(surface.current(),true,'completed read deadline is not the native panel lifetime');assert.equal(surface.signal,parent.signal);parent.abort();assert.equal(surface.current(),false);
 }
});

test('a cancelled source load releases its pending UI even when a shared read ignores abort',async()=>{
 const controller=new AbortController(),states:string[]=[];const loader=createSourceNominationLoader({current:()=>true,signal:controller.signal,change:state=>states.push(state),load:()=>new Promise<void>(()=>{})});
 const pending=loader.run();controller.abort();await pending;assert.deepEqual(states,['pending']);loader.dispose();
});
