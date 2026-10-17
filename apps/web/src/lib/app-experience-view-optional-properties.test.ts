import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceBridge,type ExperiencePin} from './app-experience-bridge';
import {createDeftExperienceSdk} from '../../../../packages/app-kit/src/experience-sdk';

const pin:ExperiencePin={org_id:'org_test',user_id:'user_test',app_installation_id:'install_test',app_version_id:'version_test',grant_snapshot_id:'grant_test',lifecycle_epoch:1,grant_epoch:1,session_id:'11111111-1111-4111-8111-111111111111',session_epoch:1};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const view=()=>({root:{kind:'button',id:'compose',label:'Compose',description:undefined,disabled:false},navigation:undefined});
function fixture(){
 const views:unknown[]=[],sent:unknown[]=[];let closed=0,calls=0;
 const port={onmessage:null as ((event:MessageEvent)=>void)|null,postMessage(value:unknown){sent.push(value);},close(){closed++;}};
 const bridge=createExperienceBridge({port,pin,resourceKeys:[],actionKeys:[],broker:{isLive:()=>{calls++;return true;},runStatus:async()=>({state:'succeeded'})},onView:value=>views.push(value)});
 return {port,bridge,views,sent,closed:()=>closed,calls:()=>calls,receive:(value:unknown)=>port.onmessage?.({data:value} as MessageEvent)};
}
const envelope=(extra:Record<string,unknown>)=>({version:'deft.experience_bridge.v1',session_id:pin.session_id,sequence:1,...extra});

test('published SDK optional view properties survive structured clone and render as clean validated nodes',async()=>{
 const f=fixture(),worker={onmessage:null as ((event:MessageEvent)=>void)|null,postMessage(value:unknown){f.receive(structuredClone(value));},close(){}};
 const sdk=createDeftExperienceSdk(worker,pin.session_id);
 sdk.render(view());await tick();
 assert.equal(f.bridge.active,true);assert.equal(f.closed(),0);assert.equal(f.views.length,1);
 assert.deepEqual(f.views[0],{root:{kind:'button',id:'compose',label:'Compose',disabled:false}});
 assert.equal(Object.hasOwn((f.views[0] as {root:object}).root,'description'),false);
 sdk.close();f.bridge.revoke();
});

test('view compatibility rejects unknown or required undefined keys and undefined array items before authority',async()=>{
 const bad=[
  {...view(),unexpected:undefined},
  {root:{...view().root,unexpected:undefined}},
  {root:undefined},
  {root:{...view().root,label:undefined}},
  {root:{kind:'stack',id:'list',children:[undefined]}},
  {...view(),navigation:[undefined]},
  {schema_version:'deft.experience_view.v2',capabilities:[undefined],root:view().root},
 ];
 for(const value of bad){const f=fixture();f.receive(envelope({kind:'view',view:value}));await tick();assert.equal(f.bridge.active,false);assert.equal(f.closed(),1);assert.equal(f.views.length,0);assert.equal(f.calls(),0);}
});

test('view compatibility leaves request inputs and broker outputs strict',async()=>{
 for(const input of [{run_id:'run_test',nested:undefined},[undefined]]){
  const f=fixture();f.receive(envelope({kind:'request',request_id:'request_1',operation:'run_status',input}));await tick();assert.equal(f.bridge.active,false);assert.equal(f.calls(),0);assert.equal(f.views.length,0);
 }
 const port={onmessage:null as ((event:MessageEvent)=>void)|null,sent:[] as unknown[],postMessage(value:unknown){this.sent.push(value);},close(){}};
 const bridge=createExperienceBridge({port,pin,resourceKeys:[],actionKeys:[],broker:{isLive:()=>true,runStatus:async()=>({nested:undefined,private:'must not cross the port'})},onView(){assert.fail('no view');}});
 port.onmessage?.({data:envelope({kind:'request',request_id:'request_1',operation:'run_status',input:{run_id:'run_test'}})} as MessageEvent);await tick();
 // Revoking invalid broker JSON settles the pending request with only the
 // existing closed error envelope, never the invalid/private value.
 assert.deepEqual(port.sent,[{version:'deft.experience_bridge.v1',kind:'response',session_id:pin.session_id,request_id:'request_1',ok:false,code:'UNAVAILABLE'}]);
 await tick();assert.equal(port.sent.length,1,'No late successful/private reply');assert.equal(bridge.active,false);bridge.revoke();
});

test('optional view properties retain accessor cycle numeric key depth byte and replay fences',async()=>{
 let getterCalls=0;
 const accessor={kind:'button',id:'compose',get label(){getterCalls++;return 'Compose';},description:undefined};
 const cycle:any={kind:'stack',id:'cycle',children:[]};cycle.children.push(cycle);
 let deep:any={kind:'button',id:'bottom',label:'Bottom',description:undefined};for(let i=0;i<24;i++)deep={kind:'stack',id:'deep_'+i,children:[deep],title:undefined};
 const manyKeys={...view().root,...Object.fromEntries(Array.from({length:65},(_,i)=>['absent_'+i,undefined]))};
 const manyNodes={kind:'stack',id:'many',children:Array.from({length:5},(_,i)=>({kind:'stack',id:'group_'+i,children:Array.from({length:52},(_,j)=>({kind:'button',id:'button_'+i+'_'+j,label:'Button',description:undefined}))}))};
 const oversized={kind:'stack',id:'big',children:Array.from({length:5},(_,i)=>({kind:'document',id:'doc_'+i,format:'plain',content:'x'.repeat(16000),title:undefined}))};
 for(const root of [accessor,cycle,deep,manyKeys,manyNodes,oversized,{...view().root,disabled:NaN}]){
  const f=fixture();f.receive(envelope({kind:'view',view:{root}}));await tick();assert.equal(f.bridge.active,false);assert.equal(f.views.length,0);assert.equal(f.calls(),0);
 }
 assert.equal(getterCalls,0,'inspect descriptors before reading accessor values');
 const f=fixture();f.receive(envelope({kind:'view',view:view()}));await tick();assert.equal(f.views.length,1);f.receive(envelope({kind:'view',view:view()}));assert.equal(f.bridge.active,false);assert.equal(f.closed(),1);
 const spoof=fixture();spoof.receive({...envelope({kind:'view',view:view()}),session_id:'foreign_session'});assert.equal(spoof.bridge.active,false);assert.equal(spoof.views.length,0);
});
