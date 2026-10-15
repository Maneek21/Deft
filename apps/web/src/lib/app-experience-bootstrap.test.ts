import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { EXPERIENCE_BOOTSTRAP_SCRIPT as source } from './app-experience-bootstrap-script';

test('bootstrap accepts the reviewed96KiB Worker source ceiling and rejects the next character before construction',()=>{
 for(const size of [0,65537,98304,98305]){
  let handler:(event:unknown)=>void=()=>{},workers=0,closed=0;
  const port={close(){closed++;}},session_id='11111111-1111-4111-8111-111111111111';
  // The message must originate from the exact parent object in this realm.
  const context=vm.createContext({parent:{postMessage(){}},location:{href:'https://deft.test/bootstrap'},addEventListener(_kind:string,callback:typeof handler){handler=callback;},
   URL:class extends URL{static createObjectURL(){return'blob:fixture';}static revokeObjectURL(){}},Blob:class{},Worker:class{constructor(){workers++;}postMessage(){}}});
  vm.runInContext(source,context);handler({source:context.parent,origin:'https://deft.test',data:{kind:'start',session_id,worker_source:'x'.repeat(size)},ports:[port]});
  assert.equal(workers,size>0&&size<=98304?1:0);assert.equal(closed,0);
 }
});


test('bootstrap reports sanitized constructor and worker runtime failures for the exact session',()=>{
 for(const phase of ['constructor','runtime']){
  let handler:(event:unknown)=>void=()=>{},closed=0;
  const workers:{onerror?:()=>void}[]=[];
  const messages:unknown[]=[],session_id='11111111-1111-4111-8111-111111111111';
  const context=vm.createContext({parent:{postMessage(value:unknown){messages.push(value);}},location:{href:'https://deft.test/bootstrap'},addEventListener(_kind:string,callback:typeof handler){handler=callback;},
   URL:class extends URL{static createObjectURL(){return'blob:fixture';}static revokeObjectURL(){}},Blob:class{},Worker:class{
    onerror?:()=>void;
    constructor(){if(phase==='constructor')throw Error('PRIVATE_WORKER_DETAILS');workers.push(this);}
    postMessage(){}terminate(){}
   }});
  vm.runInContext(source,context);handler({source:context.parent,origin:'https://deft.test',data:{kind:'start',session_id,worker_source:'reviewed'},ports:[{close(){closed++;}}]});
  if(phase==='runtime')workers[0]?.onerror?.();
  const failure=messages.find((value:any)=>value.kind==='deft_experience_bootstrap_status.v1'&&value.state==='failed');
  assert.deepEqual(JSON.parse(JSON.stringify(failure??null)),{kind:'deft_experience_bootstrap_status.v1',session_id,state:'failed',phase:phase==='constructor'?'worker_start':'worker_runtime'});
  assert.equal(JSON.stringify(messages).includes('PRIVATE_WORKER_DETAILS'),false);
  assert.equal(closed,1);
 }
});
