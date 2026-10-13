import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {createServer} from 'node:http';

const base=new URL('../',import.meta.url);
const source=path=>readFileSync(new URL(path,base),'utf8');
function compile(text,names,globals={}){
  const code=stripTypeScriptTypes(text.replace(/^import .*;\r?\n/gm,''),{mode:'transform'}).replace(/\bexport /g,'');
  return vm.runInNewContext(code+'\n;({'+names.join(',')+'})',{Response,AbortSignal,setTimeout,Date,Error,TypeError,DOMException,console,...globals});
}
const iso=n=>new Date(n).toISOString();
const initial={session_expires_at:iso(100000),exposure:{active:true,exposure_id:'exposure',exposure_epoch:1,review_digest:'sha256:'+'a'.repeat(64),expires_at:iso(100000)}};
const renewed={...initial,session_expires_at:iso(1000000),exposure:{...initial.exposure,expires_at:iso(1000000)}};
const component=source('components/apps/installed-app-experience.tsx');
const begin=component.indexOf('      read: async () => {',component.indexOf('const connection = createExperienceConnection'));
const end=component.indexOf('\n      change(state)',begin);
assert.ok(begin>0&&end>begin,'extract the actual installed Experience connection read callback');
const readText=component.slice(begin,end).trim().replace(/^read:\s*/,'').replace(/,$/,'');
const validateBody=component.match(/\},validate:async\(child,signal\)=>\{([\s\S]*?)\},\s*retire:child=>/)?.[1];
assert.ok(validateBody,'actual account child validation callback found');

async function scenario({race=false,revoked=false,changeIdentity=false,expireResponse=false,bodyResponse,recover=false,pinChange}={}){
  let now=0,current=true,refreshes=0,retired=0,finishExposure,exposureStarted,exposureReads=0;
  const started=new Promise(resolve=>exposureStarted=resolve);
  class Clock extends Date {static now(){return now;}}
  const connectionFns=compile(source('lib/app-experience-connection.ts'),['createExperienceConnection','experienceAuthorityResponse','isExperienceAuthorityUnavailable'],{Date:Clock});
  const sessionFns=compile(source('lib/app-experience-session.ts'),['normalizeExperienceExposureStatus'],{Date:Clock});
  const revalidation=compile(source('lib/app-experience-revalidation.ts'),['readExperienceAuthorityPair'],{Date:Clock});
  const leaseFns=compile(source('lib/app-experience-lease.ts'),['createExperienceLease'],{...connectionFns,...sessionFns,Date:Clock});
  const lease=leaseFns.createExperienceLease({initial,current:()=>current,now:()=>now,refresh:async()=>{refreshes++;return renewed;}});
  const authorityCurrent=()=>current&&lease.valid();
  const globals={...connectionFns,...sessionFns,...revalidation,Date:Clock,lease,
    identityCurrent:()=>current,authorityCurrent,exposure:initial.exposure,
    root:'/experience',session:{pin:{session_id:'original'}},livePath:id=>`/experience/sessions/${id}/live`,
    api:{fetch:async path=>{
      if(path.endsWith('/live'))return new Response();
      assert.ok(path.endsWith('/exposure'));
      const captured=lease.value.exposure;
      if(++exposureReads===1){exposureStarted();await new Promise(resolve=>finishExposure=resolve);}
      return (exposureReads===1?bodyResponse:undefined)??(revoked?new Response(null,{status:403}):Response.json({...captured,active:true,...pinChange,expires_at:expireResponse?iso(1):captured.expires_at}));
    }}};
  const read=vm.runInNewContext(stripTypeScriptTypes('('+readText+')',{mode:'transform'}),{Response,AbortSignal,setTimeout,Error,TypeError,DOMException,...globals});
  const connection=connectionFns.createExperienceConnection({current:()=>current,valid:authorityCurrent,read,
    change:state=>{if(state==='denied'){retired++;current=false;}}});
  const check=connection.check();await started;
  let validating;
  if(race){
    now=15000;
    const validate=vm.runInNewContext(stripTypeScriptTypes('(async(child,signal)=>{'+validateBody+'})',{mode:'transform'}),
      {Response,AbortSignal,Error,TypeError,DOMException,...globals,locallyCurrent:authorityCurrent,live:connection.ensure});
    const child={accountRef:'account',value:{lease,session:{pin:{session_id:'original'},bundle:{record_store_keys:['drafts']}},
      client:{select:async()=>({account:{account_ref:'account'}})}}};
    validating=validate(child,new AbortController().signal);
    // Account sweep and root poll genuinely share one lease but originally did
    // not share the renewal/read critical section.
    for(let tick=0;tick<12;tick++)await Promise.resolve();
  }
  if(changeIdentity)current=false;
  if(expireResponse)now=15000;
  finishExposure();const state=await check;if(validating)await validating;
  const recovered=recover?await connection.check():undefined;
  return {state,retired,refreshes,connection,recovered,exposureReads};
}

test('current matching session remains available',async()=>{
  const value=await scenario();assert.equal(value.state,'available');assert.equal(value.retired,0);
});
test('same-authority renewal during an exposure read does not retire an active editor',async()=>{
  const value=await scenario({race:true});assert.equal(value.state,'available');assert.equal(value.retired,0);
});
test('revocation remains denied even when a renewal overlaps',async()=>{
  const value=await scenario({race:true,revoked:true});assert.equal(value.state,'denied');assert.equal(value.retired,1);
});
test('web identity change remains terminal',async()=>{
  const value=await scenario({changeIdentity:true});assert.equal(value.state,'denied');assert.equal(value.retired,1);
});
test('expired exposure is not renewed by comparison alone',async()=>{
  const value=await scenario({expireResponse:true});assert.equal(value.state,'denied');
});
test('aborted HTTP200 exposure body suspends instead of permanently deleting a valid session',async()=>{
  const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(initial.exposure));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const controller=new AbortController();
    const response=await fetch(`http://127.0.0.1:${server.address().port}/exposure`,{signal:controller.signal});
    assert.equal(response.status,200);controller.abort();
    const value=await scenario({bodyResponse:response,recover:true});
    assert.equal(value.state,'unavailable');assert.equal(value.retired,0);
    assert.equal(value.recovered,'available');assert.equal(value.exposureReads,2,'a fresh successful read is required');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('malformed successful exposure body remains denied',async()=>{
  const value=await scenario({bodyResponse:new Response('not-json',{status:200})});
  assert.equal(value.state,'denied');assert.equal(value.retired,1);
});
for(const [key,value] of [['exposure_id','other'],['exposure_epoch',2],['review_digest','sha256:'+'b'.repeat(64)]]){
  test(`changed ${key} remains terminal during renewal overlap`,async()=>{
    const result=await scenario({race:true,pinChange:{[key]:value}});
    assert.equal(result.state,'denied');assert.equal(result.retired,1);
  });
}
test('HTTP200 body transport failure releases no authority and later fresh read recovers',async()=>{
  const response=new Response(new ReadableStream({start(controller){controller.error(new TypeError('connection reset'));}}));
  const result=await scenario({bodyResponse:response,recover:true});
  assert.equal(result.state,'unavailable');assert.equal(result.retired,0);assert.equal(result.recovered,'available');
});
