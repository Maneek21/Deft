import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailComposeIntent,insertEmailSignature} from './compose-intents.mjs';
const parent={account_id:'account',record_id:'00000000-0000-4000-8000-000000000001',from:'sender@example.test',reply_to:'reply@example.test',to:'owner@example.test, other@example.test',cc:'other@example.test, cc@example.test',subject:'Subject',plain_text:'Body',truncated:false};

test('signature is an explicit idempotent plain/rich edit and rejects unsafe or mismatched HTML',()=>{
 const plain=insertEmailSignature({body:'Hello',signature_text:'Owner'});assert.equal(plain.body,'Hello\n\n-- \nOwner');assert.equal(plain.body_html,'');assert.deepEqual(insertEmailSignature({...plain,signature_text:'Owner'}),plain);
 const rich=insertEmailSignature({body:'Hello',body_html:'<p><strong>Hello</strong></p>',signature_text:'Owner'});assert.equal(rich.body,plain.body);assert.ok(rich.body_html.startsWith('<p><strong>Hello</strong></p>'));
 assert.deepEqual(insertEmailSignature({...rich,signature_text:'Owner'}),rich);assert.throws(()=>insertEmailSignature({body:'Hello',body_html:'<p>Different</p>',signature_text:'Owner'}));
 assert.throws(()=>insertEmailSignature({body:'Hello',body_html:'<p onclick="x">Hello</p>',signature_text:'Owner'}));
});
test('Reply all uses trusted reply target, deduplicates To/Cc and excludes verified sender identities',()=>{
 const result=createEmailComposeIntent({mode:'reply_all',parent,verifiedOwnAliases:['owner@example.test']});
 assert.equal(result.to,'reply@example.test');assert.equal(result.cc,'other@example.test, cc@example.test');
 assert.equal(result.reply_record_id,parent.record_id);assert.deepEqual(Object.keys(result).sort(),['body','cc','mode','reply_record_id','subject','to']);
});
test('Forward creates an editable parent-free suggestion and incomplete parent text fails closed',()=>{
 const forwarded=createEmailComposeIntent({mode:'forward',parent,verifiedOwnAliases:['owner@example.test']});
 assert.equal(forwarded.to,'');assert.equal(forwarded.cc,'');assert.equal(forwarded.reply_record_id,'');assert.equal(forwarded.subject,'Fwd: Subject');
 assert.ok(forwarded.body.includes('From: sender@example.test'));assert.ok(forwarded.body.endsWith('Body'));
 assert.throws(()=>createEmailComposeIntent({mode:'reply',parent:{...parent,truncated:true},verifiedOwnAliases:['owner@example.test']}));
});

test('Reply preserves the parent and returns a frozen six-key intent',()=>{
 const copy=structuredClone(parent),result=createEmailComposeIntent({mode:'reply',parent,verifiedOwnAliases:['owner@example.test']});
 assert.deepEqual(parent,copy);assert.equal(Object.isFrozen(result),true);assert.equal(result.cc,'');assert.equal(result.subject,'Re: Subject');assert.equal(result.body,'\n\nsender@example.test wrote:\n> Body');
 assert.throws(()=>{result.reply_record_id='replacement';},TypeError);
});

test('recipient limits, UUID parent identity, header injection and quote size fail closed',()=>{
 const invoke=overrides=>createEmailComposeIntent({mode:'reply_all',parent:{...parent,...overrides},verifiedOwnAliases:['owner@example.test']});
 assert.throws(()=>invoke({record_id:'provider/42'}));assert.throws(()=>invoke({subject:'Injected\nBcc: hidden@example.test'}));assert.throws(()=>invoke({subject:'s'.repeat(200)}));assert.throws(()=>invoke({plain_text:'x'.repeat(4096)}));
 const recipients=Array.from({length:100},(_,i)=>`recipient${i}@example.test`).join(', ');assert.throws(()=>invoke({to:recipients,cc:''}));
 assert.throws(()=>createEmailComposeIntent({mode:'reply_all',parent,verifiedOwnAliases:['owner@example.test'],maxRecipients:1}));
 assert.throws(()=>createEmailComposeIntent({mode:'reply_all',parent,verifiedOwnAliases:['owner@example.test'],maxRecipients:33}));
});

test('all own aliases are excluded across To and Cc and Reply falls back to From',()=>{
 const result=createEmailComposeIntent({mode:'reply_all',parent:{...parent,reply_to:'',to:'OWNER@example.test, Alias@example.test, sender@example.test',cc:'alias@example.test, cc@example.test'},verifiedOwnAliases:['owner@example.test','alias@example.test']});
 assert.equal(result.to,'sender@example.test');assert.equal(result.cc,'cc@example.test');
});

test('own Sent Reply all uses original To and keeps other Cc with the same trusted UUID',()=>{
 const sent={...parent,from:'maneek.mohan21@gmail.com',reply_to:'',to:'maneek.hyprcstm@gmail.com',cc:''};
 const result=createEmailComposeIntent({mode:'reply_all',parent:sent,verifiedOwnAliases:['maneek.mohan21@gmail.com']});
 assert.equal(result.to,'maneek.hyprcstm@gmail.com');assert.equal(result.cc,'');assert.equal(result.reply_record_id,parent.record_id);
 const cc=createEmailComposeIntent({mode:'reply_all',parent:{...sent,to:'maneek.hyprcstm@gmail.com, alias@example.test, maneek.hyprcstm@gmail.com',cc:'cc@example.test, maneek.hyprcstm@gmail.com, MANEEK.MOHAN21@gmail.com'},verifiedOwnAliases:['maneek.mohan21@gmail.com','alias@example.test']});
 assert.equal(cc.to,'maneek.hyprcstm@gmail.com');assert.equal(cc.cc,'cc@example.test');
});
test('own Sent Reply keeps original To and omits Cc; empty outside recipients fail closed',()=>{
 const sent={...parent,from:'OWNER@example.test',reply_to:'',to:'other@example.test',cc:'cc@example.test'};
 assert.equal(createEmailComposeIntent({mode:'reply',parent:sent,verifiedOwnAliases:['owner@example.test']}).to,'other@example.test');
 assert.equal(createEmailComposeIntent({mode:'reply',parent:sent,verifiedOwnAliases:['owner@example.test']}).cc,'');
 assert.throws(()=>createEmailComposeIntent({mode:'reply_all',parent:{...sent,to:'owner@example.test'},verifiedOwnAliases:['owner@example.test']}),/COMPOSE_INTENT_INVALID/);
});
test('sender display names and mixed From cannot forge an own-sent identity; bounds remain strict',()=>{
 const result=createEmailComposeIntent({mode:'reply_all',parent:{...parent,from:'"owner@example.test" <attacker@example.test>',reply_to:'',to:'other@example.test',cc:''},verifiedOwnAliases:['owner@example.test']});
 assert.equal(result.to,'owner@example.test <attacker@example.test>');assert.equal(result.cc,'other@example.test');
 const mixed=createEmailComposeIntent({mode:'reply_all',parent:{...parent,from:'owner@example.test, external@example.test',reply_to:'',to:'other@example.test',cc:''},verifiedOwnAliases:['owner@example.test']});assert.equal(mixed.to,'external@example.test');
 assert.throws(()=>createEmailComposeIntent({mode:'reply_all',parent:{...parent,from:'owner@example.test',reply_to:'',to:'other@example.test',cc:'cc@example.test'},verifiedOwnAliases:['owner@example.test'],maxRecipients:1}));
 assert.throws(()=>createEmailComposeIntent({mode:'reply_all',parent:{...parent,from:'owner@example.test',to:'Injected\nBcc: hidden@example.test'},verifiedOwnAliases:['owner@example.test']}));
});
