import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the component's actual callbacks; no copied handshake implementation.
const path=new URL('../components/apps/installed-app-experience.tsx',import.meta.url);
const source=ts.createSourceFile(path.pathname,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const callbacks:Record<string,string>={};
function visit(node:ts.Node){
  if(ts.isVariableDeclaration(node)&&['startWorker','onBootstrapReady'].includes(node.name.getText(source)))
    callbacks[node.name.getText(source)]=node.initializer!.getText(source);
  if(ts.isMethodDeclaration(node)&&node.name.getText(source)==='change'&&node.getText(source).includes("state === 'denied'"))
    callbacks.change='function'+node.getText(source).slice('change'.length);
  ts.forEachChild(node,visit);
}
visit(source);
assert.equal(Object.keys(callbacks).length,3);

function mount(){
  const context=vm.createContext({});
  const code=`
    let identity=true,authority=false,started=false,bootstrapReady=false,unavailable=false,latestView=null,remembered=0;
    const transfers=[],frame={contentWindow:{postMessage(...args){transfers.push(args);}}},port={port2:{}},
      session={pin:{session_id:'11111111-1111-4111-8111-111111111111'},bundle:{worker_source:'reviewed'}},
      document={hidden:false},viewHost={current:null},navigationOwner={},rendered={current:false};
    const identityCurrent=()=>identity,authorityCurrent=()=>identity&&authority,
      locallyCurrent=()=>authorityCurrent()&&!unavailable&&!document.hidden,
      startup={ready(){remembered++;},started(){},fail(){}},experienceStartupStatus=()=>null,
      setConnectionUnavailable=()=>{},clearNavigation=()=>{},setSource=()=>{},setRunReview=()=>{},
      setSuspended=()=>{},stop=()=>{},publishViewNavigation=()=>{},renderHostView=()=>{},suspendExperienceView=()=>{};
    const startWorker=${callbacks.startWorker};
    const onBootstrapReady=${callbacks.onBootstrapReady};
    const change=${callbacks.change};
    globalThis.controls={
      ready(patch={}){onBootstrapReady({source:frame.contentWindow,origin:'null',data:{kind:'deft_experience_bootstrap_ready.v1'},...patch});},
      current(value){authority=value;},hidden(value){document.hidden=value;},retire(){identity=false;},
      available(){change('available');},
      state(){return {remembered,starts:transfers.length,bootstrapReady,
        exactTransfer:transfers.every(args=>args[0].session_id===session.pin.session_id&&args[1]==='*'&&args[2].length===1&&args[2][0]===port.port2)};}
    };
  `;
  vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
  return context.controls as {ready(patch?:Record<string,unknown>):void;current(value:boolean):void;hidden(value:boolean):void;
    retire():void;available():void;state():{remembered:number;starts:number;bootstrapReady:boolean;exactTransfer:boolean}};
}

test('trusted readiness survives a renewable authority gap and transfers the port exactly once after recovery',()=>{
  const page=mount();page.ready();
  assert.equal(page.state().bootstrapReady,true);assert.equal(page.state().starts,0);
  page.available();assert.equal(page.state().starts,0,'availability alone cannot override missing live authority');
  page.current(true);page.available();page.available();page.ready();
  assert.equal(page.state().starts,1);assert.equal(page.state().exactTransfer,true);
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
