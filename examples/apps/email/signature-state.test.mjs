import test from 'node:test';import assert from 'node:assert/strict';
import {createSignatureState} from './signature-state.mjs';
test('signature uses one scoped private record and blocks another write after lost CAS response',async()=>{
 let writes=0;const state=createSignatureState({listPrivateState:async key=>{assert.equal(key,'preferences');return{items:[]};},putPrivateState:async()=>{writes++;throw Error('lost');}},{uuid:()=> 'record'});
 await state.load();state.edit('Regards\nAlex');await state.save();assert.equal(writes,1);assert.equal(state.current.available,false);await assert.rejects(()=>state.save());assert.equal(writes,1);
});
test('signature refuses ambiguous records and invalid content without guessing or overwriting',async()=>{
 const state=createSignatureState({listPrivateState:async()=>({items:[{},{}]})},{uuid:()=> 'record'});await state.load();assert.equal(state.current.available,false);
 const empty=createSignatureState({listPrivateState:async()=>({items:[]})},{uuid:()=> 'record'});await empty.load();empty.edit('ok');empty.edit('bad\0');assert.equal(empty.current.value,'ok');
});
