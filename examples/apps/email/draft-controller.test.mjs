import test from 'node:test';import assert from 'node:assert/strict';import{createDraftController}from'./draft-controller.mjs';
const tick=ms=>new Promise(r=>setTimeout(r,ms));
const initial=()=>({mode:'compose',to:'person@test',subject:'Subject',body:'Body',reply_record_id:''});
test('debounced draft writes serialize CAS and save latest edits with honest status',async()=>{
 let value=initial(),active=0,max=0,revision=0,stored,writes=0;const sdk={async putPrivateState(key,id,expected,next){assert.equal(expected,revision);active++;max=Math.max(max,active);writes++;await tick(25);stored={...next};revision++;active--;return{item:{revision}};}};
 let changes=0;const controller=createDraftController(sdk,{snapshot:()=>value,onChange(){changes++;},uuid:()=> 'draft1',delay:5});controller.change();assert.equal(controller.current.status,'Unsaved changes');assert.equal(changes,1);await tick(10);assert.equal(controller.current.status,'Saving…');value={...value,body:'Latest edit'};controller.change();assert.equal(controller.current.status,'Unsaved changes');await controller.save();assert.equal(max,1);assert.equal(stored.body,'Latest edit');assert.equal(controller.current.revision,2);assert.equal(controller.current.status,'Saved privately');assert.equal(writes,2);
});
test('CAS conflict blocks autosave and new copy is only explicit, never last-write-wins',async()=>{
 let calls=0;const sdk={async putPrivateState(){calls++;throw Error('APP_STATE_CONFLICT');}};const controller=createDraftController(sdk,{snapshot:initial,onChange(){},uuid:()=> 'draft'+calls,delay:5});controller.change();await tick(15);assert(controller.current.blocked);controller.change();await tick(15);await controller.save();assert.equal(calls,1);assert.match(controller.current.status,/changed elsewhere/);await controller.copy();assert.equal(calls,2);
});
test('late old-draft save does not alter replacement draft identity, revision or status',async()=>{
 let finish;const sdk={putPrivateState(){return new Promise(r=>finish=r);}};const controller=createDraftController(sdk,{snapshot:initial,onChange(){},uuid:()=> 'old',delay:5});const saving=controller.save();controller.use('replacement',7);finish({item:{revision:1}});await saving;assert.equal(controller.current.id,'replacement');assert.equal(controller.current.revision,7);assert.equal(controller.current.status,'Saved privately');
});
test('delete uses exact current revision and new copy never resurrects tombstoned identity',async()=>{
 let deleted;const sdk={async deletePrivateState(key,id,revision){deleted={key,id,revision};return{operation:'delete'};},async putPrivateState(key,id,revision){assert.equal(id,'fresh');assert.equal(revision,0);return{item:{revision:1}};}};const controller=createDraftController(sdk,{snapshot:initial,onChange(){},uuid:()=> 'fresh'});controller.use('old',3);await controller.remove();assert.deepEqual(deleted,{key:'drafts',id:'old',revision:3});assert.equal(controller.current.id,null);await controller.save();assert.equal(controller.current.id,'fresh');
});
test('opaque Worker crypto without randomUUID still creates a cryptographic UUID draft',async()=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'crypto');let fills=0,issued;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues(bytes){fills++;for(let n=0;n<bytes.length;n++)bytes[n]=n+16;return bytes;}}});
 try{const controller=createDraftController({async putPrivateState(key,id,expected){issued=id;assert.equal(expected,0);return{item:{revision:1}};}},{snapshot:initial,onChange(){}});await controller.save();assert.match(issued,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.equal(fills,1);assert.equal(controller.current.status,'Saved privately');}finally{if(prior)Object.defineProperty(globalThis,'crypto',prior);else delete globalThis.crypto;}
});
