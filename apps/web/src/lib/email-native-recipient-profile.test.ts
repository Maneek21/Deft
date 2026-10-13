import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeReplyCompose} from './email-native-reply';
import {parseNativeEmailPresentation,type NativeReaderPresentation} from './email-native-reader';
import {createNativeDraftWriter,type NativeDraft} from './email-native-drafts';

const recipients=(count:number)=>Array.from({length:count},(_,index)=>`Person ${index} <r${index}@example.test>`).join(', ');
const source=(to:string,cc='',from='Sender <sender@example.test>'):NativeReaderPresentation=>({schema_version:'deft.email_presentation.v1',account_id:'account',provider:'gmail',logical_message_id:'mail_'+'a'.repeat(64),source_digest:'b'.repeat(64),content_trust:'unsanitized',files:[],presentation:{format:'plain',content:'Readable complete body.',plain_text:'Readable complete body.',truncated:false,images:[],headers:[],metadata:{account_id:'account',primary_address:'owner@example.test',verified_sender_identities:'["owner@example.test"]',reply_from:from,reply_to:'',reply_to_list:to,reply_cc:cc,subject:'Broadcast',message_id:'<parent@example.test>'}}});
test('native presentation metadata enforces16384 UTF8 bytes rather than character count',()=>{
 const exact='é'.repeat(8192),presentation=source('');presentation.presentation.metadata.reply_to_list=exact;
 assert.equal(parseNativeEmailPresentation(presentation,'account',presentation.logical_message_id).presentation.metadata.reply_to_list,exact);
 assert.throws(()=>parseNativeEmailPresentation({...presentation,presentation:{...presentation.presentation,metadata:{...presentation.presentation.metadata,reply_to_list:exact+'a'}}},'account',presentation.logical_message_id));
});
test('ordinary33-recipient Reply-all preserves every eligible name/order and a saved draft roundtrip/edit',async()=>{
 const presentation=source(recipients(33)),seed=createNativeReplyCompose(presentation,'reply_all');assert.equal(seed.initialContent.to,'Sender <sender@example.test>');assert.equal(seed.initialContent.cc,recipients(33));assert.equal(seed.initialContent.bcc,'');assert.match(seed.initialContent.body,/> Readable complete body/);
 const saved:Array<NativeDraft['content']>=[];const writer=createNativeDraftWriter({accountId:'account',draftId:'11111111-1111-4111-8111-111111111111',initialContent:seed.initialContent,current:()=>true,change:()=>{},api:{read:async()=>{throw Error('unused');},save:async(_account,id,revision,content)=>{saved.push(structuredClone(content));return {draft_id:id,revision:revision+1,status:'draft',content:structuredClone(content),origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-07T00:00:00Z',updated_at:'2026-10-07T00:00:00Z'};}}});
 try{assert.equal(await writer.save(),true);assert.equal(saved[0].cc,recipients(33));writer.edit({...writer.snapshot().content,cc:recipients(32)});assert.equal(await writer.save(),true);assert.equal(saved[1].cc,recipients(32));assert.equal(writer.snapshot().dirty,false);}finally{writer.dispose();}
});
test('unavailable oversized header retains body, allows independent inbound Reply/Forward, refuses Reply-all and own-sent Reply',()=>{
 const presentation={...source(''),reply_seed_unavailable:['reply_to_list' as const]};const parsed=parseNativeEmailPresentation(presentation,'account',presentation.logical_message_id);assert.equal(parsed.presentation.content,'Readable complete body.');
 assert.equal(createNativeReplyCompose(parsed,'reply').initialContent.to,'Sender <sender@example.test>');assert.throws(()=>createNativeReplyCompose(parsed,'reply_all'));assert.equal(createNativeReplyCompose(parsed,'forward').initialContent.to,'');
 const own={...presentation,presentation:{...presentation.presentation,metadata:{...presentation.presentation.metadata,reply_from:'owner@example.test'}}};assert.throws(()=>createNativeReplyCompose(own,'reply'));assert.throws(()=>createNativeReplyCompose(own,'reply_all'));assert.match(createNativeReplyCompose(own,'forward').initialContent.body,/Readable complete body/);
});
test('native Reply-all final200 boundary applies after self exclusion/dedup and never trims aggregate201',()=>{
 const accepted=createNativeReplyCompose(source(recipients(199)),'reply_all');assert.equal(accepted.initialContent.cc,recipients(199));assert.throws(()=>createNativeReplyCompose(source(recipients(200)),'reply_all'));
 const duplicates=source(recipients(199)+', owner@example.test','r0@example.test, sender@example.test');assert.equal(createNativeReplyCompose(duplicates,'reply_all').initialContent.cc,recipients(199));
 const own=source(recipients(200),'','owner@example.test');assert.equal(createNativeReplyCompose(own,'reply').initialContent.to,recipients(200));assert.throws(()=>createNativeReplyCompose(source(recipients(201),'','owner@example.test'),'reply'));
});
test('unavailable Reply-To is never treated as absent; flags are strict unique enum with empty corresponding seed',()=>{
 const presentation={...source('owner@example.test'),reply_seed_unavailable:['reply_to' as const]};const parsed=parseNativeEmailPresentation(presentation,'account',presentation.logical_message_id);assert.throws(()=>createNativeReplyCompose(parsed,'reply'));assert.throws(()=>createNativeReplyCompose(parsed,'reply_all'));assert.match(createNativeReplyCompose(parsed,'forward').initialContent.body,/Readable complete body/);
 for(const unavailable of [['reply_to','reply_to'],['bcc'],['reply_to','reply_from','reply_cc','reply_to_list','reply_to']])assert.throws(()=>parseNativeEmailPresentation({...presentation,reply_seed_unavailable:unavailable},'account',presentation.logical_message_id));
 assert.throws(()=>parseNativeEmailPresentation({...presentation,presentation:{...presentation.presentation,metadata:{...presentation.presentation.metadata,reply_to:'sender@example.test'}}},'account',presentation.logical_message_id));
});
