import test from 'node:test';
import assert from 'node:assert/strict';
import {currentWorkerDocument,workerComposeParent,currentWorkerMail,workerConversationCoverage,EMAIL_DOCUMENT_METADATA_FIELDS} from './worker-mail.mjs';
import {createEmailComposeIntent} from './compose-intents.mjs';
const metadata={account_id:'account',primary_address:'owner@example.test',verified_sender_identities:'["owner@example.test"]',reply_from:'sender@example.test',reply_to:'reply@example.test',reply_to_list:'owner@example.test',reply_cc:'other@example.test',subject:'Subject',message_id:'<one@example.test>',references:'',conversation_id:'conversation_'+'b'.repeat(64),conversation_coverage_state:'unknown',conversation_indexed_count:'1',conversation_exact_count:'',conversation_observed_at:'',conversation_drained:'false',mailbox_reset_required:'false'};
test('generic plain document maps reviewed Email metadata and rejects unrelated account or extra keys',()=>{
 const value={format:'plain',content:'Body',truncated:false,metadata};
 const result=currentWorkerDocument(value,{account_id:'account',conversation_id:metadata.conversation_id});
 assert.equal(result.reply_context.to,'owner@example.test');assert.equal(result.plain_text,'Body');
 assert.throws(()=>currentWorkerDocument(value,{account_id:'other'}));
 assert.throws(()=>currentWorkerDocument({...value,metadata:{...metadata,provider_locator:'secret'}},{account_id:'account'}));
 assert.throws(()=>currentWorkerDocument({...value,format:'html'},{account_id:'account'}));
});

test('pure indexed metadata and current generic read produce Reply all using only the host record UUID',()=>{
 const record_id='00000000-0000-4000-8000-000000000001',data={metadata_version:'deft.email_message_metadata.v1',account_id:'account',logical_message_id:'mail_'+'a'.repeat(64),conversation_id:'conversation_'+'b'.repeat(64),provider:'imap_smtp',headers_complete:false,label:'Subject',subject:'Subject',sender:'sender@example.test',recipients:'owner@example.test',cc:'',date:'',in_inbox:true,in_sent:false,in_archive:false,folder_membership_complete:true,seen:true,flagged:false,answered:false,body_status:'lazy',files_status:'none'};
 const mail=currentWorkerMail({record_id,data},record_id);assert.equal(mail.resource_id,'');
 mail.document=currentWorkerDocument({format:'plain',content:'Body',truncated:false,metadata},mail);
 const parent=workerComposeParent(mail);assert.equal(Object.hasOwn(parent,'resource_id'),false);
 const intent=createEmailComposeIntent({mode:'reply_all',parent,verifiedOwnAliases:mail.document.account.verified_sender_identities});
 assert.equal(intent.reply_record_id,record_id);assert.equal(intent.to,'reply@example.test');assert.equal(intent.cc,'other@example.test');
});

test('all seventeen required string metadata fields and plain text remain bounded',()=>{
 const value={format:'plain',content:'Body',truncated:false,metadata},mail={account_id:'account',conversation_id:metadata.conversation_id};
 for(const [key,max] of Object.entries(EMAIL_DOCUMENT_METADATA_FIELDS)){
  const missing={...metadata};delete missing[key];assert.throws(()=>currentWorkerDocument({...value,metadata:missing},mail));
  for(const invalid of ['x'.repeat(max+1),'line\nbreak',null])assert.throws(()=>currentWorkerDocument({...value,metadata:{...metadata,[key]:invalid}},mail));
 }
 assert.equal(currentWorkerDocument({...value,content:'x'.repeat(16384)},mail).plain_text.length,16384);assert.throws(()=>currentWorkerDocument({...value,content:'x'.repeat(16385)},mail));assert.throws(()=>currentWorkerDocument({...value,truncated:'false'},mail));
});

test('verified aliases and Message-ID are validated; missing ID still renders but cannot create reply parent',()=>{
 const value={format:'plain',content:'Body',truncated:false,metadata},mail={account_id:'account',conversation_id:metadata.conversation_id,record_id:'00000000-0000-4000-8000-000000000001',logical_message_id:'mail_logical'};
 for(const identities of ['not json','{}','[]',JSON.stringify(Array(33).fill('owner@example.test')),JSON.stringify(['bad\nidentity'])])assert.throws(()=>currentWorkerDocument({...value,metadata:{...metadata,verified_sender_identities:identities}},mail));
 for(const message_id of ['bad','<notvalid>','<one@example.test> <two@example.test>'])assert.throws(()=>currentWorkerDocument({...value,metadata:{...metadata,message_id}},mail));
 const document=currentWorkerDocument({...value,metadata:{...metadata,message_id:''}},mail);assert.equal(document.plain_text,'Body');assert.equal(document.reply_context,null);assert.throws(()=>workerComposeParent({...mail,document}));
 assert.throws(()=>workerComposeParent({...mail,document:currentWorkerDocument({...value,truncated:true},mail)}));
 const parent=workerComposeParent({...mail,document:currentWorkerDocument(value,mail)});assert.equal(parent.record_id,mail.record_id);assert.equal(parent.reply_to,'reply@example.test');
});

test('conversation coverage requires exact scoped host members and authentic historical as-of, independently of mailbox reset',()=>{
 const coverage={state:'complete',indexed_count:12,exact_count:12,observed_at:'2025-01-01T00:00:00.000Z',drained:true,mailbox_reset_required:true};
 const result=workerConversationCoverage(coverage,{count:12,complete:true},Date.parse('2026-10-01T00:00:00Z'));
 assert.equal(result.confirmed,true);assert.match(result.notice,/as of 2025/);assert.match(result.mailbox_notice,/reset pending/);
 for(const state of [{count:11,complete:true},{count:12,complete:false},{count:12,complete:true,failed:true},{count:12,complete:true,limited:true}])assert.equal(workerConversationCoverage(coverage,state).confirmed,false);
 for(const change of [{drained:false},{exact_count:null},{indexed_count:13},{state:'unknown'},{state:'stale'},{observed_at:'2999-01-01T00:00:00.000Z'}])assert.equal(workerConversationCoverage({...coverage,...change},{count:12,complete:true}).confirmed,false);
});

test('coverage document rejects another conversation, malformed counts, flags and timestamp',()=>{
 const value={format:'plain',content:'Body',truncated:false,metadata},mail={account_id:'account',conversation_id:metadata.conversation_id};
 for(const change of [{conversation_id:'conversation_'+'c'.repeat(64)},{conversation_coverage_state:'invented'},{conversation_indexed_count:'-1'},{conversation_exact_count:'10001'},{conversation_indexed_count:'01'},{conversation_drained:'yes'},{mailbox_reset_required:'yes'},{conversation_observed_at:'2025-01-01'}])assert.throws(()=>currentWorkerDocument({...value,metadata:{...metadata,...change}},mail));
});


test('complete Forward context does not require reply thread headers, but partial source is denied',()=>{
 const mail={account_id:'account',conversation_id:metadata.conversation_id,record_id:'00000000-0000-4000-8000-000000000001'};
 const value={format:'plain',content:'Body',truncated:false,metadata:{...metadata,message_id:''}};
 mail.document=currentWorkerDocument(value,mail);assert.equal(mail.document.reply_context,null);
 const parent=workerComposeParent(mail,'forward');const intent=createEmailComposeIntent({mode:'forward',parent,verifiedOwnAliases:mail.document.account.verified_sender_identities});assert.equal(intent.reply_record_id,'');assert.equal(intent.to,'');
 assert.throws(()=>workerComposeParent({...mail,document:currentWorkerDocument({...value,truncated:true},mail)},'forward'));
});
