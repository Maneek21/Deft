import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transpileModule, ScriptTarget} from 'typescript';
import {connectionSessionRetirementRequired, pendingAppConnection, connectionCallback, APP_CONNECTION_PENDING_KEY} from './app-connection-flow';
import {nativeEmailSetup} from './email-native-enrollment';
import {appConnectionCallbackUsesGeneric} from './app-connection-session-flow';

// Exercise the component's actual opening-owner pagehide and unmount retirement
// function: it also owns sessions after the Worker takes over.
test('OAuth navigation retains its exact session for callback; ordinary exit retires it', () => {
  const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');
  const body=source.match(/const retireOwnedSession = \([^)]*\) => \{([\s\S]*?)\n    \};/)![1];
  for (const [handoff,navigation,expected] of [[true,true,[]],[false,true,['exact-session']],[true,false,['exact-session']]] as const) {
    const deleted:string[]=[];
    const context={ownedSessionId:'exact-session',navigation,retireSession:(id:string)=>deleted.push(id),
      connectionNavigation:{current:handoff?{sessionId:'exact-session',expiresAt:Date.now()+60000}:null},
      connectionSessionRetirementRequired};
    vm.runInNewContext(`(() => {${body}})()`,context);
    assert.deepEqual(deleted,expected);
  }
});


test('navigation handoff never covers another session or an expired setup', () => {
  const pending={sessionId:'exact-session',installationId:'unused',experienceKey:'main',state:'synthetic',expiresAt:100};
  assert.equal(connectionSessionRetirementRequired(pending,'exact-session',99),false);
  assert.equal(connectionSessionRetirementRequired(pending,'other-session',99),true);
  assert.equal(connectionSessionRetirementRequired(pending,'exact-session',100),true);
});

test('callback exchanges once and retires the retained session after success or failure', async () => {
  const source=readFileSync(new URL('../app/(app)/apps/connections/callback/page.tsx',import.meta.url),'utf8');
  const body=source.match(/request.current = \(async \(\) => \{([\s\S]*?)\n      \}\)\(\);/)![1];
  const code=transpileModule(`(async () => {${body}})()`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
  for (const outcome of ['connected','cache_unavailable','cache_active','denied','lost_response']) {
    const ok=outcome==='connected'||outcome.startsWith('cache_');
    const pending={sessionId:'11111111-1111-4111-8111-111111111111',installationId:'22222222-2222-4222-8222-222222222222',experienceKey:'main',state:'s'.repeat(43),expiresAt:Date.now()+60000};
    let stored:string|null=JSON.stringify(pending);const calls:string[]=[];
    const result=await vm.runInNewContext(code,{pendingAppConnection,connectionCallback,APP_CONNECTION_PENDING_KEY,nativeEmailSetup,
      APP_CONNECTION_SESSION_PENDING_KEY:'generic',directEmailSessionTag:async()=>null,scope:'scope',sameSession:()=>true,
      search:`?state=${pending.state}&code=synthetic`,sessionStorage:{getItem:(key:string)=>key===APP_CONNECTION_PENDING_KEY?stored:null,removeItem:()=>{stored=null;}},
      api:{fetch:async(path:string,options:{method:string})=>{calls.push(`${options.method} ${path}`);if(options.method==='POST'&&outcome==='lost_response')throw Error('Unavailable');return {ok,json:async()=>({state:'connected',account:{health:'connected',account_id:'stable'},...(outcome.startsWith('cache_')?{native_email:{account_id:'stable',resource_binding_id:'11111111-1111-4111-8111-111111111111',state:outcome==='cache_active'?'active':'unavailable'}}:{})})};}},encodeURIComponent,JSON,Error});
    assert.equal(result.success,ok);assert.equal(stored,null);
    if(outcome==='cache_unavailable')assert.match(result.message,/connected.*retry/);
    if(outcome==='cache_active')assert.match(result.message,/first sync/);
    assert.deepEqual(calls,[`POST /api/app-experiences/sessions/${pending.sessionId}/connections/callback`,`DELETE /api/app-experiences/sessions/${pending.sessionId}`]);
  }
});

test('Worker pagehide releases local execution while transferring exact callback cleanup', () => {
  const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');
  const body=source.match(/const pageHide = \(\) => (stop\([^;]+\));/)![1];
  for(const handoff of [true,false]) {
    const stopped:boolean[]=[];
    vm.runInNewContext(body,{stop:(retire:boolean)=>stopped.push(retire),session:{pin:{session_id:'exact-session'}},
      connectionNavigation:{current:handoff?{sessionId:'exact-session',expiresAt:Date.now()+60000}:null},connectionSessionRetirementRequired});
    assert.deepEqual(stopped,[!handoff]);
  }
});

test('callback effect replay uses one exchange; foreign provider state never dispatches', async () => {
  const source=readFileSync(new URL('../app/(app)/apps/connections/callback/page.tsx',import.meta.url),'utf8');
  const body=source.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\)/)![1];
  const code=transpileModule(`(() => {${body}})`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
  for(const foreign of [false,true]) {
    const pending={sessionId:'11111111-1111-4111-8111-111111111111',installationId:'22222222-2222-4222-8222-222222222222',experienceKey:'main',state:'s'.repeat(43),expiresAt:Date.now()+60000};
    const calls:string[]=[];let stored:string|null=JSON.stringify(pending);let rendered:{success:boolean}|null=null;
    const request:{current:Promise<unknown>|null}={current:null};
    const effect=vm.runInNewContext(code,{request,pendingAppConnection,connectionCallback,APP_CONNECTION_PENDING_KEY,nativeEmailSetup,
      APP_CONNECTION_SESSION_PENDING_KEY:'generic',directEmailSessionTag:async()=>null,sessionCacheScope:'scope',user:{id:'owner'},org:{id:'org'},
      query:{current:undefined},requestAnchor:{current:null},getActiveSessionCacheScope:()=> 'scope',isSameWebSession:()=>true,
      window:{location:{search:`?state=${foreign?'x'.repeat(43):pending.state}&code=synthetic`,pathname:'/apps/connections/callback'},history:{replaceState:()=>undefined}},
      sessionStorage:{getItem:(key:string)=>key===APP_CONNECTION_PENDING_KEY?stored:null,removeItem:()=>{stored=null;}},setResult:(value:{success:boolean})=>{rendered=value;},
      api:{getAccessToken:()=> 'token',fetch:async(path:string,options:{method:string})=>{calls.push(`${options.method} ${path}`);return {ok:true,json:async()=>({state:'connected',account:{health:'connected'}})};}},encodeURIComponent,JSON,Error});
    effect()();effect();await request.current;await Promise.resolve();
    assert.equal(calls.filter(call=>call.startsWith('POST')).length,foreign?0:1);
    assert.equal(calls.filter(call=>call.startsWith('DELETE')).length,1);
    assert.equal(rendered!.success,!foreign);
  }
});


test('final pagehide UI cleanup does not override guarded opening and Worker retirement', () => {
  const source=readFileSync(new URL('../components/apps/installed-app-experience.tsx',import.meta.url),'utf8');
  const owner=source.match(/const retireOwnedSession = \([^)]*\) => \{([\s\S]*?)\n    \};/)![1];
  const worker=source.match(/const pageHide = \(\) => (stop\([^;]+\));/)![1];
  const clear=source.match(/const clear = \(\) => \{ (renewalGeneration\.current[^\n]+) \};/)![1];
  for (const kind of ['matching','foreign','expired','ordinary']) {
    const stopped:boolean[]=[];const deleted:string[]=[];let invalidations=0;
    const pending=kind==='ordinary'?null:{sessionId:kind==='foreign'?'other-session':'exact-session',expiresAt:Date.now()+(kind==='expired'?-1:60000)};
    const context={ownedSessionId:'exact-session',navigation:true,retireSession:(id:string)=>deleted.push(id),
      connectionNavigation:{current:pending},connectionSessionRetirementRequired,session:{pin:{session_id:'exact-session'}},
      stop:(retire:boolean=true)=>stopped.push(retire),stopWorker:{current:(retire:boolean=true)=>stopped.push(retire)},
      renewalGeneration:{current:0},reviewGeneration:{current:0},setReview:()=>invalidations++,setExposureBusy:()=>invalidations++};
    vm.runInNewContext(`(() => {${owner}})()`,context);
    vm.runInNewContext(worker,context);
    vm.runInNewContext(`(() => {${clear}})()`,context);
    assert.deepEqual(stopped,[kind!=='matching']);
    assert.deepEqual(deleted,kind==='matching'?[]:['exact-session']);
    assert.equal(invalidations,2);
  }
});

test('actual callback page routes an independent native nonce despite unknown generic intent and never downgrades its own nonce',async()=>{
 const source=readFileSync(new URL('../app/(app)/apps/connections/callback/page.tsx',import.meta.url),'utf8');
 const body=source.match(/request.current = \(async \(\) => \{([\s\S]*?)\n      \}\)\(\);/)![1];
 const code=transpileModule(`(async()=>{${body}})()`,{compilerOptions:{target:ScriptTarget.ES2022}}).outputText;
 for(const native of [true,false]){
  let nativeCalls=0,genericCalls=0,otherCalls=0;
  const generic=JSON.stringify({phase:'consumed',state:'generic-state',installationId:'11111111-1111-4111-8111-111111111111',experienceKey:'main'});
  const result=await vm.runInNewContext(code,{scope:'scope',search:`?state=${native?'native-state':'generic-state'}&code=synthetic`,sameSession:()=>true,
   APP_CONNECTION_SESSION_PENDING_KEY:'generic',APP_CONNECTION_PENDING_KEY,appConnectionCallbackUsesGeneric,connectionCallback,pendingAppConnection,
   sessionStorage:{getItem:(key:string)=>key==='generic'?generic:null,removeItem:()=>{otherCalls++;}},
   directEmailSessionTag:async()=> 'tag',directEmailCallbackMatches:(search:string)=>new URLSearchParams(search).get('state')==='native-state',
   completeDirectEmailConnection:async()=>{nativeCalls++;return{state:'connected'};},directEmailStatusNotice:()=> 'Connected',
   appConnectionSessionTag:async()=> 'tag',completeAppConnectionSession:async()=>{genericCalls++;throw Error('Invalid generic setup');},user:{id:'owner'},org:{id:'org'},
   api:{fetch:async()=>{otherCalls++;throw Error('Unexpected legacy request');}},JSON,Error,encodeURIComponent});
  assert.equal(nativeCalls,native?1:0);assert.equal(genericCalls,native?0:1);assert.equal(otherCalls,0);assert.equal(result.success,native);
 }
});
