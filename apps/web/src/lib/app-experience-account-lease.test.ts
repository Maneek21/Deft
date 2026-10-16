import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createExperienceLease} from './app-experience-lease';
import {createExperienceAccountRouting} from './app-experience-account-routing';
import {ExperienceAuthorityUnavailable} from './app-experience-connection';

const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');
const body=source.match(/\},validate:async\(child,signal\)=>\{([\s\S]*?)\},\s*retire:child=>/)?.[1];
assert.ok(body,'Actual installed validate callback located');
const initial={session_expires_at:new Date(900000).toISOString(),exposure:{exposure_id:'scope',exposure_epoch:1,review_digest:'digest',expires_at:new Date(900000).toISOString()}};

test('actual child validator retains root account after successfully renewed root lease, without network failure',async()=>{
 let now=820000,selects=0,lives=0;
 const lease=createExperienceLease({initial,current:()=>true,now:()=>now,refresh:async()=>({...initial,session_expires_at:new Date(1720000).toISOString(),exposure:{...initial.exposure,expires_at:new Date(1720000).toISOString()}})});
 assert.equal(await lease.ensure(),true);
 const validate:(child:unknown,signal:AbortSignal)=>Promise<boolean>=new Function('Date','session','live','api','root','livePath','normalizeExperienceExposureStatus','locallyCurrent',`return async(child,signal)=>{${body}}`)({now:()=>now,parse:Date.parse},{pin:{session_id:'root'}},async()=>{lives++;return true;},{fetch:()=>{throw Error('Unexpected child network');}},'',()=>'',(v:unknown)=>v,()=>true);
 const child={targetKey:'sender',accountRef:'account',label:'sender',value:{lease,session:{expires_at:initial.session_expires_at,pin:{session_id:'root'},bundle:{record_store_keys:['drafts']}},exposure:initial.exposure,client:{select:async()=>{selects++;return {account:{account_ref:'account'}};}}}};
 const retired:string[]=[];
 const routing=createExperienceAccountRouting({current:()=>lease.valid(),catalog:async()=>[{key:'sender',label:'sender'}],open:async()=>child,validate,retire:c=>retired.push(c.targetKey)});
 await routing.child('sender',new AbortController().signal);
 routing.retain(child,[{resource_key:'inbox',record_id:'record',content_digest:'digest'}]);
 now=960000;
 assert.equal(lease.valid(),true);
 assert.deepEqual(await routing.sweep(new AbortController().signal),[]);
 assert.deepEqual(retired,[]);
 assert.equal(selects,2);assert.equal(lives,4);
 assert.equal(routing.reference('inbox','record').record_id,'record');
});

test('actual nonroot transient status and cancellation retain the child without releasing work, and recover on a fresh check',async()=>{
 for(const failure of [408,429,500,503,'network','cancelled'] as const){
  let status:number|string=200,retired=0,work=0;
  const validate:(child:unknown,signal:AbortSignal)=>Promise<boolean>=new Function('Date','session','live','api','root','livePath','normalizeExperienceExposureStatus','locallyCurrent','ExperienceAuthorityUnavailable',`return async(child,signal)=>{${body}}`)({now:()=>0,parse:Date.parse},{pin:{session_id:'root'}},async()=>true,{fetch:async(path:string)=>{
   if(path.endsWith('/exposure')&&status==='network')throw new TypeError('Failed to fetch');
   if(path.endsWith('/exposure')&&status==='cancelled')throw new DOMException('Cancelled probe','AbortError');
   return {status:path.endsWith('/exposure')?status:200,ok:!path.endsWith('/exposure')||status===200,json:async()=>initial.exposure};
  }},'',()=>'/live',(v:unknown)=>v,()=>true,ExperienceAuthorityUnavailable);
  const child={targetKey:'sender',accountRef:'account',label:'sender',value:{session:{pin:{session_id:'child'},bundle:{record_store_keys:['drafts']}},lease:{ensure:async()=>true,valid:()=>true,value:initial},client:{select:async()=>({account:{account_ref:'account'}})}}};
  const routing=createExperienceAccountRouting({current:()=>true,catalog:async()=>[{key:'sender',label:'sender'}],open:async()=>child,validate,retire:()=>{retired++;}});
  await routing.child('sender',new AbortController().signal);routing.retain(child,[{resource_key:'inbox',record_id:'one',content_digest:'digest'}]);status=failure;
  await assert.rejects(routing.sweep(new AbortController().signal));
  await assert.rejects(routing.read(child,new AbortController().signal,async()=>{work++;return 'private';}));
  assert.equal(work,0);assert.equal(retired,0);assert.equal(routing.reference('inbox','one').content_digest,'digest');status=200;
  assert.deepEqual(await routing.sweep(new AbortController().signal),[]);assert.equal(await routing.child('sender',new AbortController().signal),child);
  assert.equal(await routing.read(child,new AbortController().signal,async()=>{work++;return 'fresh';}),'fresh');assert.equal(work,1);
 }
});

test('actual nonroot definitive denial retires and clears retained ownership',async()=>{
 for(const denied of [401,403,404,410]){
  let status=200,retired=0;
  const validate:(child:unknown,signal:AbortSignal)=>Promise<boolean>=new Function('Date','session','live','api','root','livePath','normalizeExperienceExposureStatus','locallyCurrent',`return async(child,signal)=>{${body}}`)({now:()=>0,parse:Date.parse},{pin:{session_id:'root'}},async()=>true,{fetch:async()=>({status,ok:status===200,json:async()=>initial.exposure})},'',()=>'/live',(v:unknown)=>v,()=>true);
  const child={targetKey:'sender',accountRef:'account',label:'sender',value:{session:{pin:{session_id:'child'},bundle:{record_store_keys:['drafts']}},lease:{ensure:async()=>true,valid:()=>true,value:initial},client:{select:async()=>({account:{account_ref:'account'}})}}};
  const routing=createExperienceAccountRouting({current:()=>true,catalog:async()=>[{key:'sender',label:'sender'}],open:async()=>child,validate,retire:()=>{retired++;}});
  await routing.child('sender',new AbortController().signal);routing.retain(child,[{resource_key:'inbox',record_id:'one',content_digest:'digest'}]);status=denied;
  assert.deepEqual(await routing.sweep(new AbortController().signal),['sender']);assert.equal(retired,1);assert.throws(()=>routing.reference('inbox','one'));
 }
});

test('actual nonroot child renews independently; review mismatch, page end and abort cannot admit',async()=>{
 for(const mode of ['valid','review_changed','identity_changed','epoch_changed','revoked','account_changed','page_closed','aborted','closed_during_refresh','aborted_during_refresh']){
  let now=960000,renews=0,current=true,selects=0;
  const controller=new AbortController();
  const renewed={...initial,session_expires_at:new Date(1860000).toISOString(),exposure:{...initial.exposure,expires_at:new Date(1860000).toISOString(),review_digest:mode==='review_changed'?'foreign':'digest',exposure_id:mode==='identity_changed'?'foreign':'scope',exposure_epoch:mode==='epoch_changed'?2:1}};
  const lease=createExperienceLease({initial,current:()=>current,now:()=>now,refresh:async()=>{renews++;if(mode==='closed_during_refresh')current=false;if(mode==='aborted_during_refresh')controller.abort();return renewed;}});
  const validate:(child:unknown,signal:AbortSignal)=>Promise<boolean>=new Function('Date','session','live','api','root','livePath','normalizeExperienceExposureStatus','locallyCurrent',`return async(child,signal)=>{${body}}`)({now:()=>now,parse:Date.parse},{pin:{session_id:'root'}},async()=>true,{fetch:async(path:string)=>({status:mode==='revoked'?403:200,ok:mode!=='revoked',json:async()=>path.endsWith('/exposure')?renewed.exposure:{}})},'',(id:string)=>'/live/'+id,(v:unknown)=>v,()=>current);
  const child={targetKey:'recipient',accountRef:'account',label:'recipient',value:{lease,session:{expires_at:initial.session_expires_at,pin:{session_id:'child'},bundle:{record_store_keys:['drafts']}},exposure:initial.exposure,client:{select:async()=>{selects++;return {account:{account_ref:mode==='account_changed'?'foreign':'account'}};}}}};
  if(mode==='page_closed')current=false;
  if(mode==='aborted')controller.abort();
  if(mode==='aborted'||mode==='aborted_during_refresh')await assert.rejects(validate(child,controller.signal));
  else assert.equal(await validate(child,controller.signal),mode==='valid');
  assert.equal(renews,['page_closed','aborted'].includes(mode)?0:1);
  assert.equal(selects,['valid','revoked','account_changed'].includes(mode)?1:0);
 }
});

test('actual retirement disposes only the retired child lease and clears its retained ownership',()=>{
 const retireBody=source.match(/retire:child=>\{([\s\S]*?)\},\s*\}\);/)?.[1];assert.ok(retireBody);
 const retired:string[]=[],records=new Map(),runs=new Map();
 const retire=new Function('session','retireSession','createdRecords','routedRuns',`return child=>{${retireBody}}`)({pin:{session_id:'root'}},(id:string)=>retired.push(id),records,runs);
 const make=(id:string)=>({targetKey:id,value:{session:{pin:{session_id:id}},lease:createExperienceLease({initial,current:()=>true,now:()=>0,refresh:async()=>initial})}});
 const root=make('root'),child=make('child');records.set('draft',child);runs.set('run',child);retire(child);
 assert.equal(child.value.lease.valid(),false);assert.equal(root.value.lease.valid(),true);assert.equal(records.size,0);assert.equal(runs.size,0);assert.deepEqual(retired,['child']);
 retire(root);assert.equal(root.value.lease.valid(),true);
});


test('actual root validator overlaps first live check and readonly selection, then performs fresh final live check',async()=>{
 let releaseLive!:(v:boolean)=>void,releaseTarget!:(v:unknown)=>void,liveCalls=0,selected=false;
 const first=new Promise<boolean>(resolve=>releaseLive=resolve),target=new Promise(resolve=>releaseTarget=resolve);
 const validate:(child:unknown,signal:AbortSignal)=>Promise<boolean>=new Function('session','live','locallyCurrent',`return async(child,signal)=>{${body}}`)({pin:{session_id:'root'}},async()=>++liveCalls===1?first:true,()=>true);
 const child={accountRef:'account',value:{session:{pin:{session_id:'root'},bundle:{record_store_keys:['drafts']}},lease:{valid:()=>true},client:{select:async()=>{selected=true;return target;}}}};
 const work=validate(child,new AbortController().signal);await new Promise(resolve=>setImmediate(resolve));
 try{assert.equal(selected,true,'readonly selection must start while first live check is pending');assert.equal(liveCalls,1,'final authority check must wait for both inputs');}
 finally{releaseLive(true);releaseTarget({account:{account_ref:'account'}});}
 assert.equal(await work,true);assert.equal(liveCalls,2);
});

test('actual concurrent root validation stays closed on revocation, wrong account, scope, lease or abort',async()=>{
 for(const mode of ['revoked','foreign','scope','lease','abort','selection_failure','authority_failure','final_denied']){
  const controller=new AbortController();let current=true,valid=true,liveCalls=0,selectedSignal:AbortSignal|undefined;
  const validate:(child:unknown,signal:AbortSignal)=>Promise<boolean>=new Function('session','live','locallyCurrent',`return async(child,signal)=>{${body}}`)({pin:{session_id:'root'}},async()=>{liveCalls++;if(mode==='authority_failure')throw Error('authority failed');return mode==='final_denied'?liveCalls===1:mode!=='revoked';},()=>current);
  const child={accountRef:'account',value:{session:{pin:{session_id:'root'},bundle:{record_store_keys:['drafts']}},lease:{valid:()=>valid},client:{select:async(_store:string,signal:AbortSignal)=>{selectedSignal=signal;if(mode==='scope')current=false;if(mode==='lease')valid=false;if(mode==='abort')controller.abort();if(mode==='selection_failure')throw Error('selection failed');return {account:{account_ref:mode==='foreign'?'foreign':'account'}};}}}};
  if(['abort','selection_failure','authority_failure'].includes(mode))await assert.rejects(validate(child,controller.signal));else assert.equal(await validate(child,controller.signal),false,mode);
  assert.ok(selectedSignal?.aborted,'temporary concurrent work is cancelled when the validation turn ends');
  assert.equal(liveCalls,mode==='final_denied'?2:1);
 }
});


test('actual nonroot resolution overlaps current authority reads but cannot settle before exact selection',async()=>{
 let resolveTarget!:(v:unknown)=>void,selected=false,settled=false;const paths:string[]=[],signals:AbortSignal[]=[];
 const target=new Promise(resolve=>resolveTarget=resolve);
 const validate:(child:unknown,signal:AbortSignal)=>Promise<boolean>=new Function('Date','session','live','api','root','livePath','normalizeExperienceExposureStatus','locallyCurrent',`return async(child,signal)=>{${body}}`)({now:()=>0,parse:Date.parse},{pin:{session_id:'root'}},async()=>true,{fetch:async(path:string,options:{signal:AbortSignal})=>{paths.push(path);signals.push(options.signal);return {status:200,ok:true,json:async()=>initial.exposure};}},'',()=>'/live',(v:unknown)=>v,()=>true);
 const child={accountRef:'account',value:{session:{pin:{session_id:'child'},bundle:{record_store_keys:['drafts']}},lease:{ensure:async()=>true,valid:()=>true,value:initial},client:{select:async(_key:string,signal:AbortSignal)=>{selected=true;signals.push(signal);return target;}}}};
 const work=validate(child,new AbortController().signal).then(result=>{settled=true;return result;});await new Promise(resolve=>setImmediate(resolve));
 try{assert.equal(selected,true);assert.equal(paths.length,2,'both authority reads start while exact target resolution is pending');assert.equal(settled,false);}
 finally{resolveTarget({account:{account_ref:'account'}});}
 assert.equal(await work,true);assert.ok(signals.every(signal=>signal.aborted),'the temporary operation group is closed after validation');
});


test('temporary failure at the final child check withholds the completed result without retiring the child',async()=>{
 let checks=0,retired=0,fail=false,work=0;
 const child={targetKey:'sender',accountRef:'account',label:'sender',value:{}};
 const routing=createExperienceAccountRouting({current:()=>true,catalog:async()=>[{key:'sender',label:'sender'}],open:async()=>child,validate:async()=>{if(fail&&++checks===2)throw new ExperienceAuthorityUnavailable();return true;},retire:()=>{retired++;}});
 await routing.child('sender',new AbortController().signal);fail=true;
 await assert.rejects(routing.read(child,new AbortController().signal,async()=>{work++;return 'must not disclose';}),ExperienceAuthorityUnavailable);
 assert.equal(work,1);assert.equal(retired,0);fail=false;assert.equal(await routing.child('sender',new AbortController().signal),child);
});
