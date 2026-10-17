import test from'node:test';import assert from'node:assert/strict';import{createDraftController}from'./draft-controller.mjs';
const parent='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
test('reply saves nominate only the exact first/changed parent; unchanged CAS preserves the authenticated envelope',async()=>{
 let value={mode:'reply_all',to:'sender@example.test',cc:'',subject:'Re: Subject',body:'Exact body',reply_record_id:parent},revision=0;const writes=[];
 const controller=createDraftController({async putPrivateState(key,id,expected,captured,options){assert.equal(key,'drafts');assert.equal(expected,revision);writes.push({captured:{...captured},options});return{item:{revision:++revision}};}},{snapshot:()=>value,onChange(){},uuid:()=> '00000000-0000-4000-8000-000000000003'});
 await controller.save();assert.deepEqual(writes[0].options,{source_refs:[{field:'reply_record_id',action_key:'send_message',input_field:'parent_record_id',record_id:parent}]});
 value={...value,body:'Edited text'};await controller.save();assert.equal(writes[1].options,undefined,'Unchanged saved parent does not depend on the old transient TTL');
 value={...value,reply_record_id:other};await controller.save();assert.equal(writes[2].options.source_refs[0].record_id,other);
 value={...value,mode:'compose',reply_record_id:''};await controller.save();assert.equal(writes[3].options,undefined);assert.equal(writes[3].captured.reply_record_id,'');
});
test('freshly reopened reply draft nominates the host-rehydrated UUID rather than worker-supplied provider data',async()=>{
 const value={mode:'reply',to:'sender@example.test',cc:'',subject:'Re: Subject',body:'Saved text',reply_record_id:parent};let options;
 const controller=createDraftController({async readPrivateState(){return{item:{record_id:'draft',revision:4,value}};},async putPrivateState(_key,id,revision,captured,nomination){assert.equal(id,'draft');assert.equal(revision,4);assert.deepEqual(captured,value);options=nomination;return{item:{revision:5}};}},{snapshot:()=>value,onChange(){}});
 const saved=await controller.read('draft');controller.use(saved.record_id,saved.revision);await controller.save();assert.deepEqual(options,{source_refs:[{field:'reply_record_id',action_key:'send_message',input_field:'parent_record_id',record_id:parent}]});
 assert.equal(JSON.stringify(options).includes('locator'),false);assert.equal(JSON.stringify(options).includes('provider'),false);
});
