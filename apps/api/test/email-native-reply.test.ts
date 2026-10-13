import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmailNativeReplyResolver} from '../src/lib/email-native-reply.js';
const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},actor={user_id:'owner',web_session_id:'sid',access_expires_at:Date.now()+60000},logical='mail_'+'a'.repeat(64);
function fixture(change=false,badReferences=false){let reads=0,checks=0;
 const record={account_id:scope.account_id,logical_message_id:logical,revision:'one',provider_source:{provider:'gmail',locator:{thread_id:'private-thread'}}};
 const store={readMessage:async()=>({...structuredClone(record),revision:++reads>1&&change?'two':'one'})} as any;
 const content={readPresentation:async()=>({account_id:scope.account_id,provider:'gmail',logical_message_id:logical,presentation:{metadata:{
  message_id:'<parent@example.test>',references:badReferences?'<valid@example.test> injected':'<earlier@example.test>',reply_from:'sender@example.test',reply_to:'reply@example.test',reply_to_list:'owner@example.test',reply_cc:'copy@example.test'}}})} as any;
 return {resolve:createEmailNativeReplyResolver(store,content),check:async()=>{checks++;},get checks(){return checks;}};
}
test('reply context joins current original headers with private exact Gmail thread id',async()=>{
 const f=fixture(),value=await f.resolve(actor,scope,logical,f.check);assert.equal(value.thread_id,'private-thread');assert.equal(value.message_id,'<parent@example.test>');
 assert.deepEqual(value.references,['<earlier@example.test>']);assert.equal(value.reply_to,'reply@example.test');assert.equal(value.to,'owner@example.test');assert.ok(f.checks>=3);
});
test('changed cache identity, malformed reference chain and revoked authority cannot produce reply context',async()=>{
 const changed=fixture(true);await assert.rejects(changed.resolve(actor,scope,logical,changed.check),/EMAIL_SEND_REPLY_UNAVAILABLE/);
 const invalid=fixture(false,true);await assert.rejects(invalid.resolve(actor,scope,logical,invalid.check),/EMAIL_SEND_REPLY_UNAVAILABLE/);
 const revoked=fixture();await assert.rejects(revoked.resolve(actor,scope,logical,async()=>{throw Error('Revoked');}),/Revoked/);
});
