import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createNativeEmailRefresh,isEmailMailboxRefresh} from './email-native-refresh';
import type {ExperienceView} from './app-experience-bridge';

const setup={state:'connected',account:{account_id:'stable/account',health:'connected'},
  native_email:{account_id:'stable/account',resource_binding_id:'11111111-1111-4111-8111-111111111111',state:'available'}};
const page=(revision=3,extras={})=>({account_id:'stable/account',checkpoint_revision:revision,observed_at:'2026-10-04T01:00:00Z',
  freshness:'fresh',coverage:'complete',sync_state:'idle',items:[{private_locator:'never forward'}],...extras});
function fixture(responses:Array<Response|(()=>Promise<Response>)>){
  const paths:string[]=[],notices:string[]=[],received:RequestInit[]=[];let reloads=0,current=true;
  const controller=createNativeEmailRefresh({installationId:'installed',targetKey:'personal',current:()=>current,
    fetch:async(path,init)=>{paths.push(path);received.push(init);const response=responses.shift();assert.ok(response,'unexpected fetch');return typeof response==='function'?await response():response;},
    wait:async()=>{},reload:async()=>{reloads++;return true;},notice:v=>notices.push(v)});
  return {controller,paths,notices,received,get reloads(){return reloads;},end:()=>{current=false;}};
}

test('queued native Refresh retains the view until fresh complete checkpoint advancement, without provider duplication',async()=>{
  const f=fixture([Response.json(setup),Response.json(page()),Response.json({account_id:'stable/account',state:'queued'},{status:202}),
    Response.json(page()),Response.json(page(4,{coverage:'partial'})),Response.json(page(5))]);
  await f.controller.start();assert.equal(f.reloads,1);assert.equal(f.paths.length,6);
  assert.equal(f.paths[2],'/api/email/accounts/stable%2Faccount/refresh');
  assert.ok(f.paths.filter(path=>path.includes('/messages?')).every(path=>new URL(path,'https://fixture.test').searchParams.get('include_total')==='false'));
  assert.equal(f.received[2].body,'{}');assert.equal(f.received[2].method,'POST');
  assert.ok(f.received.every(init=>init.cache==='no-store'&&init.signal));
  assert.match(f.notices[1],/queued/);assert.equal(f.notices.at(-1),'Mailbox updated.');
});

test('unenrolled and disabled native accounts use exactly one original Worker refresh, without adopting',async()=>{
  for(const result of [Response.json({state:'not_connected'}),Response.json(setup)]){
    const f=fixture([result,new Response(null,{status:503})]);await f.controller.start();
    assert.equal(f.reloads,1);assert.ok(f.paths.every(path=>!path.endsWith('/adopt')&&!path.endsWith('/refresh')));
    assert.equal(f.notices.at(-1),'');
  }
});

test('202 is not fresh: bounded unchanged polls retain the message without claiming the job is still running',async()=>{
  const f=fixture([Response.json(setup),Response.json(page()),Response.json({account_id:'stable/account',state:'syncing'},{status:202}),
    ...Array.from({length:6},()=>Response.json(page()))]);await f.controller.start();
  assert.equal(f.reloads,0);assert.match(f.notices.at(-1)!,/updates were not confirmed/);assert.doesNotMatch(f.notices.at(-1)!,/still running/);assert.ok(!f.notices.includes('Mailbox updated.'));
});

test('held responses cannot queue or reload after current account/session changes or disposal',async()=>{
  for(const stage of ['connection','baseline','poll'] as const){
    let release!:(response:Response)=>void;const held=()=>new Promise<Response>(resolve=>{release=resolve;});
    const responses=stage==='connection'?[held]:stage==='baseline'?[Response.json(setup),held]
      :[Response.json(setup),Response.json(page()),Response.json({account_id:'stable/account',state:'queued'},{status:202}),held];
    const f=fixture(responses),pending=f.controller.start();while(!release)await new Promise(resolve=>setImmediate(resolve));
    const before=f.notices.length;f.end();f.controller.dispose();release(stage==='connection'?Response.json(setup):Response.json(page(4)));
    await pending;assert.equal(f.reloads,0);assert.equal(f.notices.length,before);
    if(stage!=='poll')assert.ok(!f.paths.some(path=>path.endsWith('/refresh')));
  }
});

test('revocation, malformed scope, and uncertain POST never fall back to extra provider I/O',async()=>{
  for(const next of [new Response(null,{status:403}),Response.json(page(4,{account_id:'another'})),Response.json(page(4,{sync_state:'paused'}))]){
    const f=fixture([Response.json(setup),Response.json(page()),Response.json({account_id:'stable/account',state:'queued'},{status:202}),next]);
    await f.controller.start();assert.equal(f.reloads,0);assert.ok(!f.notices.includes('Mailbox updated.'));
  }
  const f=fixture([Response.json(setup),Response.json(page()),new Response(null,{status:503})]);
  await f.controller.start();assert.equal(f.reloads,0);assert.match(f.notices.at(-1)!,/not confirmed/);
});

test('repeat clicks share one pending sync and do not clear or expose message payloads',async()=>{
  let release!:(response:Response)=>void;
  const f=fixture([()=>new Promise(resolve=>{release=resolve;}),new Response(null,{status:503})]);
  const first=f.controller.start();await f.controller.start();assert.equal(f.paths.length,1);
  release(Response.json(setup));await first;assert.equal(f.reloads,1);
});

test('Refresh interception excludes drafts, Activity, search and busy or unrelated views',()=>{
  const view:ExperienceView={root:{kind:'stack',id:'email',children:[{kind:'button',id:'refresh',label:'Refresh',variant:'ghost'}]},
    navigation:[{kind:'button',id:'folder_inbox',label:'Inbox',variant:'ghost',selected:true}]};
  const click={kind:'click',node_id:'refresh'};assert.equal(isEmailMailboxRefresh(view,click),true);
  assert.equal(isEmailMailboxRefresh({...view,navigation:[]},click),false);
  assert.equal(isEmailMailboxRefresh({...view,root:{...view.root,id:'other'}},click),false);
  assert.equal(isEmailMailboxRefresh({...view,root:{kind:'button',id:'refresh',label:'Refresh',variant:'ghost',disabled:true}},click),false);
  assert.equal(isEmailMailboxRefresh(view,{kind:'click',node_id:'compose'}),false);
});

test('the actual host Refresh event defers Worker reload until native sync is resolved',async()=>{
  const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');
  const hook=source.match(/const sendViewEvent=\(event:unknown\)=>\{([\s\S]*?)\n    \};/);
  let native=0,worker=0;
  const run=vm.runInNewContext(`event=>{${hook![1]}}`,{
    nativeRefresh:{start:()=>{native++;}},isEmailMailboxRefresh:()=>true,locallyCurrent:()=>true,
    latestView:{},bridge:{sendUiEvent:async()=>{worker++;return true;}},
  });
  await run({kind:'click',node_id:'refresh'});
  assert.equal(worker,0);assert.equal(native,1,'native enrolled sync must be requested before a Worker reload');
});
