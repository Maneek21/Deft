import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the component's actual callbacks; no copied handshake implementation.
const path=new URL('../components/apps/installed-app-experience.tsx',import.meta.url);
const source=ts.createSourceFile(path.pathname,readFileSync(process.env.DEFT_EXPERIENCE_COMPONENT_SOURCE??path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const callbacks:Record<string,string>={};
const diagnostics:Record<string,string>={};
const transport:Record<string,string>={},frameSetup:string[]=[];
function visit(node:ts.Node){
  if(ts.isVariableDeclaration(node)&&['startWorker','onBootstrapReady'].includes(node.name.getText(source)))
    callbacks[node.name.getText(source)]=node.initializer!.getText(source);
  if(ts.isVariableDeclaration(node)&&['bootstrapDiagnostic','onBootstrapLoad'].includes(node.name.getText(source)))diagnostics[node.name.getText(source)]=node.initializer!.getText(source);
  if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='startup'&&node.initializer&&ts.isCallExpression(node.initializer))diagnostics.failed=node.initializer.arguments[0].getText(source);
  if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(source)==='data-experience-startup-phase'))diagnostics.alert=node.getText(source);
  if(ts.isVariableDeclaration(node)&&['frame','stop','attachBootstrap'].includes(node.name.getText(source)))transport[node.name.getText(source)]=node.initializer!.getText(source);
  if(ts.isExpressionStatement(node)&&/^frame\.(title\s*=|sandbox\.add\(|referrerPolicy\s*=|setAttribute\(|style\.cssText\s*=|src\s*=)/.test(node.getText(source)))frameSetup.push(node.getText(source));
  if(ts.isExpressionStatement(node)&&node.getText(source)==='document.body.append(frame);')transport.append=node.getText(source);
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]&&ts.isArrowFunction(node.arguments[0])&&ts.isBlock(node.arguments[0].body)&&node.arguments[0].body.getText(source).includes('document.body.append(frame)')){
    const cleanup=node.arguments[0].body.statements.findLast(statement=>ts.isReturnStatement(statement)&&statement.expression&&ts.isArrowFunction(statement.expression));
    if(cleanup&&ts.isReturnStatement(cleanup))transport.cleanup=cleanup.expression!.getText(source);
  }
  if(ts.isMethodDeclaration(node)&&node.name.getText(source)==='change'&&node.getText(source).includes("state === 'denied'"))
    callbacks.change='function'+node.getText(source).slice('change'.length);
  ts.forEachChild(node,visit);
}
visit(source);
assert.equal(Object.keys(callbacks).length,3);

function mount(){
  const context=vm.createContext({});
  const code=`
    let identity=true,authority=false,started=false,bootstrapReady=false,unavailable=false,latestView=null,remembered=0,stopped=false,snapshot,phase,startupDiagnostic=null,startupPhase=null,error='';
    const React={createElement(type,props,...children){return {type,props,children};}};
    const bootstrapDiagnostic=${diagnostics.bootstrapDiagnostic??'{}'};
    const transfers=[],frame={contentWindow:{postMessage(...args){transfers.push(args);}}},port={port2:{}},
      session={pin:{session_id:'11111111-1111-4111-8111-111111111111'},bundle:{worker_source:'reviewed'}},
      document={hidden:false},viewHost={current:null},navigationOwner={},rendered={current:false};
    const identityCurrent=()=>identity,authorityCurrent=()=>identity&&authority,
      locallyCurrent=()=>authorityCurrent()&&!unavailable&&!document.hidden,
      startup={ready(){remembered++;},started(){},fail(){}},experienceStartupStatus=()=>null,
      setConnectionUnavailable=()=>{},clearNavigation=()=>{},setSource=()=>{},setRunReview=()=>{},
      setSuspended=()=>{},stop=()=>{stopped=true;identity=false;for(const key in bootstrapDiagnostic)bootstrapDiagnostic[key]=false;},publishViewNavigation=()=>{},renderHostView=()=>{},suspendExperienceView=()=>{},
      setStartupDiagnostic=value=>{snapshot=value;startupDiagnostic=value;},setStartupPhase=value=>{phase=value;startupPhase=value;},setError=value=>{error=value;};
    const failed=${diagnostics.failed};
    const onBootstrapLoad=${diagnostics.onBootstrapLoad??'()=>{}'};
    const startWorker=${callbacks.startWorker};
    const onBootstrapReady=${callbacks.onBootstrapReady};
    const change=${callbacks.change};
    globalThis.controls={
      ready(patch={}){onBootstrapReady({source:frame.contentWindow,origin:'null',data:{kind:'deft_experience_bootstrap_ready.v1'},...patch});},
      current(value){authority=value;},hidden(value){document.hidden=value;},retire(){identity=false;},
      alert(){return ${diagnostics.alert??'null'};},available(){change('available');},load(){onBootstrapLoad();},timeout(){failed('bootstrap');},cleanup(){stopped=true;identity=false;},diagnostic(){return JSON.parse(JSON.stringify({current:bootstrapDiagnostic,snapshot,phase}));},
      state(){return {remembered,starts:transfers.length,bootstrapReady,
        exactTransfer:transfers.every(args=>args[0].session_id===session.pin.session_id&&args[1]==='*'&&args[2].length===1&&args[2][0]===port.port2)};}
    };
  `;
  vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React}}).outputText,context);
  return context.controls as {ready(patch?:Record<string,unknown>):void;current(value:boolean):void;hidden(value:boolean):void;
    retire():void;alert():{props:Record<string,unknown>};available():void;load():void;timeout():void;cleanup():void;diagnostic():{current:Record<string,boolean>;snapshot?:string;phase?:string};state():{remembered:number;starts:number;bootstrapReady:boolean;exactTransfer:boolean}};
}

test('trusted readiness survives a renewable authority gap and transfers the port exactly once after recovery',()=>{
  const page=mount();page.ready();
  assert.equal(page.state().bootstrapReady,true);assert.equal(page.state().starts,0);
  page.available();assert.equal(page.state().starts,0,'availability alone cannot override missing live authority');
  page.current(true);page.available();page.available();page.ready();
  assert.equal(page.state().starts,1);assert.equal(page.state().exactTransfer,true);
});

// A shared DOM seam executes the component's actual creation, attach, stop and
// effect-cleanup code. It verifies ownership; it does not simulate navigation.
type TransportFrame={parentNode:TransportBody|null;src:string;sandbox:{values:string[]};attributes:Record<string,string>;style:{cssText:string};referrerPolicy:string;contentWindow:object};
type TransportBody={children:TransportFrame[];append(frame:TransportFrame):void};
function mountTransport(body:TransportBody,sessionId:string){
 const context=vm.createContext({body,sessionId});
 const code=`
 let stopped=false,started=false,bootstrapReady=false,unavailable=false,latestView=null,trustedDocument=null,revoked=false,disposed=false,retired=0;
 const transfers=[],listeners=new Set(),document={body,hidden:false,removeEventListener(){},createElement(){const handlers=new Map();return {title:'',sandbox:{values:[],add(value){this.values.push(value);}},style:{cssText:''},attributes:{},setAttribute(key,value){this.attributes[key]=value;},addEventListener(key,value){handlers.set(key,value);},removeEventListener(key,value){if(handlers.get(key)===value)handlers.delete(key);},get listenerCount(){return handlers.size;},remove(){const at=body.children.indexOf(this);if(at>=0)body.children.splice(at,1);this.parentNode=null;},contentWindow:{postMessage(...args){transfers.push(args);}}};}};
 const frame=${transport.frame};${frameSetup.join('\n')}
 const bootstrapDiagnostic=${diagnostics.bootstrapDiagnostic},onBootstrapLoad=${diagnostics.onBootstrapLoad};
 const identityCurrent=()=>!stopped,authorityCurrent=()=>identityCurrent(),locallyCurrent=()=>authorityCurrent()&&!unavailable&&!document.hidden;
 const startup={ready(){},started(){},fail(){},dispose(){disposed=true;}},experienceStartupStatus=()=>null,port={port2:{close(){}}},session={pin:{session_id:sessionId},bundle:{worker_source:'reviewed'}},viewHost={current:null};
 const noop=()=>{},setNominatedSource=noop,setPreferencesNode=noop,setSuspended=noop,setSource=noop,setRunReview=noop,setConnectionUnavailable=noop,setError=noop,clearNavigation=noop,closeComposer=noop,closeConfirmation=noop;
 const sourceNominationAbort={abort:noop},sourceReview={clear:noop},sourcePresentations=new Map(),presentationDisposals=new Map(),preferencesEvent={current:null},intakePrepare={current:null},readingPreferencesChanged={current:null},ensureAuthority={current:null};
 const accounts={close:noop},connection={dispose:noop},lease=null,navigationOwner={},rendered={current:false},bridge={revoke(){revoked=true;}},api={fetch(){retired++;return Promise.resolve();}},root='/synthetic',childTimer=0;let flushRecordWrites={current:null};
 const stop=${transport.stop},startWorker=${callbacks.startWorker},onBootstrapReady=${callbacks.onBootstrapReady};
 const addEventListener=(kind,handler)=>listeners.add(handler),removeEventListener=(kind,handler)=>listeners.delete(handler),clearInterval=noop,clearTimeout=noop;
 const poll=0,checkConnection=noop,onStorage=noop,socket=null,onAppChange=noop,suspension={dispose:noop},hidden=noop,pageHide=noop,expiry=undefined,refreshNavigation={current:null},leaseCurrent={current:null},stopWorker={current:stop},connectionNavigation={current:null},connectionSessionRetirementRequired=()=>false,retireSession=noop;
 const cleanup=${transport.cleanup};
 addEventListener('message',onBootstrapReady);frame.addEventListener('load',onBootstrapLoad);${transport.append}
 globalThis.controls={frame,ready(patch={}){onBootstrapReady({source:frame.contentWindow,origin:'null',data:{kind:'deft_experience_bootstrap_ready.v1'},...patch});},stop:()=>stop(false),cleanup,state:()=>({starts:transfers.filter(args=>args[0].kind==='start').length,stops:transfers.filter(args=>args[0].kind==='stop').length,revoked,disposed,retired,loadListeners:frame.listenerCount,messageListeners:listeners.size})};
 `;
 vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 return context.controls as {frame:TransportFrame;ready(patch?:Record<string,unknown>):void;stop():void;cleanup():void;state():{starts:number;stops:number;revoked:boolean;disposed:boolean;retired:number;loadListeners:number;messageListeners:number}};
}

test('actual transport attach uses stable body and both retirement paths remove only their own opaque frame',()=>{
 assert.ok(transport.append&&transport.cleanup&&transport.stop);
 const body:TransportBody={children:[],append(frame){this.children.push(frame);frame.parentNode=this;}};
 for(const cleanup of ['stop','cleanup']as const){
  const page=mountTransport(body,'11111111-1111-4111-8111-111111111111');
  assert.equal(page.frame.parentNode,body);assert.equal(page.frame.src,undefined,'transport must not trigger HTTP frame navigation');assert.equal(page.frame.sandbox.values.join(','),'allow-scripts');assert.equal(page.frame.attributes['aria-hidden'],'true');
  assert.match(page.frame.style.cssText,/position:fixed;top:0;left:0;/);assert.equal(page.frame.referrerPolicy,'no-referrer');
  page.ready();assert.equal(page.state().starts,1);page[cleanup]();assert.equal(body.children.length,0);assert.equal(page.state().loadListeners,0);assert.equal(page.state().disposed,true);assert.equal(page.state().revoked,true);assert.equal(page.state().retired,0);
  page.ready();assert.equal(page.state().starts,1,'retired frame cannot transfer again');
  if(cleanup==='cleanup')assert.equal(page.state().messageListeners,0);
 }
});

test('two actual body-owned transports reject foreign and stale READY without retiring or starting the other instance',()=>{
 const body:TransportBody={children:[],append(frame){this.children.push(frame);frame.parentNode=this;}};
 const first=mountTransport(body,'11111111-1111-4111-8111-111111111111'),second=mountTransport(body,'22222222-2222-4222-8222-222222222222');assert.equal(body.children.length,2);
 second.ready({source:first.frame.contentWindow});second.ready({origin:'https://foreign.test'});second.ready({data:{kind:'deft_experience_bootstrap_ready.v1',extra:true}});assert.equal(second.state().starts,0);
 first.stop();assert.equal(body.children.length,1);assert.equal(body.children[0],second.frame);second.ready({source:first.frame.contentWindow});assert.equal(second.state().starts,0);
 second.ready();second.ready();assert.equal(second.state().starts,1);first.cleanup();assert.equal(body.children[0],second.frame);second.cleanup();assert.equal(body.children.length,0);assert.equal(second.state().messageListeners,0);
});

test('readiness cannot start a hidden or retired page',()=>{
  const hidden=mount();hidden.current(true);hidden.hidden(true);hidden.ready();hidden.available();
  assert.equal(hidden.state().starts,0);hidden.hidden(false);hidden.available();assert.equal(hidden.state().starts,1);
  const retired=mount();retired.current(true);retired.retire();retired.ready();retired.available();
  assert.equal(retired.state().remembered,0);assert.equal(retired.state().starts,0);
  const waiting=mount();waiting.ready();waiting.retire();waiting.current(true);waiting.available();
  assert.equal(waiting.state().starts,0,'retirement after readiness still forbids the original port transfer');
});

test('foreign frames, nonopaque origins and nonexact readiness envelopes are ignored',()=>{
  for(const patch of [{source:{}},{origin:'https://deft.test'},{data:{kind:'wrong'}},
    {data:{kind:'deft_experience_bootstrap_ready.v1',session_id:'old'}},{data:{kind:'deft_experience_bootstrap_ready.v1',extra:true}}]){
    const page=mount();page.current(true);page.ready(patch);page.available();
    assert.equal(page.state().remembered,0);assert.equal(page.state().starts,0);
  }
});


test('actual component callbacks retain load/readiness booleans before timeout retirement, without private data',()=>{
 const page=mount();page.current(true);page.load();page.ready();page.timeout();
 const captured=JSON.parse(page.diagnostic().snapshot??'{}');
 assert.equal(captured.load_observed,true);assert.equal(captured.ready_candidate_seen,true);
 assert.equal(captured.ready_source_match,true);assert.equal(captured.ready_origin_opaque,true);assert.equal(captured.ready_shape_exact,true);assert.equal(captured.ready_identity_current,true);
 assert.equal(captured.ready_accepted,true);assert.equal(captured.start_transfer_attempted,true);
 assert.equal(captured.identity_current,true);assert.equal(captured.authority_current,true);assert.equal(captured.visible,true);assert.equal(captured.connection_available,true);
 assert.equal(page.alert().props['data-experience-startup-diagnostic'],page.diagnostic().snapshot);
 assert.equal(page.alert().props['data-experience-startup-phase'],'bootstrap');
 assert.equal(page.diagnostic().phase,'bootstrap');assert.ok(Object.values(captured).every(value=>typeof value==='boolean'));
 assert.equal(page.diagnostic().current.load_observed,false,'timeout captured before stop cleared local state');
});

test('actual readiness rejection reports each guard without admitting the event or serializing payload',()=>{
 for(const [patch,key]of [[{source:{}},'ready_source_match'],[{origin:'https://PRIVATE_ORIGIN.test'},'ready_origin_opaque'],[{data:{kind:'deft_experience_bootstrap_ready.v1',PRIVATE_FIELD:'PRIVATE_PAYLOAD'}},'ready_shape_exact']]as const){
  const page=mount();page.current(true);page.ready(patch);page.timeout();const captured=JSON.parse(page.diagnostic().snapshot??'{}');
  assert.equal(captured.ready_candidate_seen,true);assert.equal(captured[key],false);assert.equal(captured.ready_accepted,false);assert.equal(page.state().starts,0);
  assert.equal(JSON.stringify(captured).includes('PRIVATE'),false);assert.ok(Object.values(captured).every(value=>typeof value==='boolean'));
 }
 const retired=mount();retired.retire();retired.ready();retired.timeout();assert.equal(JSON.parse(retired.diagnostic().snapshot??'{}').ready_identity_current,false);assert.equal(retired.state().starts,0);
});

test('readiness before load remains valid and late callbacks cannot change a cleaned lifetime diagnostic',()=>{
 const page=mount();page.current(true);page.ready();assert.equal(page.state().starts,1);assert.equal(page.diagnostic().current.load_observed,false);
 page.load();assert.equal(page.diagnostic().current.load_observed,true);page.cleanup();const before=page.diagnostic();page.load();page.ready({origin:'private'});assert.deepEqual(page.diagnostic(),before);assert.equal(page.state().starts,1);
 const noReady=mount();noReady.load();noReady.timeout();const captured=JSON.parse(noReady.diagnostic().snapshot??'{}');assert.equal(captured.load_observed,true);assert.equal(captured.ready_candidate_seen,false);assert.equal(captured.start_transfer_attempted,false);
});


test('actual async srcdoc attachment retires safely and reports hash/build failure immediately',async()=>{
 for(const mode of ['current','retired','rejected']as const){
  const context=vm.createContext({mode});
  vm.runInContext(`
   let current=true,appended=0,failed=0,closed=0,revoked=0,release,reject;
   const document={body:{append(value){appended++;}}},frame={},location={origin:'https://deft.test'},port={port2:{close(){closed++;}}},bridge={revoke(){revoked++;}};
   const identityCurrent=()=>current,startup={fail(phase){if(phase!=='bootstrap')throw Error('wrong phase');failed++;}};
   const buildExperienceBootstrapSrcdoc=()=>new Promise((yes,no)=>{release=yes;reject=no;});
   const attachBootstrap=${transport.attachBootstrap};
   const pending=attachBootstrap();
   if(mode==='retired')current=false;
   if(mode==='rejected')reject(Error('synthetic digest failure'));else release('trusted-srcdoc');
   globalThis.result=pending.then(()=>({appended,failed,closed,revoked,srcdoc:frame.srcdoc}));
  `,context);
  const result=await context.result;
  assert.equal(result.appended,mode==='current'?1:0);
  assert.equal(result.failed,mode==='rejected'?1:0);
  assert.equal(result.closed,mode==='retired'?1:0);assert.equal(result.revoked,mode==='retired'?1:0);
  assert.equal(result.srcdoc,mode==='current'?'trusted-srcdoc':undefined);
 }
});
