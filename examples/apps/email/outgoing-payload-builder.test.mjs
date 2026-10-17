import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {buildEmailActionPayload} from './outgoing-payload-builder.mjs';
import {createEmailComposeIntent} from './compose-intents.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const binding={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),
  grant_snapshot_id:randomUUID(),resource_target_key:'primary',state_key:'drafts',draft_id:randomUUID(),draft_revision:2,
  artifact_digest:'sha256:'+'a'.repeat(64),declaration_digest:'sha256:'+'b'.repeat(64),runtime_binding_id:randomUUID(),
  action_key:'send_message',action_contract_digest:'sha256:'+'c'.repeat(64),input_digest:'sha256:'+'d'.repeat(64)};
 const bytes=Buffer.from('%PDF-1.4\nsynthetic controlled attachment\n%%EOF'),input={to:'recipient@example.test',subject:'Controlled delivery',body:'Exact message body.'};
 const account={account_id:'google-test',provider:'gmail',display_label:'Test sender',primary_address:'verified@example.test',
  verified_sender_identities:['verified@example.test'],capabilities:['read','send'],connection_target:'primary',resource_binding_id:randomUUID(),
  action_binding_id:binding.runtime_binding_id,authority_epoch:1,health:'connected'};
 const request={binding,input,draft_value:{...input,mode:'compose',reply_record_id:''},draft_updated_at:'2026-09-30T00:00:00.000Z',
  files:[{reference:{file_id:randomUUID(),upload_operation_id:randomUUID(),filename:'brief.pdf',media_type:'application/pdf',
   byte_length:bytes.length,digest:hash(bytes),expires_at:'2026-10-01T00:00:00.000Z'},bytes}],
  files_policy:{max_file_bytes:2097152,max_files_per_record:1,max_total_bytes_per_record:2097152,allowed_media_types:['application/pdf']},
  max_payload_bytes:4194304,expires_at:'2026-10-01T00:00:00.000Z'};
 return {request,account,bytes};
}
test('trusted payload is deterministic and contains exact verified From, body and PDF',async()=>{
 const f=fixture(),first=await buildEmailActionPayload(f.request,f.account),again=await buildEmailActionPayload(f.request,f.account);
 assert.deepEqual(first,again);const parsed=await simpleParser(first.bytes);
 assert.equal(parsed.from.value[0].address,f.account.primary_address);assert.equal(parsed.to.value[0].address,f.request.input.to);
 assert.equal(parsed.subject,f.request.input.subject);assert.equal(parsed.text.trimEnd(),f.request.input.body);
 assert.deepEqual(parsed.attachments[0].content,f.bytes);assert.equal(parsed.attachments[0].filename,'brief.pdf');
 assert.equal(first.metadata.preview.items[0].value,f.account.primary_address);assert.equal(first.metadata.payload.mime.digest,hash(first.bytes));
});
test('changed draft, account target, capability, identity and file bytes fail closed',async()=>{
 const f=fixture();
 for(const patch of [{health:'revoked'},{connection_target:'other'},{action_binding_id:randomUUID()},{capabilities:['read']},
  {verified_sender_identities:['other@example.test']}])await assert.rejects(buildEmailActionPayload(f.request,{...f.account,...patch}));
 await assert.rejects(buildEmailActionPayload({...f.request,input:{...f.request.input,body:'swapped'}},f.account));
 await assert.rejects(buildEmailActionPayload({...f.request,input:{...f.request.input,from:'attacker@example.test'}},f.account));
 await assert.rejects(buildEmailActionPayload({...f.request,files:[{...f.request.files[0],bytes:Buffer.from('changed')}]},f.account));
 await assert.rejects(buildEmailActionPayload({...f.request,max_payload_bytes:1},f.account));
});


test('compatibility MIME keeps the full digest unfolded and base64 preserves long Unicode lines',async()=>{
 const f=fixture(),body='This is the authorized Deft Email Stage 1 delivery check. The attached one-page PDF is synthetic test content. No reply is needed. '+ 'UTF8 caf\u00e9 \u2603 '.repeat(20)+'\nSecond line with intentional breaks.\n';
 f.request.input.body=body;f.request.draft_value.body=body;
 const built=await buildEmailActionPayload(f.request,f.account),again=await buildEmailActionPayload(f.request,f.account);
 assert.deepEqual(built,again);
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const digest=createHash('sha256').update(JSON.stringify(canonical({binding:f.request.binding,account_id:f.account.account_id,epoch:f.account.authority_epoch}))).digest();
 const expectedId=`<${digest.toString('base64url')}@deft.invalid>`,raw=built.bytes.toString('utf8');
 assert.equal(built.metadata.payload.message_id,expectedId);assert.deepEqual(Buffer.from(expectedId.slice(1,44),'base64url'),digest);
 assert.ok(raw.includes(`Message-ID: ${expectedId}\r\n`));assert.ok(!raw.includes('Message-ID:\r\n'));assert.ok(`Message-ID: ${expectedId}`.length<=78);
 const textPart=/Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
 assert.ok(textPart);assert.equal(Buffer.from(textPart[1].replace(/\r\n/g,''),'base64').toString('utf8').replace(/\r\n/g,'\n'),body);
 const parsed=await simpleParser(built.bytes);assert.equal(parsed.messageId,expectedId);assert.equal(parsed.text,body);assert.deepEqual(parsed.attachments[0].content,f.bytes);
});


test('new compose shape stays parent-free and trusted reply cannot substitute account, epoch or recipients',async()=>{
 const f=fixture();f.request.input={...f.request.input,cc:'',parent_record_id:''};f.request.draft_value={...f.request.draft_value,cc:'',reply_record_id:''};
 const composed=await buildEmailActionPayload(f.request,f.account);assert.equal(composed.metadata.payload.reply_headers,null);
 const parent={record_id:'11111111-1111-4111-8111-111111111111',logical_message_id:'mail_'+'a'.repeat(64),message_id:'<peer@example.test>',references:[],account_id:f.account.account_id,authority_epoch:f.account.authority_epoch,org_id:f.request.binding.org_id,owner_id:f.request.binding.owner_user_id,from:[{address:'peer@example.test',display_name:''}],reply_to:[],to:[{address:f.account.primary_address,display_name:''}],cc:[{address:'cc@example.test',display_name:''}]};
 parent.thread_id='trusted-thread';
 f.request.input={to:'peer@example.test',cc:'cc@example.test',parent_record_id:parent.record_id,subject:'Re: Parent',body:'Exact reply.\n'};f.request.draft_value={...f.request.input,mode:'reply_all',reply_record_id:parent.record_id};
 const built=await buildEmailActionPayload(f.request,f.account,parent),parsed=await simpleParser(built.bytes);assert.equal(parsed.inReplyTo,parent.message_id);assert.deepEqual(parsed.attachments[0].content,f.bytes);assert.equal(parsed.text,f.request.input.body);assert.ok(built.bytes.toString().includes('Content-Transfer-Encoding: base64'));
 for(const change of [{account_id:'other'},{authority_epoch:2},{owner_id:'other'},{record_id:'other'},{from:[{address:'attacker@example.test',display_name:''}]}])await assert.rejects(buildEmailActionPayload(f.request,f.account,{...parent,...change}));
 await assert.rejects(buildEmailActionPayload(f.request,f.account));
});

test('compose seals the displayed typed To and Cc lists with names and exact PDF',async()=>{
 const f=fixture();
 f.request.input={...f.request.input,to:'"Peer, One" <peer1@example.test>, peer2@example.test',cc:'Copy <copy@example.test>',parent_record_id:''};
 f.request.draft_value={...f.request.input,mode:'compose',reply_record_id:''};
 const built=await buildEmailActionPayload(f.request,f.account),parsed=await simpleParser(built.bytes);
 assert.deepEqual(parsed.to.value.map(row=>[row.address,row.name]),[['peer1@example.test','Peer, One'],['peer2@example.test','']]);
 assert.deepEqual(parsed.cc.value.map(row=>[row.address,row.name]),[['copy@example.test','Copy']]);
 assert.deepEqual(parsed.attachments[0].content,f.bytes);assert.equal(parsed.text,f.request.input.body);
 assert.equal(built.metadata.preview.items.find(row=>row.key==='cc').value,f.request.input.cc);
 await assert.rejects(buildEmailActionPayload({...f.request,input:{...f.request.input,cc:'changed@example.test'}},f.account));
 for(const to of ['peer@example.test\r\nBcc: hidden@example.test',Array.from({length:33},(_,i)=>`peer${i}@example.test`).join(', ')]) {
  const input={...f.request.input,to};
  await assert.rejects(buildEmailActionPayload({...f.request,input,draft_value:{...f.request.draft_value,to}},f.account));
 }
});

test('Reply all seals the same named recipients suggested by the reviewed document',async()=>{
 const f=fixture(),record_id='11111111-1111-4111-8111-111111111111';
 const intent=createEmailComposeIntent({mode:'reply_all',verifiedOwnAliases:[f.account.primary_address],parent:{account_id:f.account.account_id,record_id,
  from:'"Peer, One" <peer@example.test>',reply_to:'',to:f.account.primary_address,cc:'Copy <copy@example.test>',subject:'Parent',plain_text:'Exact parent.',truncated:false}});
 const parent={record_id,logical_message_id:'mail_'+'a'.repeat(64),message_id:'<peer@example.test>',references:[],account_id:f.account.account_id,
  authority_epoch:f.account.authority_epoch,org_id:f.request.binding.org_id,owner_id:f.request.binding.owner_user_id,
  from:[{address:'peer@example.test',display_name:'Peer, One'}],reply_to:[],to:[{address:f.account.primary_address,display_name:''}],cc:[{address:'copy@example.test',display_name:'Copy'}]};
 parent.thread_id='trusted-document-thread';
 f.request.draft_value={...intent};f.request.input={to:intent.to,cc:intent.cc,subject:intent.subject,body:intent.body,parent_record_id:record_id};
 const built=await buildEmailActionPayload(f.request,f.account,parent),parsed=await simpleParser(built.bytes);
 assert.equal(parsed.to.value[0].name,'Peer, One');assert.equal(parsed.cc.value[0].name,'Copy');assert.equal(parsed.inReplyTo,parent.message_id);
 assert.equal(parsed.text,intent.body);assert.deepEqual(parsed.attachments[0].content,f.bytes);
});

test('Stage2 rich To/Cc/Bcc capture retains exact MIME HTML/plain/PDF and visible Bcc preview',async()=>{
 const f=fixture();f.request.input={to:'One <one@example.test>, two@example.test',cc:'copy@example.test',bcc:'Hidden <hidden@example.test>',subject:'Rich',body:'Hello team\n- One',body_html:'<p>Hello <strong>team</strong></p><ul><li><p>One</p></li></ul>',parent_record_id:''};
 f.request.draft_value={...f.request.input,mode:'compose',reply_record_id:''};
 const built=await buildEmailActionPayload(f.request,f.account),parsed=await simpleParser(built.bytes);
 assert.equal(parsed.html,f.request.input.body_html);assert.equal(parsed.text,f.request.input.body);
 assert.deepEqual(parsed.to.value.map(row=>row.address),['one@example.test','two@example.test']);assert.equal(parsed.cc.value[0].address,'copy@example.test');assert.equal(parsed.bcc.value[0].address,'hidden@example.test');
 assert.deepEqual(parsed.attachments[0].content,f.bytes);assert.equal(built.metadata.payload.body.format,'safe_html');
 assert.equal(built.metadata.payload.body.html.digest,hash(Buffer.from(f.request.input.body_html)));assert.equal(built.metadata.preview.items.find(row=>row.key==='bcc').value,f.request.input.bcc);
 assert.deepEqual((await buildEmailActionPayload(f.request,f.account)).bytes,built.bytes);
 for(const patch of [{body_html:'<p>Different</p>'},{body_html:'<p onclick="run()">Hello team</p>'},{bcc:'changed@example.test'}])await assert.rejects(buildEmailActionPayload({...f.request,input:{...f.request.input,...patch}},f.account));
});

test('Stage2 Forward has no reply headers and reviewed recipient field ceilings still apply',async()=>{
 const f=fixture();f.request.input={...f.request.input,cc:'copy@example.test',bcc:'hidden@example.test',body_html:'',parent_record_id:''};f.request.draft_value={...f.request.input,mode:'forward',reply_record_id:''};
 const built=await buildEmailActionPayload(f.request,f.account);assert.equal(built.metadata.payload.reply_headers,null);assert.equal(built.metadata.payload.mode,'forward');
 const lists=prefix=>Array.from({length:70},(_,i)=>`${prefix}${i}@x.test`).join(', ');
 const input={...f.request.input,to:lists('a'),cc:lists('b'),bcc:lists('c')};await assert.rejects(buildEmailActionPayload({...f.request,input,draft_value:{...input,mode:'compose',reply_record_id:''}},f.account));
});

test('Stage2 own Sent Reply all keeps trusted original recipients and never copies received Bcc',async()=>{
 const f=fixture(),record_id='11111111-1111-4111-8111-111111111111';
 const parent={record_id,logical_message_id:'mail_'+'a'.repeat(64),message_id:'<sent@example.test>',references:[],account_id:f.account.account_id,authority_epoch:1,org_id:f.request.binding.org_id,owner_id:f.request.binding.owner_user_id,
  from:[{address:f.account.primary_address,display_name:''}],reply_to:[],to:[{address:'peer@example.test',display_name:''}],cc:[{address:'copy@example.test',display_name:''}]};
 Object.defineProperty(parent,'bcc',{get(){throw Error('received Bcc must never be read');}});
 parent.thread_id='trusted-own-sent-thread';
 f.request.input={to:'peer@example.test',cc:'copy@example.test',bcc:'',body:'Reply',body_html:'<p>Reply</p>',subject:'Re: Sent',parent_record_id:record_id};f.request.draft_value={...f.request.input,mode:'reply_all',reply_record_id:record_id};
 const built=await buildEmailActionPayload(f.request,f.account,parent),parsed=await simpleParser(built.bytes);assert.equal(parsed.to.value[0].address,'peer@example.test');assert.equal(parsed.cc.value[0].address,'copy@example.test');assert.equal(parsed.bcc,undefined);assert.equal(parsed.inReplyTo,parent.message_id);
});
