import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,existsSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {simpleParser} from 'mailparser';
import {createGmailAdapter} from './gmail.mjs';
import {createMicrosoftAdapter} from './microsoft.mjs';
import {createImapAdapter} from './imap.mjs';
import {PROVIDER_LIMITS} from './contract.mjs';

const fixture=JSON.parse(readFileSync(new URL('../fixtures/launch-stage0/fixtures.json',import.meta.url)));
function account(id='gmail-personal'){const row=fixture.accounts.find(row=>row.id===id);return {account_id:id,provider:row.provider_hint==='imap'?'imap_smtp':row.provider_hint,display_label:row.display_name,primary_address:row.address,verified_sender_identities:[row.address],capabilities:['read','search','thread','send'],connection_target:`target-${id}`,resource_binding_id:`read-${id}`,action_binding_id:`send-${id}`,authority_epoch:1,health:'connected'};}
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
test('Gmail preserves active increasing-page cursor scope and rejects decreases',async()=>{
 const adapter=createGmailAdapter(options('gmail-personal',async url=>{const parsed=new URL(url);assert.ok(parsed.pathname.endsWith('/messages'));return json({messages:[],nextPageToken:parsed.searchParams.has('pageToken')?'next2':'next'});}));
 const first=await adapter.listMessages({limit:2,query:'subject:fixture'});
 const larger=await adapter.listMessages({limit:4,query:'subject:fixture',cursor:first.next_cursor});
 assert.equal(JSON.parse(Buffer.from(larger.next_cursor,'base64url')).binding,JSON.parse(Buffer.from(first.next_cursor,'base64url')).binding);
 await assert.rejects(adapter.listMessages({limit:1,query:'subject:fixture',cursor:first.next_cursor}),error=>error.code==='EMAIL_PROVIDER_CURSOR_INVALID');
 await assert.rejects(adapter.listMessages({limit:4,query:'subject:other',cursor:first.next_cursor}),error=>error.code==='EMAIL_PROVIDER_CURSOR_INVALID');
});
function options(id,fetchImpl,extra={}){return {account:account(id),fetch:fetchImpl,getAccessToken:async()=>`token-${id}`,assertAuthority:async()=>true,reserveSend:async()=>true,...extra};}
async function gmailMessage(row){const mail=await simpleParser(readFileSync(new URL(`../fixtures/launch-stage0/${row.source}`,import.meta.url)));return {id:row.locator.message_id,threadId:row.locator.thread_id,labelIds:row.locator.label_ids,internalDate:String(mail.date.getTime()),historyId:'1',payload:{headers:[{name:'From',value:mail.from.text},{name:'To',value:mail.to.text},{name:'Subject',value:mail.subject},{name:'Message-ID',value:mail.messageId}]}};}
const graphMessage=(id='graph-1',folder='inbox')=>({id,conversationId:'conversation-1',parentFolderId:folder,from:{emailAddress:{address:'reviewer@example.test'}},toRecipients:[{emailAddress:{address:'microsoft@example.test'}}],subject:'Review',receivedDateTime:'2026-09-30T10:00:00Z',isRead:false,hasAttachments:false,internetMessageId:'<stage0-shared@example.test>'});
function outgoing(id='gmail-personal'){const bytes=Buffer.from(`From: ${account(id).primary_address}\r\nTo: reviewer@example.test\r\nCc: collaborator@example.test\r\nBcc: blind-reviewer@example.test\r\nSubject: Stage 1\r\nMessage-ID: <stage1-${id}@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body\r\n`);return {operation_id:`send-${id}`,from_address:account(id).primary_address,mime_bytes:bytes,mime_digest:createHash('sha256').update(bytes).digest('hex')};}

test('Gmail paginates synthetic Inbox/Sent and fetches metadata; counts never use estimate as exact total',async()=>{
 const data=await Promise.all(fixture.messages.slice(0,3).map(gmailMessage)),calls=[];
 const adapter=createGmailAdapter(options('gmail-personal',async(url,init)=>{calls.push({url,init});const path=new URL(url);if(path.pathname.endsWith('/messages'))return json(path.searchParams.has('pageToken')?{messages:[{id:data[2].id}]}:{messages:data.slice(0,2).map(row=>({id:row.id,threadId:row.threadId})),nextPageToken:'gmail-page-2',resultSizeEstimate:900});return json(data.find(row=>path.pathname.endsWith('/'+row.id)));}));
 const first=await adapter.listMessages({limit:2}),second=await adapter.listMessages({limit:2,cursor:first.next_cursor});assert.equal(first.messages.length,2);assert.equal(first.complete,false);assert.equal(first.count.exact_total,null);assert.deepEqual(first.messages[1].folders,['SENT']);assert.equal(second.messages[0].locator.message_id,data[2].id);assert.equal(second.complete,true);assert.equal(calls.length,5);assert.ok(calls.every(call=>call.init.headers.Authorization==='Bearer token-gmail-personal'&&call.init.redirect==='error'));assert.equal(new URL(calls[1].url).searchParams.get('format'),'metadata');
 const other=createGmailAdapter(options('gmail-work',async()=>assert.fail('cross-account cursor must not fetch')));await assert.rejects(other.listMessages({limit:2,cursor:first.next_cursor}),error=>error.code==='EMAIL_PROVIDER_CURSOR_INVALID');
});
test('Gmail conversation includes Sent across local pages and rejects changed-thread cursors',async()=>{
 const messages=await Promise.all(fixture.messages.slice(0,3).map(gmailMessage));let revision=1;
 const adapter=createGmailAdapter(options('gmail-personal',async()=>json({id:messages[0].threadId,messages:messages.map(message=>({...message,historyId:String(revision)}))})));
 const first=await adapter.readConversation({thread_id:messages[0].threadId,limit:2}),second=await adapter.readConversation({thread_id:messages[0].threadId,limit:2,cursor:first.next_cursor});assert.equal(first.messages.length,2);assert.equal(second.messages.length,1);assert.ok([...first.messages,...second.messages].some(message=>message.folders.includes('SENT')));revision++;await assert.rejects(adapter.readConversation({thread_id:messages[0].threadId,limit:2,cursor:first.next_cursor}),error=>error.code==='EMAIL_PROVIDER_CURSOR_EXPIRED');
});
test('Gmail metadata disappearance is a per-message failure and search remains provider-scoped',async()=>{
 const message=await gmailMessage(fixture.messages[0]),calls=[];
 const adapter=createGmailAdapter(options('gmail-personal',async url=>{calls.push(url);const parsed=new URL(url);if(parsed.pathname.endsWith('/messages'))return json({messages:[{id:message.id},{id:'disappeared'}]});return parsed.pathname.endsWith('disappeared')?json({error:{message:'secret'}},404):json(message);}));
 const page=await adapter.searchMessages({query:'from:reviewer@example.test',limit:2});assert.equal(page.messages.length,1);assert.deepEqual(page.failures,[{provider_message_id:'disappeared',code:'EMAIL_PROVIDER_NOT_FOUND'}]);assert.equal(page.complete,false);assert.equal(new URL(calls[0]).searchParams.get('q'),'from:reviewer@example.test');
});
test('revocation during token refresh prevents the next fetch and during read prevents disclosure',async()=>{
 let allowed=true,fetches=0;
 const adapter=createGmailAdapter(options('gmail-personal',async()=>{fetches++;return json({messages:[]});},{getAccessToken:async()=>{allowed=false;return 'refreshed-token';},assertAuthority:async()=>allowed}));await assert.rejects(adapter.listMessages(),error=>error.code==='EMAIL_ACCOUNT_REVOKED');assert.equal(fetches,0);
 const inFlight=createMicrosoftAdapter(options('microsoft',async()=>{allowed=false;return json({value:[graphMessage()]});},{assertAuthority:async()=>allowed}));allowed=true;await assert.rejects(inFlight.listMessages(),error=>error.code==='EMAIL_ACCOUNT_REVOKED');
});
test('provider errors are bounded and safe; read retryability does not retry automatically',async()=>{
 let calls=0;const adapter=createMicrosoftAdapter(options('microsoft',async()=>{calls++;return json({error:{message:'private body and token must never leak'}},429);}));await assert.rejects(adapter.listMessages(),error=>error.code==='EMAIL_PROVIDER_RATE_LIMITED'&&error.status===429&&error.retryable&&!error.message.includes('private'));assert.equal(calls,1);
 const huge=createGmailAdapter(options('gmail-personal',async()=>new Response(' '.repeat(PROVIDER_LIMITS.metadata_bytes+1))));await assert.rejects(huge.listMessages(),error=>error.code==='EMAIL_PROVIDER_RESPONSE_LIMIT');
});
test('Graph preserves entire nextLink and immutable ID preference across folder/thread pages',async()=>{
 const calls=[],next='https://graph.microsoft.com/v1.0/me/messages?$skip=37&$select=id%2CconversationId&$top=1';
 const adapter=createMicrosoftAdapter(options('microsoft',async(url,init)=>{calls.push({url,init});return json(calls.length===1?{value:[graphMessage('received','inbox')],'@odata.nextLink':next}:{value:[graphMessage('sent','sentitems')]});}));
 const first=await adapter.readConversation({conversation_id:'conversation-1',limit:1}),second=await adapter.readConversation({conversation_id:'conversation-1',limit:1,cursor:first.next_cursor});assert.equal(calls[1].url,next);assert.ok(calls.every(call=>call.init.headers.Prefer==='IdType="ImmutableId"'));assert.equal(first.messages[0].locator.id_type,'immutable');assert.equal(second.messages[0].locator.folder_id,'sentitems');assert.equal(new URL(calls[0].url).searchParams.get('$filter'),"conversationId eq 'conversation-1'");
});
test('Graph nextLink cannot move bearer authority to an attacker or another mailbox',async()=>{
 for(const link of ['https://attacker.example/v1.0/me/messages','https://graph.microsoft.com/v1.0/users/other/messages','https://user:password@graph.microsoft.com/v1.0/me/messages']){
  let calls=0;const adapter=createMicrosoftAdapter(options('microsoft',async()=>{calls++;return json({value:[graphMessage()],'@odata.nextLink':link});}));const first=await adapter.listMessages({limit:1});await assert.rejects(adapter.listMessages({limit:1,cursor:first.next_cursor}),error=>error.code==='EMAIL_PROVIDER_CURSOR_INVALID');assert.equal(calls,1);
 }
});
test('Graph search reports provider result cap and never claims complete mailbox coverage',async()=>{
 let url;const adapter=createMicrosoftAdapter(options('microsoft',async value=>{url=value;return json({value:[graphMessage()]});}));const page=await adapter.searchMessages({query:'subject:Review'});assert.equal(new URL(url).searchParams.get('$search'),'"subject:Review"');assert.equal(page.count.provider_result_cap,1000);assert.equal(page.complete,false);assert.equal(page.coverage,'query');
});
test('Graph false hasAttachments leaves inline file inventory unknown',async()=>{
 const adapter=createMicrosoftAdapter(options('microsoft',async()=>json({value:[graphMessage()]})));const page=await adapter.listMessages();assert.equal(page.messages[0].files_status,'unknown');
});
test('Gmail and Graph lazy detail remains untrusted and bound to requested stable locator',async()=>{
 const gmail=await gmailMessage(fixture.messages[0]);gmail.payload.body={data:Buffer.from('<script>unsafe()</script>').toString('base64url')};const g=createGmailAdapter(options('gmail-personal',async()=>json(gmail))),detail=await g.readMessage({kind:'gmail',message_id:gmail.id});assert.equal(detail.body.untrusted,true);
 const graph={...graphMessage(),body:{contentType:'html',content:'<img src="https://tracking.example">'}},m=createMicrosoftAdapter(options('microsoft',async()=>json(graph))),read=await m.readMessage({kind:'microsoft',message_id:graph.id,id_type:'immutable'});assert.equal(read.body.untrusted,true);assert.equal(read.body.content,graph.body.content);await assert.rejects(m.readMessage({kind:'microsoft',message_id:graph.id}),error=>error.code==='EMAIL_PROVIDER_LOCATOR_INVALID');
});
test('Gmail sends exact digest-checked MIME once through durable reservation and preserves all recipient headers',async()=>{
 const input=outgoing(),calls=[],reservations=new Set();const adapter=createGmailAdapter(options('gmail-personal',async(url,init)=>{calls.push({url,init});return json({id:'accepted-gmail-message'});},{reserveSend:async request=>{if(reservations.has(request.operation_id))return false;reservations.add(request.operation_id);return true;}}));
 const result=await adapter.send(input);assert.equal(result.transport_outcome,'provider_accepted');assert.equal(result.delivery_status,'unknown');assert.equal(Buffer.from(JSON.parse(calls[0].init.body).raw,'base64url').compare(input.mime_bytes),0);await assert.rejects(adapter.send(input),error=>error.code==='EMAIL_PROVIDER_SEND_ALREADY_RESERVED');assert.equal(calls.length,1);
});
test('send rejects changed bytes, unverified/duplicate From, and absent durable reservation before effect',async()=>{
 const input=outgoing(),adapter=createGmailAdapter(options('gmail-personal',async()=>assert.fail('no effect allowed')));
 await assert.rejects(adapter.send({...input,mime_bytes:Buffer.from('changed')}),error=>error.code==='EMAIL_PROVIDER_MIME_CHANGED');await assert.rejects(adapter.send({...input,from_address:'intruder@example.test'}),error=>error.code==='EMAIL_PROVIDER_OUTGOING_INVALID');
 const bytes=Buffer.from('From: intruder@example.test\r\n'+input.mime_bytes.toString());await assert.rejects(adapter.send({...input,mime_bytes:bytes,mime_digest:createHash('sha256').update(bytes).digest('hex')}),error=>error.code==='EMAIL_PROVIDER_SENDER_DENIED');
 const noReservation=createGmailAdapter(options('gmail-personal',async()=>assert.fail('no reservation'),{reserveSend:undefined}));await assert.rejects(noReservation.send(input),error=>error.code==='EMAIL_PROVIDER_SEND_RESERVATION_REQUIRED');
 await assert.rejects(adapter.send({...input,account_id:'gmail-work'}),error=>error.code==='EMAIL_PROVIDER_ACCOUNT_MISMATCH');await assert.rejects(adapter.send({...input,transport_kind:'smtp_raw'}),error=>error.code==='EMAIL_PROVIDER_ACCOUNT_MISMATCH');
});
test('Graph 202 preserves MIME bytes and means acceptance with pending Sent copy and unknown delivery',async()=>{
 const input=outgoing('microsoft'),calls=[];const adapter=createMicrosoftAdapter(options('microsoft',async(url,init)=>{calls.push({url,init});return new Response(null,{status:202});}));const result=await adapter.send(input);assert.equal(calls[0].url,'https://graph.microsoft.com/v1.0/me/sendMail');assert.equal(Buffer.from(calls[0].init.body,'base64').compare(input.mime_bytes),0);assert.equal(result.transport_outcome,'provider_accepted');assert.equal(result.sent_copy_outcome,'pending');assert.equal(result.delivery_status,'unknown');
});
test('lost send acknowledgement is uncertain and adapters never retry',async()=>{
 let calls=0;const adapter=createMicrosoftAdapter(options('microsoft',async()=>{calls++;throw Error('lost socket with secret details');}));await assert.rejects(adapter.send(outgoing('microsoft')),error=>error.code==='EMAIL_PROVIDER_NETWORK_UNAVAILABLE'&&error.outcome==='uncertain'&&error.retryable===false);assert.equal(calls,1);
 const gmail=createGmailAdapter(options('gmail-personal',async()=>json({})));await assert.rejects(gmail.send(outgoing()),error=>error.code==='EMAIL_PROVIDER_SEND_RESULT_UNKNOWN'&&error.outcome==='uncertain');
});
test('IMAP locator reader uses existing bounded UIDVALIDITY/source helper and closes authenticated connection',async()=>{
 const row=fixture.messages.find(row=>row.account_id==='imap'),bytes=readFileSync(new URL(`../fixtures/launch-stage0/${row.source}`,import.meta.url)),calls=[],client={mailbox:{uidValidity:3001},list:async()=>[{path:'INBOX'},{path:'Archive',specialUse:'\\Archive'}],getMailboxLock:async()=>({release:()=>calls.push('release')}),fetchOne:async(uid,fields)=>{calls.push({uid,fields});return fields.size?{uid,size:bytes.length}:{uid,source:bytes};},logout:async()=>calls.push('logout')};
 const adapter=createImapAdapter({account:account('imap'),scope:{...fixture.scope,installation_id:'stage1-installation'},connect:async()=>client,assertAuthority:async()=>true});const result=await adapter.readMessage({resource_id:row.locator.resource_id,locator:{kind:'imap_smtp',mailbox:'INBOX',uidvalidity:'3001',uid:1}});assert.equal(result.reply_evidence.message_id,row.message_id);assert.equal(result.body.available,false);assert.ok(calls.some(call=>call.fields?.source?.maxLength===bytes.length+1));assert.equal(calls.at(-1),'logout');await assert.rejects(adapter.send(outgoing('imap')),error=>error.code==='EMAIL_PROVIDER_OPERATION_UNSUPPORTED');
});
test('dot path IDs cannot escape the selected provider message/folder collection',async()=>{
 const g=createGmailAdapter(options('gmail-personal',async()=>assert.fail('invalid native ID must not fetch'))),m=createMicrosoftAdapter(options('microsoft',async()=>assert.fail('invalid folder must not fetch')));
 await assert.rejects(g.readMessage({kind:'gmail',message_id:'..'}),error=>error.code==='EMAIL_PROVIDER_INPUT_INVALID');await assert.rejects(m.listMessages({folder_id:'..'}),error=>error.code==='EMAIL_PROVIDER_INPUT_INVALID');
});
test('IMAP sync-window listing scopes checkpoints, reads bounded source and commits before resumable next folder',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'deft-stage1-imap-')),inventory=join(directory,'inventory.sqlite'),row=fixture.messages.find(row=>row.account_id==='imap'),source=readFileSync(new URL(`../fixtures/launch-stage0/${row.source}`,import.meta.url)),calls=[];
 const client={mailbox:{uidValidity:3001,uidNext:2},list:async()=>[{path:'INBOX'},{path:'Sent',specialUse:'\\Sent'},{path:'Archive',specialUse:'\\Archive'}],getMailboxLock:async path=>{calls.push(path);return {release:()=>{}};},fetch:async function*(range,fields,options){calls.push({range,fields,options});yield {uid:1,size:source.length,flags:new Set(),internalDate:new Date('2026-09-30T10:00:00Z'),envelope:{subject:'Review',messageId:row.message_id},bodyStructure:{type:'text/plain'}};},fetchOne:async(uid,fields)=>{calls.push({uid,fields});return {uid,source};},logout:async()=>{}};
 const adapter=createImapAdapter({account:account('imap'),scope:{...fixture.scope,installation_id:'stage1-installation'},connect:async()=>client,assertAuthority:async()=>true});let page;
 try{page=await adapter.listMessages({limit:1,inventory_path:inventory});assert.equal(page.messages.length,1);assert.equal(page.messages[0].locator.uidvalidity,'3001');assert.equal(page.complete,false);assert.equal(page.coverage,'sync_window');assert.ok(calls.some(call=>call.range==='1:1'&&call.options.uid===true));await page.commit();const next=await adapter.listMessages({limit:1,cursor:page.checkpoint_cursor,inventory_path:inventory});assert.equal(next.messages[0].locator.mailbox,'Sent');next.close();}finally{page?.close();for(const path of [inventory,inventory+'-journal',inventory+'-wal',inventory+'-shm'])if(existsSync(path))unlinkSync(path);rmdirSync(directory);}
});

test('Gmail metadata reads use bounded concurrency while preserving page order and shared limits',async()=>{
 const base=await gmailMessage(fixture.messages[0]),rows=Array.from({length:11},(_,i)=>({...base,id:'bounded-'+i}));let active=0,peak=0,calls=0;
 const adapter=createGmailAdapter(options('gmail-personal',async url=>{const target=new URL(url);calls++;if(target.pathname.endsWith('/messages'))return json({messages:rows.map(row=>({id:row.id}))});active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return json(rows.find(row=>target.pathname.endsWith('/'+row.id)));}));
 const page=await adapter.listMessages({limit:11});assert.equal(peak,10);assert.equal(active,0);assert.equal(calls,12);assert.deepEqual(page.messages.map(row=>row.locator.message_id),rows.map(row=>row.id));
});

test('Gmail bounded metadata drains started reads and never launches later batches after revocation',async()=>{
 const base=await gmailMessage(fixture.messages[0]);let allowed=true,calls=0,active=0;
 const adapter=createGmailAdapter(options('gmail-personal',async url=>{calls++;if(new URL(url).pathname.endsWith('/messages'))return json({messages:Array.from({length:11},(_,i)=>({id:'revoked-'+i}))});active++;await new Promise(resolve=>setTimeout(resolve,5));active--;allowed=false;return json({...base,id:new URL(url).pathname.split('/').at(-1)});},{assertAuthority:async()=>allowed}));
 await assert.rejects(adapter.listMessages({limit:11}),error=>error.code==='EMAIL_ACCOUNT_REVOKED');assert.equal(active,0);assert.equal(calls,11);
});

test('Gmail parallel metadata enforces one shared byte ceiling and stops subsequent batches',async()=>{
 const base=await gmailMessage(fixture.messages[0]);let calls=0;
 const adapter=createGmailAdapter(options('gmail-personal',async url=>{calls++;const path=new URL(url).pathname;if(path.endsWith('/messages'))return json({messages:Array.from({length:11},(_,i)=>({id:'large-'+i}))});return json({...base,id:path.split('/').at(-1),padding:' '.repeat(600000)});}));
 await assert.rejects(adapter.listMessages({limit:11}),error=>error.code==='EMAIL_PROVIDER_RESPONSE_LIMIT');assert.equal(calls,11);
});

test('Gmail ten-wide rate limit drains its started window without retry or later reads',async()=>{
 const base=await gmailMessage(fixture.messages[0]);let calls=0,active=0;
 const adapter=createGmailAdapter(options('gmail-personal',async url=>{calls++;const id=new URL(url).pathname.split('/').at(-1);if(id==='messages')return json({messages:Array.from({length:11},(_,i)=>({id:'limited-'+i}))});active++;await new Promise(resolve=>setTimeout(resolve,5));active--;return id==='limited-0'?json({},429):json({...base,id});}));
 await assert.rejects(adapter.listMessages({limit:11}),error=>error.code==='EMAIL_PROVIDER_RATE_LIMITED');assert.equal(active,0);assert.equal(calls,11);
});
