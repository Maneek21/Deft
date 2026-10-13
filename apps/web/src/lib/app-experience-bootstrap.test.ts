import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../../public/app-experience-bootstrap.js',import.meta.url),'utf8');
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
