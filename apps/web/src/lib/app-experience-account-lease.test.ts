import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createExperienceLease} from './app-experience-lease';
import {createExperienceAccountRouting} from './app-experience-account-routing';

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

test('transient validation failure independently retires a child before its captured expiry',async()=>{
 let failed=false;
 const retired:string[]=[];
 const child={targetKey:'sender',accountRef:'account',label:'sender',value:{}};
 const routing=createExperienceAccountRouting({current:()=>true,catalog:async()=>[{key:'sender',label:'sender'}],open:async()=>child,validate:async()=>{if(failed)throw Error('Transient HTTP503');return true;},retire:c=>retired.push(c.targetKey)});
 await routing.child('sender',new AbortController().signal);failed=true;
 assert.deepEqual(await routing.sweep(new AbortController().signal),['sender']);
 assert.deepEqual(retired,['sender']);
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
 const validate=new Function('session','live','locallyCurrent',`return async(child,signal)=>{${body}}`)({pin:{session_id:'root'}},async()=>++liveCalls===1?first:true,()=>true);
 const child={accountRef:'account',value:{session:{pin:{session_id:'root'},bundle:{record_store_keys:['drafts']}},lease:{valid:()=>true},client:{select:async()=>{selected=true;return target;}}}};
 const work=validate(child,new AbortController().signal);await new Promise(resolve=>setImmediate(resolve));
 try{assert.equal(selected,true,'readonly selection must start while first live check is pending');assert.equal(liveCalls,1,'final authority check must wait for both inputs');}
 finally{releaseLive(true);releaseTarget({account:{account_ref:'account'}});}
 assert.equal(await work,true);assert.equal(liveCalls,2);
});

test('actual concurrent root validation stays closed on revocation, wrong account, scope, lease or abort',async()=>{
 for(const mode of ['revoked','foreign','scope','lease','abort','selection_failure','authority_failure','final_denied']){
  const controller=new AbortController();let current=true,valid=true,liveCalls=0,selectedSignal:AbortSignal|undefined;
  const validate=new Function('session','live','locallyCurrent',`return async(child,signal)=>{${body}}`)({pin:{session_id:'root'}},async()=>{liveCalls++;if(mode==='authority_failure')throw Error('authority failed');return mode==='final_denied'?liveCalls===1:mode!=='revoked';},()=>current);
  const child={accountRef:'account',value:{session:{pin:{session_id:'root'},bundle:{record_store_keys:['drafts']}},lease:{valid:()=>valid},client:{select:async(_store:string,signal:AbortSignal)=>{selectedSignal=signal;if(mode==='scope')current=false;if(mode==='lease')valid=false;if(mode==='abort')controller.abort();if(mode==='selection_failure')throw Error('selection failed');return {account:{account_ref:mode==='foreign'?'foreign':'account'}};}}}};
  if(['abort','selection_failure','authority_failure'].includes(mode))await assert.rejects(validate(child,controller.signal));else assert.equal(await validate(child,controller.signal),false,mode);
  assert.ok(selectedSignal?.aborted,'temporary concurrent work is cancelled when the validation turn ends');
  assert.equal(liveCalls,mode==='final_denied'?2:1);
 }
});
