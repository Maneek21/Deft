import {readTriageReceipt} from './triage-receipt-ui.mjs';
import {emailSearchInput} from './search-ui.mjs';
import {createSignatureState} from './signature-state.mjs';
import {workerTriageInput} from './triage-ui.mjs';
import {emailDocumentNode} from './document-ui.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {createDraftController, createDraftId, draftSubjectValid} from './draft-controller.mjs';
import {createRequestJournal} from './request-journal.mjs';
import {currentWorkerMail,currentWorkerDocument,workerComposeParent,workerConversationCoverage,emailMetadataInFolder,emailMetadataRelated,EMAIL_METADATA_SEARCH_FIELDS} from './worker-mail.mjs';
import {createEmailComposeIntent,insertEmailSignature} from './compose-intents.mjs';

async function start({messages=[],drafts=[],requests=[],dialog,statusUnavailable=false,documentRead,searchRead,recordRead,browseRead,draftRead,triageOptions,runStatus,draftList}={}) {
  const views=[],checks=[],documents=[],external=[],opened=[],stores={preferences:new Map(),drafts:new Map(drafts.map(item=>[item.record_id,item])),requests:new Map(requests.map(item=>[item.record_id,item]))};
  let event;
  const sdk={render:view=>{const ids=new Set();const walk=node=>{assert.ok(!ids.has(node.id),`Duplicate UI node ${node.id}`);ids.add(node.id);node.children?.forEach(walk);};walk(view.root);view.navigation?.forEach(walk);views.push(view);},onEvent:handler=>{event=handler;},
    searchResourceRecords:async(_key,args)=>{if(searchRead){const result=await searchRead(args);if(result)return result;}const offset=Number(args.cursor||0),rows=args.field_keys?.[0]?.startsWith('in_')?messages.filter(data=>data[args.field_keys[0]]):args.field_keys?.[0]==='conversation_id'?messages.filter(data=>data.conversation_id===args.query):messages,items=rows.slice(offset,offset+10).map(data=>({record_id:data.record_id,label:data.subject}));return {items,next_cursor:offset+10<rows.length?String(offset+10):null,scan:{complete:offset+10>=rows.length}};},
    readResourceRecord:async(_key,id)=>recordRead?recordRead(id):({item:{record_id:id,data:messages.find(data=>data.record_id===id)}}),
    readResourceDocument:async(key,id)=>{documents.push({key,id});const mail=messages.find(data=>data.record_id===id);return documentRead?documentRead(mail,id):{format:'plain',content:mail.body,truncated:false,metadata:documentMetadata(mail)};},
    listPrivateState:async key=>key==='drafts'&&draftList?draftList():({items:[...stores[key].values()].map(({record_id,updated_at})=>({record_id,updated_at}))}),
    readPrivateState:async(key,id)=>{if(key==='drafts'&&draftRead)return draftRead(id);return {item:stores[key].get(id)};},
    putPrivateState:async(key,id,revision,value)=>{const item={record_id:id,revision:revision+1,updated_at:new Date().toISOString(),value};stores[key].set(id,item);return {item};},
    deletePrivateState:async(key,id)=>stores[key].delete(id),
    openResource:async(key,id)=>{opened.push({key,id});},
    request:async(kind,key,input)=>{if(kind==='run_status'){checks.push(input.run_id);if(statusUnavailable)throw Error('Unavailable');return runStatus?runStatus(input.run_id):{id:input.run_id,state:'succeeded'};}if(kind==='dialog')return dialog?.(stores,input);if(kind==='action'){external.push({key,input});return {id:'archive-run',state:'pending_approval'};}throw Error('Unexpected external action');},
  };
  if(browseRead)sdk.browseResourceRecords=async(_key,args)=>browseRead(args);
  if(triageOptions)sdk.readTriageOptions=async(_key,id)=>triageOptions(id);
  const self={};
  vm.runInNewContext(readFileSync(new URL('./worker.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''),{self,emailSearchInput,readTriageReceipt,createSignatureState,insertEmailSignature,workerTriageInput,emailDocumentNode,createDeftExperienceSdk:()=>sdk,createDraftController,createDraftId,draftSubjectValid,createRequestJournal,currentWorkerMail,currentWorkerDocument,workerComposeParent,workerConversationCoverage,emailMetadataInFolder,emailMetadataRelated,EMAIL_METADATA_SEARCH_FIELDS,createEmailComposeIntent,TextEncoder,Map,Promise,Date,setTimeout,clearTimeout,crypto:webcrypto});
  self.onmessage({data:{kind:'start',port:{},session_id:'test'}});
  await new Promise(resolve=>setTimeout(resolve,20));
  const nodes=()=>{const result=[];const walk=node=>{result.push(node);node.children?.forEach(walk);};walk(views.at(-1).root);return result;};
  return {nodes,checks,stores,documents,external,opened,views,view:()=>views.at(-1),click:async node_id=>event({kind:'click',node_id}),input:async(node_id,value)=>event({kind:'input',node_id,value})};
}
const message=i=>({record_id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,metadata_version:'deft.email_message_metadata.v1',account_id:'account',logical_message_id:'mail_'+String(i+1).padStart(64,'0'),conversation_id:'conversation_'+String(i+1).padStart(64,'0'),provider:'imap_smtp',headers_complete:true,label:`Subject ${i}`,subject:`Subject ${i}`,sender:'sender@example.test',recipients:'owner@example.test',cc:'',in_inbox:true,in_sent:false,in_archive:false,folder_membership_complete:true,seen:true,flagged:false,answered:false,body_status:'lazy',files_status:'none',date:new Date(2026,0,i+1).toISOString(),body:'message',message_id:'<original@example.test>'});
const documentMetadata=mail=>({account_id:mail.account_id,primary_address:'owner@example.test',verified_sender_identities:'["owner@example.test","alias@example.test"]',reply_from:mail.sender,reply_to:mail.reply_to||'',reply_to_list:mail.recipients,reply_cc:mail.cc,subject:mail.subject,message_id:mail.message_id,references:'',conversation_id:mail.conversation_id,conversation_coverage_state:'unknown',conversation_indexed_count:'1',conversation_exact_count:'',conversation_observed_at:'',conversation_drained:'false',mailbox_reset_required:'false'});
const draft=(id,subject)=>({record_id:id,revision:1,updated_at:'2026-09-28T00:00:00Z',value:{mode:'compose',to:'person@example.test',cc:'',bcc:'',body_html:'',subject,body:'message',reply_record_id:''}});
const request=(action,draftId='')=>({record_id:'request',revision:1,value:{action_key:action,label:action==='archive_message'?'Archive':'Send',summary:'Old summary',source_record_id:'',draft_record_id:draftId,run_id:'run-1',state:'pending_approval',created_at:'2026-09-28T00:00:00Z'}});
const certifiedDocument=(mail,count,extra={})=>({format:'plain',content:mail.body,truncated:false,metadata:{...documentMetadata(mail),conversation_coverage_state:'complete',conversation_indexed_count:String(count),conversation_exact_count:String(count),conversation_observed_at:'2025-01-01T00:00:00.000Z',conversation_drained:'true',...extra}});

test('folder count covers index and newest dated message leads first page',async()=>{
  const ui=await start({messages:Array.from({length:26},(_,i)=>message(i))});
  assert.equal(ui.nodes().find(node=>node.id==='mail_0').label,'Subject 25');
  assert.match(ui.nodes().find(node=>node.id==='loaded_count').text,/26/);
  await ui.click('more');assert.equal(ui.nodes().find(node=>node.id==='mail_0').label,'Subject 15');
});

test('conversation reads paged Inbox and Sent headers with one active body and chosen Reply all UUID',async()=>{
 const conversation_id=message(0).conversation_id;
 const messages=Array.from({length:12},(_,i)=>({...message(i),conversation_id,in_inbox:i<6,in_sent:i>=6,body:`Exact body ${i}`}));
 let capture;
 const ui=await start({messages,documentRead:mail=>certifiedDocument(mail,12,{mailbox_reset_required:'true'}),dialog:(_stores,input)=>{capture=input;return {cancelled:true};}});
 assert.equal(ui.documents.length,0);await ui.click('mail_0');await ui.click('toggle_conversation');
 assert.equal(ui.nodes().find(node=>node.id==='conversation_headers').children.length,10);
 assert.match(ui.nodes().find(node=>node.id==='conversation_coverage').text,/unconfirmed/);
 assert.deepEqual(ui.documents.map(row=>row.id),[messages[5].record_id]);
 await ui.click('more_conversation');
 const headers=ui.nodes().find(node=>node.id==='conversation_headers').children;
 assert.deepEqual(Array.from(headers,row=>row.label),messages.map(row=>row.subject));
 assert.match(ui.nodes().find(node=>node.id==='conversation_coverage').text,/Complete conversation.*12.*as of 2025/);
 await ui.click('toggle_details');assert.match(ui.nodes().find(node=>node.id==='mailbox_coverage').text,/reset pending/);
 await ui.click('conversation_10');
 assert.equal(ui.nodes().find(node=>node.id==='mail_body').content,'Exact body 10');
 assert.equal(ui.nodes().filter(node=>/^mail_body/.test(node.id)).length,1);
 assert.deepEqual(ui.documents.map(row=>row.id),[messages[5].record_id,messages[10].record_id]);
 await ui.click('reply_all');assert.equal(capture.input.parent_record_id,messages[10].record_id);
 assert.equal([...ui.stores.drafts.values()][0].value.reply_record_id,messages[10].record_id);
});

test('failed and foreign conversation siblings cannot leak or certify host completeness',async()=>{
 const parent=message(0),foreign={...message(1),conversation_id:parent.conversation_id,account_id:'other',in_inbox:false,in_sent:true,subject:'Foreign secret'},failed={...message(2),conversation_id:parent.conversation_id,in_inbox:false,in_sent:true};
 const messages=[parent,foreign,failed];
 const ui=await start({messages,documentRead:mail=>certifiedDocument(mail,2),recordRead:id=>{if(id===failed.record_id)throw Error('Gone');return {item:{record_id:id,data:messages.find(row=>row.record_id===id)}};}});
 await ui.click('mail_0');await ui.click('toggle_conversation');
 assert.equal(ui.nodes().find(node=>node.id==='conversation_headers').children.length,1);
 assert.match(ui.nodes().find(node=>node.id==='conversation_coverage').text,/unconfirmed.*unavailable/);
 assert.equal(JSON.stringify(ui.view()).includes('Foreign secret'),false);
 assert.deepEqual(ui.documents.map(row=>row.id),[parent.record_id]);
});

test('drained provider coverage with missing host projection stays unconfirmed',async()=>{
 const ui=await start({messages:[message(0)],documentRead:mail=>certifiedDocument(mail,2)});await ui.click('mail_0');await ui.click('toggle_details');
 assert.match(ui.nodes().find(node=>node.id==='conversation_coverage').text,/unconfirmed/);
 assert.equal(ui.nodes().find(node=>node.id==='more_conversation'),undefined);
});

test('conversation header cap and multibyte active body keep the emitted document bounded',async()=>{
 const messages=Array.from({length:45},(_,i)=>({...message(i),conversation_id:message(0).conversation_id,body:'🪴'.repeat(8192),subject:'語'.repeat(200),sender:'sender@example.test'}));
 const ui=await start({messages,documentRead:mail=>certifiedDocument(mail,45)});await ui.click('mail_0');await ui.click('toggle_conversation');
 for(let i=0;i<3;i++)await ui.click('more_conversation');
 assert.equal(ui.nodes().find(node=>node.id==='conversation_headers').children.length,40);
 assert.match(ui.nodes().find(node=>node.id==='conversation_coverage').text,/unconfirmed.*header limit reached/);
 assert.equal(ui.nodes().find(node=>node.id==='more_conversation'),undefined);
 const body=ui.nodes().filter(node=>/^mail_body/.test(node.id)).map(node=>node.content??node.text).join('');
 assert.ok(new TextEncoder().encode(body).byteLength<=16384);assert.ok(new TextEncoder().encode(JSON.stringify(ui.view())).byteLength<=60*1024);
 assert.match(ui.nodes().find(node=>node.id==='display_limit').text,/display limit/);
});

test('adversarial Unicode headers share the60KiB renderer budget with the expanded body',async()=>{
 const messages=Array.from({length:40},(_,i)=>({...message(i),conversation_id:message(0).conversation_id,subject:'🪴'.repeat(100),sender:'🪴'.repeat(500),recipients:'🪴'.repeat(500),body:'🪴'.repeat(8192)}));
 const ui=await start({messages,documentRead:mail=>certifiedDocument(mail,40)});await ui.click('mail_0');await ui.click('toggle_conversation');await ui.click('toggle_details');
 for(let i=0;i<3;i++)await ui.click('more_conversation');
 assert.equal(ui.nodes().find(node=>node.id==='conversation_headers').children.length,40);
 assert.ok(new TextEncoder().encode(JSON.stringify(ui.view())).byteLength<=60*1024);
 assert.equal(ui.documents.length,1);assert.ok(ui.nodes().find(node=>node.id==='display_limit'));
});

test('failed expanded sibling isolates its body and disables Reply without discarding conversation headers',async()=>{
 const parent=message(0),sibling={...message(1),conversation_id:parent.conversation_id,in_inbox:false,in_sent:true};
 const ui=await start({messages:[parent,sibling],documentRead:mail=>{if(mail.record_id===sibling.record_id)throw Error('Unavailable');return certifiedDocument(mail,2);}});
 await ui.click('mail_0');await ui.click('toggle_conversation');await ui.click('conversation_1');
 assert.equal(ui.nodes().find(node=>node.id==='conversation_headers').children.length,2);
 assert.match(ui.nodes().find(node=>node.id==='conversation_coverage').text,/unconfirmed.*unavailable/);
 assert.equal(ui.nodes().find(node=>node.id==='reply_all').disabled,true);
 assert.doesNotMatch(ui.nodes().find(node=>node.id==='mail_body').text,/message$/);
});

test('mailbox navigation clears prior conversation headers and active body before another account is chosen',async()=>{
 const first=message(0),other={...message(1),account_id:'other',in_inbox:false,in_sent:true};
 const ui=await start({messages:[first,other]});await ui.click('mail_0');await ui.click('toggle_conversation');assert.ok(ui.nodes().find(node=>node.id==='conversation_headers'));
 await ui.click('folder_sent');assert.equal(ui.nodes().find(node=>node.id==='conversation_headers'),undefined);
 assert.match(ui.nodes().find(node=>node.id==='mail_body').text,/has not been loaded/);
 await ui.click('mail_0');await ui.click('toggle_conversation');assert.equal(ui.nodes().find(node=>node.id==='conversation_headers').children.length,1);
 assert.deepEqual(ui.documents.map(row=>row.id),[first.record_id,other.record_id]);
});

test('cyclic conversation cursors stop explicitly without claiming completeness',async()=>{
 const parent=message(0),page={items:[{record_id:parent.record_id,label:parent.subject}],next_cursor:'same',scan:{complete:false}};
 const ui=await start({messages:[parent],documentRead:mail=>certifiedDocument(mail,1),searchRead:args=>args.field_keys[0]==='conversation_id'?page:null});
 await ui.click('mail_0');await ui.click('more_conversation');await ui.click('toggle_details');
 assert.match(ui.nodes().find(node=>node.id==='conversation_coverage').text,/unconfirmed.*limit reached/);
 assert.equal(ui.nodes().find(node=>node.id==='more_conversation'),undefined);
});
test('private draft labels use saved subjects and exclude submitted drafts',async()=>{
  const ui=await start({drafts:[draft('first','Saved subject'),draft('submitted','Already sent')],requests:[request('send_message','submitted')]});
  await ui.click('drafts');assert.equal(ui.nodes().find(node=>node.id==='draft_open_0').label,'Saved subject');
  assert.equal(ui.nodes().filter(node=>node.id.startsWith('draft_open_')).length,1);
});
test('Activity refreshes known Runs on entry and archive success avoids delivery copy',async()=>{
  const ui=await start({requests:[request('archive_message')]});await ui.click('requests');
  assert.equal(ui.checks.length,1);const text=ui.nodes().find(node=>node.id==='action_state_0').text;
  assert.match(text,/Mailbox request/i);assert.doesNotMatch(text,/delivery|Mail server/);
});
test('historical Activity keeps inaccessible draft and explains terminal saved-copy removal',async()=>{
 const saved=draft('legacy','Older saved draft'),entry=request('send_message','legacy');
 const ui=await start({drafts:[saved],requests:[entry],draftList:()=>({items:[]}),draftRead:()=>{throw Error('APP_STALE');},runStatus:id=>({id,state:'failed'})});
 await ui.click('requests');assert.match(ui.nodes().find(node=>node.id==='action_state_0').text,/Failed/);assert.ok(ui.nodes().find(node=>node.id==='action_draft_kept_0'));assert.match(ui.nodes().find(node=>node.id==='activity_help').text,/permanently deletes.*Run receipts and mail remain; inaccessible drafts are kept/);
 await ui.click('run_check_0');assert.equal(ui.nodes().find(node=>node.id==='status'),undefined);
 await ui.click('run_remove_0');assert.equal(ui.stores.requests.size,0);assert.deepEqual(ui.stores.drafts.get('legacy'),saved);assert.match(ui.nodes().find(node=>node.id==='status').text,/inaccessible draft, Run receipt and mail are kept/);assert.equal(ui.external.length,0);
});
test('Activity preserves terminal item and draft when its draft read conflicts',async()=>{
 const saved=draft('legacy','Older saved draft'),ui=await start({drafts:[saved],requests:[request('send_message','legacy')],draftRead:()=>{throw Error('APP_STATE_CONFLICT');},runStatus:id=>({id,state:'failed'})});
 await ui.click('requests');assert.equal(ui.nodes().find(node=>node.id==='action_draft_kept_0'),undefined);assert.match(ui.nodes().find(node=>node.id==='status').text,/unavailable/);await ui.click('run_remove_0');assert.equal(ui.stores.requests.size,1);assert.deepEqual(ui.stores.drafts.get('legacy'),saved);assert.equal(ui.external.length,0);
});
test('partial folder index stops at100 records and does not claim total or global newest',async()=>{
  const ui=await start({messages:Array.from({length:126},(_,i)=>message(i))});
  assert.match(ui.nodes().find(node=>node.id==='loaded_count').text,/100 loaded messages.*partial index/);
  assert.match(ui.nodes().find(node=>node.id==='index_limit').text,/within the loaded set/);
  assert.equal(ui.nodes().find(node=>node.id==='mail_0').label,'Subject 99');
});
test('submitted summary uses exact host input rather than initial or subsequently edited draft',async()=>{
  const ui=await start({drafts:[draft('first','Initial subject')],dialog:stores=>{
    const saved=stores.drafts.get('first');saved.value={...saved.value,to:'later-edit@example.test',subject:'Later mutable draft edit'};
    return {run:{id:'run-2',state:'succeeded',submitted_input:{to:'actual@example.test',subject:'Actual submitted subject'}}};
  }});
  await ui.click('drafts');await ui.click('draft_open_0');await ui.click('requests');
  assert.match(ui.nodes().find(node=>node.id==='action_summary_0').text,/actual@example.test · Actual submitted subject/);
});
test('known Run is retained when submitted draft read cannot confirm details',async()=>{
  const ui=await start({drafts:[draft('first','Initial subject')],dialog:stores=>{
    stores.drafts.get('first').value=null;return {run:{id:'run-2',state:'succeeded'}};
  }});
  await ui.click('drafts');await ui.click('draft_open_0');
  const saved=[...ui.stores.requests.values()][0].value;
  assert.equal(saved.run_id,'run-2');assert.equal(saved.summary,'Submitted message details unavailable.');
});
test('unavailable Activity refresh preserves last known state without external retries',async()=>{
  const ui=await start({requests:[request('archive_message')],statusUnavailable:true});await ui.click('requests');
  assert.equal(ui.checks.length,1);
  assert.match(ui.nodes().find(node=>node.id==='action_state_0').text,/Waiting for your approval/);
  assert.equal(ui.stores.requests.get('request').value.state,'pending_approval');
});

test('mail rows expose sender, date and explicit flags while reader keeps complete metadata',async()=>{
  const mail={...message(0),sender:'Marigold Patel <marigold@example.test>',recipients:'Diego Vargas <diego@example.test>',seen:false,flagged:true};
  const ui=await start({messages:[mail]});
  const row=ui.nodes().find(node=>node.id==='mail_0');
  assert.equal(row.eyebrow,'Marigold Patel');assert.ok(row.meta.startsWith(new Date(mail.date).toLocaleDateString(undefined,{month:'short',day:'numeric'})));assert.match(row.meta,/Unread.*Starred/);
  assert.equal(row.description,'');assert.equal(row.selected,true);
  assert.equal(ui.nodes().find(node=>node.id==='mail_metadata'),undefined);await ui.click('toggle_details');
  assert.equal(ui.nodes().find(node=>node.id==='mail_sender').text,`From: ${mail.sender}`);
  assert.equal(ui.nodes().find(node=>node.id==='mail_recipients').text,`To: ${mail.recipients}`);
  assert.match(ui.nodes().find(node=>node.id==='mail_date_flags').text,/Unread.*Starred/);
});

test('sent rows show the other recipient and invalid dates are not invented',async()=>{
  const mail={...message(0),in_inbox:false,in_sent:true,date:'not-a-date',sender:'own@example.test',recipients:'other@example.test'};
  const ui=await start({messages:[mail]});await ui.click('folder_sent');await ui.click('toggle_details');
  const row=ui.nodes().find(node=>node.id==='mail_0');
  assert.equal(row.eyebrow,'To: other@example.test');assert.equal(row.meta,'');
  assert.equal(ui.nodes().find(node=>node.id==='mail_date_flags').text,'Read');
});

test('mobile mail navigation shows one pane and Activity Back returns to the mailbox',async()=>{
  const ui=await start({messages:[message(0)]});
  const node=id=>ui.nodes().find(row=>row.id===id);
  assert.equal(node('reader_panel').mobile,'hidden');assert.equal(node('inbox_panel').mobile,undefined);
  await ui.click('mail_0');assert.equal(node('inbox_panel').mobile,'hidden');assert.equal(node('reader_panel').mobile,undefined);
  await ui.click('requests');assert.ok(node('mail_0'));assert.ok(node('requests_heading'));
  await ui.click('back');assert.equal(node('reader_panel').mobile,'hidden');assert.ok(node('mail_0'));assert.equal(node('requests_heading'),undefined);
});

test('draft keeps its contents and resume action through Activity and mobile Back',async()=>{
  const ui=await start({drafts:[draft('first','Saved subject')],dialog:()=>({cancelled:true})});
  await ui.click('drafts');const row=ui.nodes().find(node=>node.id==='draft_open_0');
  assert.equal(row.eyebrow,'person@example.test');assert.equal(row.description,'message');assert.equal(row.meta,new Date('2026-09-28T00:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric'}));
  await ui.click('draft_open_0');assert.equal(ui.nodes().find(node=>node.id==='compose_subject').text,'Saved subject');
  await ui.click('requests');assert.equal(ui.nodes().find(node=>node.id==='close_requests').label,'Back to draft');
  await ui.click('close_requests');assert.equal(ui.nodes().find(node=>node.id==='compose_subject').text,'Saved subject');
  await ui.click('requests');await ui.click('back');
  assert.equal(ui.nodes().find(node=>node.id==='compose').label,'Resume draft');
  await ui.click('compose');assert.equal(ui.nodes().find(node=>node.id==='compose_subject').text,'Saved subject');
  assert.equal(ui.stores.drafts.get('first').value.to,'person@example.test');
  await ui.click('discard');assert.equal(ui.nodes().find(node=>node.id==='reader_panel').mobile,'hidden');
  assert.equal(ui.nodes().find(node=>node.id==='compose').label,'Compose');assert.equal(ui.stores.drafts.get('first').value.subject,'Saved subject');
});

test('lifecycle submitted drafts remain absent after their Activity item is gone',async()=>{
  const submitted=draft('submitted','Already submitted');submitted.value.mode='submitted';
  const ui=await start({drafts:[submitted,draft('editing','Still editing')]});await ui.click('drafts');
  assert.equal(ui.nodes().filter(node=>node.id.startsWith('draft_open_')).length,1);
  assert.equal(ui.nodes().find(node=>node.id==='draft_open_0').label,'Still editing');
});

test('untrusted body remains plain text in the emitted reader document',async()=>{
  const body='<img src="https://tracker.example.test/pixel" onerror="alert(1)"><script>alert(1)</script>';
  const ui=await start({messages:[{...message(0),body}]});
  assert.equal(ui.documents.length,0);await ui.click('load_document');
  const rendered=ui.nodes().find(node=>node.id==='mail_body');assert.equal(rendered.kind,'document');assert.equal(rendered.format,'plain');assert.equal(rendered.content,body);
  assert.ok(ui.nodes().every(node=>['stack','text','button','input','document'].includes(node.kind)));
});

test('unknown persisted draft request never reopens an action after response loss',async()=>{
  let dialogs=0;
  const ui=await start({drafts:[draft('first','Saved subject')],dialog:()=>{dialogs++;throw Error('Response lost');}});
  await ui.click('drafts');await ui.click('draft_open_0');assert.equal(dialogs,1);
  await ui.click('open_composer');assert.equal(dialogs,1);
  assert.match(ui.nodes().find(node=>node.id==='status').text,/unknown outcome.*do not resend/);
  assert.equal([...ui.stores.requests.values()].length,1);
});

test('a successful draft becomes a new Compose action and cannot reopen from saved drafts',async()=>{
  const ui=await start({drafts:[draft('first','Saved subject')],dialog:stores=>{stores.drafts.get('first').value.mode='submitted';return {run:{id:'run-2',state:'succeeded',submitted_input:{to:'person@example.test',subject:'Saved subject'}}};}});
  await ui.click('drafts');await ui.click('draft_open_0');
  assert.equal(ui.stores.drafts.get('first').value.mode,'submitted');
  assert.equal(ui.nodes().find(node=>node.id==='compose').label,'Compose');
  await ui.click('drafts');assert.equal(ui.nodes().filter(node=>node.id.startsWith('draft_open_')).length,0);
});

test('invalid saved subjects do not enter the trusted composer and reply subjects are not truncated',async()=>{
  let dialogs=0;const invalid=draft('first','Injected\r\nBcc: other@example.test');
  const ui=await start({drafts:[invalid],messages:[{...message(0),sender:'person@example.test',subject:'s'.repeat(200)}],dialog:()=>{dialogs++;return {cancelled:true};}});
  await ui.click('drafts');await ui.click('draft_open_0');assert.equal(dialogs,0);
  await ui.click('folder_inbox');await ui.click('reply');assert.equal(dialogs,0);
  assert.match(ui.nodes().find(node=>node.id==='status').text,/request is unavailable/);
});

test('metadata Inbox reads no bodies and lazy selected read uses its UUID; missing Message-ID disables replies',async()=>{
  const mail={...message(0),message_id:''};const ui=await start({messages:[mail]});
  assert.equal(ui.documents.length,0);assert.equal(ui.nodes().find(node=>node.id==='reply').disabled,true);
  await ui.click('mail_0');assert.deepEqual(ui.documents,[{key:'inbox',id:mail.record_id}]);
  assert.equal(ui.nodes().find(node=>node.id==='mail_body').content,'message');
  assert.equal(ui.nodes().find(node=>node.id==='reply').disabled,true);assert.equal(ui.nodes().find(node=>node.id==='reply_all').disabled,true);
});

test('reply all opens trusted composer with own aliases removed and immutable parent UUID in reviewed rich-capable draft',async()=>{
  let captured;const mail={...message(0),reply_to:'reply@example.test',recipients:'owner@example.test, alias@example.test, other@example.test',cc:'other@example.test, cc@example.test'};
  const ui=await start({messages:[mail],dialog:(_stores,input)=>{captured=input;return {cancelled:true};}});
  await ui.click('mail_0');await ui.click('reply_all');
  assert.equal(captured.action_key,'send_message');assert.equal(captured.input.to,'reply@example.test');assert.equal(captured.input.cc,'other@example.test, cc@example.test');assert.equal(captured.input.parent_record_id,mail.record_id);assert.deepEqual(Object.keys(captured.input).sort(),['bcc','body','body_html','cc','parent_record_id','subject','to']);
  const saved=[...ui.stores.drafts.values()][0].value;assert.deepEqual(Object.keys(saved).sort(),['bcc','body','body_html','cc','mode','reply_record_id','subject','to']);assert.equal(saved.reply_record_id,mail.record_id);
});

test('new compose uses the same send binding and an empty parent record with exact capture input',async()=>{
  let captured;const ui=await start({dialog:(_stores,input)=>{captured=input;return {cancelled:true};}});await ui.click('compose');
  assert.equal(captured.action_key,'send_message');assert.equal(captured.input.parent_record_id,'');assert.deepEqual(Object.keys(captured.input).sort(),['bcc','body','body_html','cc','parent_record_id','subject','to']);
  const saved=[...ui.stores.drafts.values()][0].value;assert.equal(saved.cc,'');assert.equal(saved.mode,'compose');assert.equal(saved.reply_record_id,'');
});

test('Archive nominates only host record UUID through trusted confirmation, never a provider locator',async()=>{
 let capture;const row=message(0);const ui=await start({messages:[row],dialog:(_stores,input)=>{capture=input;return {cancelled:true};}});
 await ui.click('mail_0');await ui.click('triage_archive');
 assert.equal(capture.action_key,'triage_message');assert.equal(capture.input.record_ids,row.record_id);assert.equal(capture.input.operation,'archive');
 assert.equal(ui.external.length,0);assert.equal(ui.stores.requests.size,0);
});

test('account filter excludes another account and conversations never group across accounts',async()=>{
  const first=message(0),second={...message(1),account_id:'other',conversation_id:first.conversation_id};const ui=await start({messages:[first,second]});
  assert.equal(ui.nodes().find(node=>node.id==='thread_scope'),undefined);
  await ui.input('account','account');await ui.click('apply_account');assert.equal(ui.nodes().filter(node=>/^mail_\d+$/.test(node.id)).length,1);assert.equal(ui.nodes().find(node=>node.id==='mail_0').label,first.subject);
});

test('daily header lives in the list column and search scopes stay closed until requested',async()=>{
 const ui=await start({messages:[message(0)]}),node=id=>ui.nodes().find(row=>row.id===id);
 assert.equal(node('toolbar'),undefined);assert.equal(node('brand'),undefined);
 assert.equal(node('inbox_panel').children[0].id,'inbox_heading');
 assert.deepEqual(Array.from(node('inbox_actions').children,row=>row.id),['toggle_search','refresh','select_messages','compose']);
 assert.equal(node('search_controls'),undefined);assert.equal(node('query'),undefined);assert.equal(node('search_scope'),undefined);
 assert.ok(ui.view().navigation.some(row=>row.id==='requests'));assert.equal(node('requests'),undefined);
 await ui.click('toggle_search');assert.match(node('search_scope').text,/loaded mail across folders.*text is not searched/);
 await ui.input('query','Subject');await ui.click('search');assert.equal(node('list_heading').text,'Search results');
 await ui.click('close_search');assert.equal(node('query'),undefined);assert.match(node('search_query').text,/Subject.*loaded mail across folders/);
 await ui.click('clear_search');assert.equal(node('list_heading').text,'Inbox');assert.equal(node('query'),undefined);
});

test('current mailbox scope appears only during search and a failed folder load does not retain another folder',async()=>{
 let failSent=false;const calls=[];
 const ui=await start({messages:[message(0)],browseRead:args=>{calls.push(args);if(failSent&&args.folder==='sent')throw Error('Unavailable');return {items:[{record_id:message(0).record_id,label:'Subject 0',data:message(0)}],next_cursor:null,complete:true,observed_at:'2026-10-03T10:00:00.000Z',failure_count:0};}});
 const node=id=>ui.nodes().find(row=>row.id===id);
 assert.equal(node('mail_source'),undefined);await ui.click('toggle_search');assert.ok(node('mail_source'));
 await ui.click('browse_mailbox');assert.match(node('search_scope').text,/Inbox in the current account/);
 await ui.click('close_search');assert.equal(node('mail_source'),undefined);assert.equal(node('folder_coverage'),undefined);
 failSent=true;await ui.click('folder_sent');assert.equal(node('mail_0'),undefined);assert.equal(node('mail_subject'),undefined);
 assert.match(node('empty_inbox').text,/unavailable.*Refresh/);assert.equal(node('inbox_panel').mobile,undefined);
 assert.equal(calls.at(-1).folder,'sent');assert.equal(ui.external.length,0);
});

test('ordinary Inbox and Refresh use current provider pages when the saved index is empty',async()=>{
 const calls=[],mail=message(0),ui=await start({browseRead:args=>{calls.push(args);return {items:[{record_id:mail.record_id,label:mail.subject,data:mail}],next_cursor:null,complete:true,observed_at:'2026-10-03T10:00:00Z',failure_count:0};},searchRead:()=>{throw Error('Saved index must not serve current mailbox');},recordRead:()=>{throw Error('Provider metadata must not require saved projection');}});
 assert.equal(ui.nodes().find(row=>row.id==='mail_0').label,mail.subject);
 assert.match(ui.nodes().find(row=>row.id==='loaded_count').text,/1 message · this page/);
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{operation:'list',folder:'inbox'}]);
 await ui.click('refresh');await ui.click('folder_sent');await ui.click('folder_archive');await ui.click('folder_inbox');
 assert.deepEqual(calls.map(row=>row.folder),['inbox','inbox','sent','archive','inbox']);
 assert.ok(calls.every(row=>row.operation==='list'));assert.equal(ui.external.length,0);assert.equal(ui.documents.length,0);
});

test('explicit Loaded mail retains the saved-index fallback and normal folder choice',async()=>{
 const calls=[],mail=message(0),ui=await start({messages:[mail],browseRead:args=>{calls.push(args);return {items:[],next_cursor:null,complete:true,observed_at:'2026-10-03T10:00:00Z',failure_count:0};}});
 assert.equal(ui.nodes().find(row=>row.id==='mail_0'),undefined);
 await ui.click('toggle_search');await ui.click('loaded_mail');
 assert.equal(ui.nodes().find(row=>row.id==='mail_0').label,mail.subject);
 assert.match(ui.nodes().find(row=>row.id==='search_scope').text,/loaded mail across folders/);
 await ui.click('refresh');await ui.click('folder_sent');assert.equal(calls.length,1);
 assert.match(ui.nodes().find(row=>row.id==='loaded_count').text,/0 loaded messages/);
});

test('default provider mode preserves a kept draft and exact trusted triage nomination',async()=>{
 const calls=[],mail=message(0),submitted=[],ui=await start({messages:[mail],browseRead:args=>{calls.push(args);return {items:[{record_id:mail.record_id,label:mail.subject,data:mail}],next_cursor:null,complete:true,observed_at:'2026-10-03T10:00:00Z',failure_count:0};},dialog:(_stores,input)=>{submitted.push(input);return {cancelled:true};}});
 await ui.click('compose');await ui.input('to','controlled@example.test');await ui.input('subject','Kept draft');await ui.input('body','Exact draft');
 await ui.click('refresh');assert.equal(calls.length,1);assert.match(ui.nodes().find(row=>row.id==='status').text,/draft is kept/);
 await ui.click('save_draft');await ui.click('requests');await ui.click('back');await ui.click('refresh');assert.equal(calls.length,2);
 assert.ok([...ui.stores.drafts.values()].some(row=>row.value.subject==='Kept draft'&&row.value.body==='Exact draft'));
 await ui.click('triage_archive');assert.equal(submitted.at(-1).action_key,'triage_message');assert.equal(submitted.at(-1).input.record_ids,mail.record_id);assert.equal(submitted.at(-1).input.operation,'archive');assert.equal(ui.external.length,0);
});

test('unavailable provider handle asks for explicit mailbox Refresh and recovers only through a fresh record',async()=>{
 const old=message(0),fresh={...old,record_id:message(1).record_id};let lists=0;
 const ui=await start({messages:[old,fresh],browseRead:args=>{if(args.operation==='list')lists++;const mail=lists>1?fresh:old;return {items:[{record_id:mail.record_id,label:mail.subject,data:mail}],next_cursor:null,complete:true,observed_at:'2026-10-03T10:00:00Z',failure_count:0};},documentRead:(_mail,id)=>{if(id===old.record_id)throw Error('UNAVAILABLE');return {format:'plain',content:'Controlled refreshed body',truncated:false,metadata:documentMetadata(fresh)};}});
 await ui.click('mail_0');await ui.click('load_document');
 assert.match(ui.nodes().find(row=>row.id==='status').text,/Refresh the mailbox, select the message, then load its text again/);
 assert.ok(ui.nodes().find(row=>row.id==='refresh'));assert.equal(ui.nodes().find(row=>row.id==='reply').disabled,true);
 assert.deepEqual(ui.documents.map(row=>row.id),[old.record_id,old.record_id]);assert.equal(lists,1);
 await ui.click('refresh');assert.equal(ui.documents.length,2);assert.equal(lists,2);
 await ui.click('mail_0');assert.equal(ui.nodes().find(row=>row.id==='mail_body').content,'Controlled refreshed body');assert.equal(ui.nodes().find(row=>row.id==='reply').disabled,false);
 assert.deepEqual(ui.documents.map(row=>row.id),[old.record_id,old.record_id,fresh.record_id]);assert.equal(ui.external.length,0);
});

test('advanced search uses reviewed typed filters and preserves the exact filter set during paging',async()=>{
 const calls=[],mail=message(0);const ui=await start({messages:[mail],browseRead:args=>{calls.push(args);return {items:[{record_id:mail.record_id,label:mail.subject,data:mail}],next_cursor:args.operation==='search'?'next':null,complete:false,observed_at:'2026-10-03T10:00:00Z',failure_count:0};}});
 await ui.click('toggle_search');await ui.click('browse_mailbox');await ui.click('toggle_filters');
 await ui.input('filter_from','sender@example.test');await ui.click('filter_has_attachments');await ui.click('search');
 assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{operation:'search',folder:'inbox',filters:{from:'sender@example.test',has_attachments:true}});
 await ui.click('more_search');assert.equal(calls.at(-1).cursor,'next');assert.equal(calls.at(-1).filters.from,'sender@example.test');
 assert.equal(Object.hasOwn(calls.at(-1),'query'),false);
});

test('Move and label selections use named current-account options and immutable selected host IDs',async()=>{
 const mail=message(0),submitted=[];const ui=await start({messages:[mail],triageOptions:()=>({account_id:'account',provider:'gmail',labels_supported:true,complete:true,destinations:[{id:'folder-private-id',label:'Receipts',kind:'label'}],labels:[{id:'label-private-id',label:'Follow up'}]}),dialog:(_stores,input)=>{submitted.push(input);return {cancelled:true};}});
 await ui.click('toggle_actions');await ui.click('choose_move');assert.equal(ui.nodes().find(row=>row.id==='triage_option_0').label,'Receipts');
 await ui.click('triage_option_0');assert.equal(submitted[0].input.destination,'folder-private-id');assert.equal(submitted[0].input.record_ids,mail.record_id);
 await ui.click('choose_labels');await ui.click('triage_option_0');await ui.click('triage_labels_apply');assert.equal(submitted[1].input.add_labels,'label-private-id');assert.equal(submitted[1].input.remove_labels,'');
 const foreign=await start({messages:[mail],triageOptions:()=>({account_id:'other',destinations:[{id:'secret',label:'Foreign secret'}],labels:[]})});await foreign.click('toggle_actions');await foreign.click('choose_move');assert.equal(JSON.stringify(foreign.view()).includes('Foreign secret'),false);
});

test('confirmed coverage is quiet, details preserve exact headers and single messages add no conversation toggle',async()=>{
 const mail=message(0),ui=await start({messages:[mail],documentRead:row=>certifiedDocument(row,1)}),node=id=>ui.nodes().find(row=>row.id===id);
 await ui.click('mail_0');assert.equal(node('conversation_coverage'),undefined);assert.equal(node('toggle_conversation'),undefined);assert.equal(node('mail_metadata'),undefined);
 assert.equal(node('reader_heading').children[0].id,'mail_subject');assert.equal(node('mail_body').content,'message');
 await ui.click('toggle_details');assert.match(node('conversation_coverage').text,/Complete conversation/);assert.equal(node('mail_sender').text,`From: ${mail.sender}`);
 await ui.click('toggle_details');assert.equal(node('mail_metadata'),undefined);assert.equal(node('conversation_coverage'),undefined);
});

test('attachment access is contextual and goes through the selected host resource',async()=>{
 const mail={...message(0),files_status:'lazy'},ui=await start({messages:[mail]});await ui.click('mail_0');
 assert.equal(ui.nodes().find(row=>row.id==='attachment_summary'),undefined);assert.equal(ui.nodes().find(row=>row.id==='open_attachments').label,'View attachments');await ui.click('toggle_details');assert.match(ui.nodes().find(row=>row.id==='attachment_summary').text,/not been loaded/);
 assert.ok(ui.nodes().find(row=>row.id==='files_followups'));
 await ui.click('open_attachments');assert.deepEqual(ui.opened,[{key:'inbox',id:mail.record_id}]);assert.equal(ui.external.length,0);
});

test('draft refresh retains Drafts and unavailable drafts never claim an empty saved list',async()=>{
 const ui=await start({drafts:[draft('first','Saved subject')]});await ui.click('drafts');await ui.click('refresh');
 assert.ok(ui.nodes().find(row=>row.id==='draft_open_0'));assert.equal(ui.nodes().find(row=>row.id==='list_heading'),undefined);
 assert.equal(ui.nodes().find(row=>row.id==='drafts_list_heading').children.at(-1).id,'inbox_actions');
 const failed=await start({drafts:[draft('first','Saved subject')],draftRead:()=>{throw Error('Unavailable');}});await failed.click('drafts');
 assert.match(failed.nodes().find(row=>row.id==='drafts_empty').text,/unavailable.*Refresh/);
 assert.ok(failed.views.some(view=>JSON.stringify(view).includes('Loading saved drafts')));assert.equal(failed.external.length,0);
});

test('provider conversation refresh preserves one current document only while reply-parent metadata agrees',async()=>{
 const parent={...message(0),sender:'owner@example.test',recipients:'other@example.test',in_inbox:false,in_sent:true},sibling={...message(1),conversation_id:parent.conversation_id,sender:'other@example.test',recipients:'owner@example.test'};
 let changed=false,capture;
 const ui=await start({messages:[parent,sibling],documentRead:mail=>certifiedDocument(mail,2),dialog:(_stores,input)=>{capture=input;return {cancelled:true};},browseRead:args=>{
  const rows=args.operation==='conversation'?[{...parent,...(changed?{message_id:'<new-parent@example.test>'}:{})},sibling]:[parent];
  return {items:rows.map(data=>({record_id:data.record_id,label:data.subject,data})),next_cursor:null,complete:true,observed_at:'2025-01-01T00:00:00.000Z',failure_count:0};
 }});
 await ui.click('toggle_search');await ui.click('browse_mailbox');await ui.click('mail_0');
 assert.equal(ui.nodes().find(row=>row.id==='mail_body').content,'message');assert.equal(ui.nodes().find(row=>row.id==='reply').disabled,false);assert.equal(ui.documents.length,1);
 assert.equal(ui.nodes().find(row=>row.id==='conversation_coverage'),undefined);
 await ui.click('reply_all');assert.equal(capture.input.to,'other@example.test');assert.equal(capture.input.parent_record_id,parent.record_id);
 await ui.click('discard');await ui.click('folder_sent');changed=true;await ui.click('mail_0');
 assert.match(ui.nodes().find(row=>row.id==='mail_body').text,/has not been loaded/);assert.equal(ui.nodes().find(row=>row.id==='reply').disabled,true);
 assert.equal(ui.nodes().find(row=>row.id==='conversation_coverage'),undefined);await ui.click('toggle_details');assert.match(ui.nodes().find(row=>row.id==='conversation_coverage').text,/headers on conversation page/);
 assert.equal(ui.external.length,0);
});


test('Forward uses complete source headers without Message-ID and opens a new unthreaded editable draft',async()=>{
 const mail={...message(0),message_id:''};let capture;
 const ui=await start({messages:[mail],dialog:(_stores,input)=>{capture=input;return {cancelled:true};}});
 await ui.click('mail_0');assert.equal(ui.nodes().find(node=>node.id==='reply').disabled,true);assert.equal(ui.nodes().find(node=>node.id==='forward').disabled,false);
 await ui.click('forward');assert.equal(capture.input.parent_record_id,'');assert.equal(capture.input.to,'');assert.match(capture.input.body,/Forwarded message/);assert.match(capture.input.subject,/Fwd:/);
});

test('print leaf uses authoritative source headers, keeps full bounded recipients, and bounds preview title',async()=>{
 const mail={...message(0),subject:'preview'.repeat(80),recipients:'preview@example.test'};
 const authoritative='Person <'+('a'.repeat(1980))+'@example.test>, copy@example.test';
 const ui=await start({messages:[mail],documentRead:row=>certifiedDocument(row,1,{subject:'Actual subject',reply_to_list:authoritative,reply_from:'actual@example.test',reply_cc:'actual-copy@example.test'})});
 await ui.click('mail_0');const node=ui.nodes().find(node=>node.id==='mail_body');assert.equal(node.title,'Actual subject');
 assert.equal(node.metadata.filter(row=>row.label.startsWith('To')).map(row=>row.value).join(''),authoritative);assert.equal(node.metadata.find(row=>row.label==='From').value,'actual@example.test');assert.equal(node.metadata.find(row=>row.label==='Cc').value,'actual-copy@example.test');assert.equal(JSON.stringify(node.metadata).includes('preview@example.test'),false);
});

test('Activity expands one bounded per-item receipt with friendly subjects, truthful failure, and fresh undo',async()=>{
 const messages=Array.from({length:25},(_,i)=>message(i));const runIds=Array.from({length:10},(_,i)=>message(30+i).record_id);
 const requests=runIds.map((id,i)=>({record_id:message(40+i).record_id,revision:1,value:{action_key:'triage_message',label:'Mailbox change',summary:'Bulk change',source_record_id:messages[0].record_id,draft_record_id:'',run_id:id,state:'failed',created_at:'2026-09-28T00:00:00Z'}}));
 const output=id=>({id,state:'failed',output:{operation_id:id,succeeded_count:24,failed_count:1,unknown_count:0,undo_available:true,automatic_retry:false,items:messages.map((row,i)=>row.record_id+': '+(i===24?'failed (EMAIL_TRIAGE_CONFLICT)':'succeeded')).join('\n')}});
 let capture;const ui=await start({messages,requests,runStatus:output,dialog:(_stores,input)=>{capture=input;return {cancelled:true};}});
 await ui.click('requests');assert.equal(ui.nodes().filter(node=>/^action_item_/.test(node.id)).length,0);await ui.click('run_details_0');
 let rows=ui.nodes().filter(node=>/^action_item_/.test(node.id));assert.equal(rows.length,25);assert.match(rows[0].text,/Subject 0 · Completed/);assert.match(rows[24].text,/Failed · email triage conflict/);assert.ok(!rows.some(node=>/[a-f0-9]{8}-[a-f0-9-]{27}/i.test(node.text)));assert.ok(ui.nodes().length<=256);assert.ok(new TextEncoder().encode(JSON.stringify(ui.view())).byteLength<60*1024);
 await ui.click('run_details_1');assert.equal(ui.nodes().filter(node=>/^action_item_0_/.test(node.id)).length,0);assert.equal(ui.nodes().filter(node=>/^action_item_1_/.test(node.id)).length,25);
 await ui.click('run_remove_9');await ui.click('run_undo_0');assert.equal(capture.action_key,'triage_message');assert.equal(capture.input.operation,'undo');assert.equal(capture.input.destination,runIds[0]);assert.equal(capture.input.record_ids.split(',').length,25);
});


test('Activity keeps exact triage identity in optional details without changing saved state or retrying',async()=>{
 const entry=request('triage_message');entry.value.summary='archive · 1 message(s) · '+'a'.repeat(64);entry.value.run_id='';entry.value.state='unknown';
 const ui=await start({requests:[entry]});await ui.click('requests');
 assert.equal(ui.nodes().find(node=>node.id==='action_summary_0').text,'archive · 1 message(s)');
 assert.equal(ui.nodes().find(node=>node.id==='action_identity_0'),undefined);
 assert.match(ui.nodes().find(node=>node.id==='action_state_0').text,/unknown/i);
 await ui.click('run_details_0');assert.equal(ui.nodes().find(node=>node.id==='action_identity_0').text,entry.value.summary);
 assert.equal(ui.stores.requests.get('request').value.summary,entry.value.summary);assert.equal(ui.external.length,0);assert.equal(ui.checks.length,0);
 await ui.click('run_details_0');assert.equal(ui.nodes().find(node=>node.id==='action_identity_0'),undefined);
});

test('same-mailbox Refresh retains rows, selection and reader while awaiting provider without false empty count',async()=>{
 const mail=message(0);let release,calls=0;
 const page={items:[{record_id:mail.record_id,label:mail.subject,data:mail}],next_cursor:null,complete:true,observed_at:'2026-10-03T10:00:00Z',failure_count:0};
 const ui=await start({messages:[mail],browseRead:async args=>{if(args.operation==='list')calls++;if(args.operation==='list'&&calls>1)await new Promise(resolve=>release=resolve);return page;}});
 await ui.click('mail_0');const pending=ui.click('refresh');await new Promise(resolve=>setTimeout(resolve,5));
 assert.ok(ui.nodes().find(node=>node.id==='mail_0'),'existing row remains during refresh');
 assert.equal(ui.nodes().find(node=>node.id==='mail_0').selected,true);
 assert.equal(ui.nodes().find(node=>node.id==='mail_body').content,'message');
 assert.match(ui.nodes().find(node=>node.id==='loaded_count').text,/1 message/);
 assert.equal(ui.nodes().filter(node=>/Loading|Refreshing/.test(node.text||'')).length,1);
 assert.equal(ui.nodes().find(node=>node.id==='reply').disabled,true);
 release();await pending;
 assert.equal(ui.nodes().find(node=>node.id==='mail_0').selected,true);
 assert.equal(ui.documents.length,2,'refresh reads a new trusted document even when the reference is unchanged');
 assert.equal(ui.nodes().find(node=>node.id==='reply').disabled,false);
 assert.equal(ui.external.length,0);
});


test('reader selection publishes the chosen title before document wait with one loading indicator and no previous body',async()=>{
 const a={...message(0),body:'Private previous body'},b={...message(1),body:'Chosen body'};let release,reads=0;
 const ui=await start({messages:[a,b],documentRead:async mail=>{reads++;if(reads>1)await new Promise(resolve=>release=resolve);return certifiedDocument(mail,1);}});
 await ui.click('mail_1');const pending=ui.click('mail_0');await new Promise(resolve=>setTimeout(resolve,5));
 try{assert.equal(ui.nodes().find(node=>node.id==='mail_subject').text,b.subject);assert.equal(JSON.stringify(ui.nodes().find(node=>node.id==='reader_panel')).includes(a.body),false);assert.equal(ui.nodes().filter(node=>/Loading message/.test(node.text||node.label||'')).length,1);assert.equal(ui.nodes().find(node=>node.id==='reply').disabled,true);}finally{release();}
 await pending;assert.equal(ui.nodes().find(node=>node.id==='mail_body').content,b.body);
});

test('first boot renders one loading indication and never claims an empty mailbox before reading',async()=>{
 const ui=await start({messages:[message(0)]});const first=JSON.stringify(ui.views[0]);
 assert.equal((first.match(/Loading messages/g)||[]).length,1);assert.equal(first.includes('0 messages'),false);
});

test('Print appears only in More and links the current document for host-only handling',async()=>{
 const ui=await start({messages:[message(0)]});await ui.click('mail_0');
 assert.equal(ui.nodes().find(node=>node.id==='print_message'),undefined);assert.equal(ui.nodes().find(node=>node.id==='mail_body').printable,false);
 await ui.click('toggle_actions');assert.equal(ui.nodes().find(node=>node.id==='print_message').label,'Print');assert.equal(ui.nodes().find(node=>node.id==='mail_body').print_control_id,'print_message');assert.equal(ui.nodes().find(node=>node.id==='mail_body').printable,true);
 await ui.click('print_message');assert.equal(ui.external.length,0);assert.equal(ui.documents.length,1);
 await ui.click('toggle_actions');assert.equal(ui.nodes().find(node=>node.id==='print_message'),undefined);assert.equal(ui.nodes().find(node=>node.id==='mail_body').print_control_id,undefined);
});

const providerPage=rows=>({items:rows.map(data=>({record_id:data.record_id,label:data.subject,data,...(data.revision?{revision:data.revision}:{})})),next_cursor:null,complete:true,observed_at:'2026-10-03T10:00:00Z',failure_count:0});
test('Refresh reconciles a selected message to its fresh scoped reference and reloads its body',async()=>{
 const first=message(0),old={...message(1),body:'Old selected body'},fresh={...old,record_id:message(20).record_id,body:'Fresh selected body'};let lists=0;
 const ui=await start({messages:[first,old,fresh],browseRead:async args=>providerPage(args.operation==='list'?(++lists===1?[first,old]:[first,fresh]):[old])});
 await ui.click('mail_1');await ui.click('refresh');
 assert.equal(ui.nodes().find(n=>n.id==='mail_1').selected,true);
 assert.equal(ui.nodes().find(n=>n.id==='mail_body')?.content,fresh.body);
 assert.deepEqual(ui.documents.map(n=>n.id),[old.record_id,fresh.record_id]);
 assert.equal(ui.nodes().find(n=>n.id==='reply').disabled,false);assert.equal(ui.external.length,0);
});
test('same-account Refresh keeps a labelled presentation while the fresh selected document is held, without old reply authority',async()=>{
 const old={...message(1),body:'Previously validated body'},fresh={...old,record_id:message(20).record_id,body:'Fresh selected body'};let lists=0,release,requested;
 const held=new Promise(resolve=>requested=resolve);
 const ui=await start({messages:[old,fresh],browseRead:async args=>providerPage(args.operation==='list'?(++lists===1?[old]:[fresh]):[old]),documentRead:async(mail,id)=>{
  if(id===fresh.record_id){requested();await new Promise(resolve=>release=resolve);}return certifiedDocument(mail,1);
 }});
 await ui.click('mail_0');const pending=ui.click('refresh');await held;
 try{assert.equal(ui.nodes().find(n=>n.id==='mail_body')?.content,old.body);assert.match(ui.nodes().find(n=>n.id==='retained_body_notice')?.text||'',/Previously loaded/);assert.equal(ui.nodes().find(n=>n.id==='reply').disabled,true);assert.equal(ui.nodes().find(n=>n.id==='forward').disabled,true);}finally{release();await pending;}
 assert.equal(ui.nodes().find(n=>n.id==='mail_body')?.content,fresh.body);assert.equal(ui.nodes().find(n=>n.id==='retained_body_notice'),undefined);assert.equal(ui.nodes().find(n=>n.id==='reply').disabled,false);assert.equal(ui.external.length,0);
});
test('Refresh clears a retained preview when a known source revision or message headers change',async()=>{
 for(const change of ['revision','headers']){
  const old={...message(1),revision:'source-v1',body:'Private old body'},fresh={...old,record_id:message(20).record_id,...(change==='revision'?{revision:'source-v2'}:{subject:'Changed subject'}),body:'Validated new body'};let lists=0,release,requested;
  const held=new Promise(resolve=>requested=resolve);
  const ui=await start({messages:[old,fresh],browseRead:async args=>providerPage(args.operation==='list'?(++lists===1?[old]:[fresh]):[old]),documentRead:async(mail,id)=>{if(id===fresh.record_id){requested();await new Promise(resolve=>release=resolve);}return certifiedDocument(mail,1);}});
  await ui.click('mail_0');const pending=ui.click('refresh');await held;
  try{assert.equal(ui.nodes().find(n=>n.id==='mail_body')?.content,undefined,change);assert.equal(ui.nodes().find(n=>n.id==='retained_body_notice'),undefined,change);assert.equal(ui.nodes().find(n=>n.id==='reply').disabled,true,change);}finally{release();await pending;}
  assert.equal(ui.nodes().find(n=>n.id==='mail_body')?.content,fresh.body,change);
 }
});
test('account selection immediately clears a retained preview and discards the held old document',async()=>{
 const old={...message(1),body:'Private old body'},fresh={...old,record_id:message(20).record_id,body:'Late old-account body'};let lists=0,release,requested;
 const held=new Promise(resolve=>requested=resolve);
 const ui=await start({messages:[old,fresh],browseRead:async args=>providerPage(args.operation==='list'?(++lists===1?[old]:[fresh]):[old]),documentRead:async(mail,id)=>{if(id===fresh.record_id){requested();await new Promise(resolve=>release=resolve);}return certifiedDocument(mail,1);}});
 await ui.click('mail_0');const pending=ui.click('refresh');await held;
 try{await ui.input('account','other');assert.equal(ui.nodes().find(n=>n.id==='mail_body')?.content,undefined);assert.equal(ui.nodes().find(n=>n.id==='retained_body_notice'),undefined);}finally{release();await pending;}
 assert.equal(JSON.stringify(ui.view()).includes('Late old-account body'),false);assert.equal(ui.external.length,0);
});
test('Refresh never automatically reads missing, foreign or ambiguous logical identities',async()=>{
 for(const kind of ['missing','foreign','ambiguous']){
  const old={...message(1),body:'Private old body'},fresh={...old,record_id:message(20).record_id},other={...fresh,record_id:message(21).record_id};
  const next=kind==='missing'?[message(0)]:kind==='foreign'?[{...fresh,account_id:'foreign'}]:[fresh,other];let lists=0;
  const ui=await start({messages:[old,...next],browseRead:async args=>providerPage(args.operation==='list'?(++lists===1?[old]:next):[old])});
  await ui.click('mail_0');await ui.click('refresh');
  assert.equal(ui.documents.length,1,kind);assert.equal(ui.nodes().find(n=>n.id==='mail_body')?.content,undefined,kind);
  assert.equal(ui.nodes().find(n=>n.id==='reply').disabled,true,kind);assert.equal(ui.external.length,0);
 }
});
test('Refresh cannot restore old reply authority when the fresh selected document fails',async()=>{
 const old=message(1),fresh={...old,record_id:message(20).record_id};let lists=0;
 const ui=await start({messages:[old,fresh],browseRead:async args=>providerPage(args.operation==='list'?(++lists===1?[old]:[fresh]):[old]),documentRead:async(mail,id)=>{if(id===fresh.record_id)throw Error('Gone');return certifiedDocument(mail,1);}});
 await ui.click('mail_0');await ui.click('refresh');
 assert.deepEqual(ui.documents.map(n=>n.id),[old.record_id,fresh.record_id]);assert.equal(ui.nodes().find(n=>n.id==='mail_body')?.content,undefined);
 assert.equal(ui.nodes().find(n=>n.id==='reply').disabled,true);assert.match(ui.nodes().find(n=>n.id==='status').text,/Refresh the mailbox/);assert.equal(ui.external.length,0);
});
test('Empty mailbox failures and explicit retries have one actionable status owner',async()=>{
 let release,lists=0;const ui=await start({browseRead:async()=>{if(++lists>1)await new Promise(resolve=>release=resolve);throw Error('Unavailable');}});
 assert.equal(ui.nodes().filter(n=>/unavailable/i.test(n.text||'')).length,1);
 const pending=ui.click('refresh');await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(ui.nodes().filter(n=>/Loading messages|Refreshing messages/.test(n.text||'')).length,1);
 release();await pending;assert.equal(ui.nodes().filter(n=>/unavailable/i.test(n.text||'')).length,1);assert.equal(ui.external.length,0);
});
test('Refresh reruns the committed mailbox search and preserves its selected fresh message',async()=>{
 const first=message(0),old={...message(1),body:'Old search body'},fresh={...old,record_id:message(20).record_id,body:'Fresh search body'};const operations=[];let searches=0;
 const ui=await start({messages:[first,old,fresh],browseRead:async args=>{operations.push(args);return providerPage(args.operation==='search'?(++searches===1?[old]:[fresh]):args.operation==='conversation'?[old]:[first]);}});
 await ui.input('query','newsletter');await ui.click('search');await ui.click('hit_0');await ui.input('query','unsubmitted edits');await ui.click('refresh');
 assert.equal(operations.filter(a=>a.operation==='list').length,1);
 assert.deepEqual(operations.filter(a=>a.operation==='search').map(a=>a.filters.text),['newsletter','newsletter']);
 assert.match(ui.nodes().find(n=>n.id==='search_query').text,/newsletter/);
 assert.equal(ui.nodes().find(n=>n.id==='hit_0').selected,true);assert.equal(ui.nodes().find(n=>n.id==='mail_body').content,fresh.body);
 assert.deepEqual(ui.documents.map(n=>n.id),[old.record_id,fresh.record_id]);assert.equal(ui.external.length,0);
});
