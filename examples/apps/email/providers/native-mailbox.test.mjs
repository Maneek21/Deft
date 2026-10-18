import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAppConnectionAdapter} from './connection-http.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createOAuthProvider} from './oauth-provider.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {providerSourceForParent} from './provider-browser.mjs';

const mime=Buffer.from('From: synthetic@example.test\r\nTo: owner@example.test\r\nSubject: native MIME fixture\r\nContent-Type: text/plain\r\n\r\nExact original bytes\r\n');
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const barrier=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
test('actual Gmail and Graph explicit native profile reads33/200 full seeds and retains201 body with unavailable seed',async()=>{
 for(const provider of ['gmail','microsoft'])for(const count of [33,200,201]){
  const to=Array.from({length:count},(_,n)=>`Person ${n} <p${n}@example.test>`).join(', '),bytes=Buffer.from(`From: sender@example.test\r\nTo: ${to}\r\nMessage-ID: <parent@example.test>\r\nContent-Type: text/plain\r\n\r\nFull native body.`);
  const f=await fixture(provider);f.handler=()=>provider==='gmail'?json({id:'message',threadId:'thread',raw:bytes.toString('base64url')}):new Response(bytes,{headers:{'content-type':'message/rfc822'}});
  const value=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.equal(value.presentation.content,'Full native body.');
  if(count<=200){assert.equal(value.reply_seed_unavailable,undefined);assert.equal(value.presentation.metadata.reply_to_list.split('@example.test').length-1,count);assert.match(value.presentation.metadata.reply_to_list,new RegExp(`Person ${count-1}`));}
  else{assert.deepEqual(value.reply_seed_unavailable,['reply_to_list']);assert.equal(value.presentation.metadata.reply_to_list,'');assert.ok(value.presentation.headers.some(row=>row.label==='To'));}
  const original=await f.adapter.nativeEmailSource({source:f.source},f.context);assert.deepEqual(Buffer.from(original.mime_bytes),bytes);original.mime_bytes.fill(0);
  f.deny();await assert.rejects(f.adapter.nativeEmailPresentation({source:f.source},f.context));
 }
});
test('actual registered Gmail/Graph native calendar parts use receiving account identity and ordinary read authority',async()=>{
 const bytes=Buffer.from('MIME-Version: 1.0\r\nContent-Type: text/calendar; charset=utf-8; method=REQUEST\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n');
 for(const provider of ['gmail','microsoft']){const f=await fixture(provider);f.handler=()=>provider==='gmail'?json({id:'message',threadId:'thread',raw:bytes.toString('base64url')}):new Response(bytes,{headers:{'content-type':'message/rfc822'}});
  const value=await f.adapter.nativeEmailCalendarParts({source:f.source},f.context);assert.equal(value.schema_version,'deft.email_calendar_parts.v1');assert.equal(value.account_id,f.binding.account_id);assert.equal(value.logical_message_id,f.source.logical_message_id);assert.equal(value.source_digest,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(value.receiving_identity.primary_address,'owner@example.test');assert.equal(value.parts[0].media_type_method,'REQUEST');assert.equal(f.calls.length,1);
  await assert.rejects(f.adapter.nativeEmailCalendarParts({source:{...f.source,account_id:'other'}},f.context));assert.equal(f.calls.length,1);
 }
 const f=await fixture();f.handler=()=>json({id:'message',threadId:'thread',raw:bytes.toString('base64url')});const entered=barrier(),held=barrier();f.hold=async()=>{entered.release();await held.promise;};const pending=f.adapter.nativeEmailCalendarParts({source:f.source},f.context);await entered.promise;f.deny();held.release();await assert.rejects(pending);
});
test('native Gmail sync, search and folder catalog share opaque custom label membership IDs',async()=>{
 const f=await fixture();f.handler=href=>{
  const url=new URL(href);
  if(url.pathname.endsWith('/labels'))return json({labels:[{id:'INBOX',name:'Inbox',type:'system'},{id:'private-custom-label',name:'Projects',type:'user'}]});
  if(url.pathname.endsWith('/messages'))return json({messages:[{id:'message'}]});
  return json({id:'message',threadId:'thread',labelIds:['INBOX','private-custom-label'],internalDate:Date.parse('2026-10-04T12:00:00Z'),payload:{headers:[]}});
 };
 const expected='label:'+createHash('sha256').update(JSON.stringify({kind:'gmail_label_membership_v1',id:'private-custom-label'})).digest('hex');
 const sync=await f.adapter.nativeEmailPage({cursor:null,limit:10},f.context),search=await f.adapter.nativeEmailSearch({query:'known',cursor:null,limit:10},f.context),catalog=await f.adapter.nativeEmailFolders({cursor:null,limit:10},f.context);
 assert.deepEqual(sync.items[0].folders,['inbox',expected]);assert.deepEqual(search.items[0].folders,['inbox',expected]);assert.deepEqual(catalog.items.map(row=>row.folder_id),['inbox',expected]);
 assert.equal(sync.items[0].folders.some(value=>value.includes('private-custom-label')),false);
});
async function fixture(provider='gmail',imageDependencies,capabilities=['read']){
 const scope={org_id:'org',owner_id:'owner',installation_id:'installation'},binding={scope,account_id:'native-source-account',provider,connection_target:'trusted-deployment-target',resource_binding_id:'binding',action_binding_id:capabilities.length>1?'action-binding':null,authority_epoch:1,capabilities};
 const storeRows=new Map(),queues=new Map();
 const store={async withLock({key},work){const prior=queues.get(key)??Promise.resolve();let release;const queued=new Promise(resolve=>{release=resolve;});queues.set(key,queued);await prior;
  try{return await work({async read(){return structuredClone(storeRows.get(key)??null);},async compareAndSwap({expected_revision,value}){const row=storeRows.get(key);if((row?.revision??null)!==expected_revision)return false;storeRows.set(key,{revision:(row?.revision??0)+1,value:structuredClone(value)});return true;}});}finally{release();if(queues.get(key)===queued)queues.delete(key);}}};
 const custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(45),key_id:'native-source-test',store});
 const client={client_id:'client',client_secret:'synthetic-client-secret',redirect_uri:'https://fixture.invalid/apps/connections/callback',...(provider==='microsoft'?{tenant:'common'}:{})};
 let held=async()=>{},allowed=true,rawReturned=false,postRawChecks=0,lateDeny=false,handler=null,checks=0,failCheck=0;
 const calls=[];
 const fetch=async(url,init)=>{calls.push({url,init});await held();assert.equal(init.method,'GET');assert.ok(init.headers.Authorization.startsWith('Bearer '));rawReturned=true;
  if(handler)return handler(url,init);return provider==='gmail'?json({id:'message',threadId:'thread',raw:mime.toString('base64url')}):new Response(mime,{headers:{'content-type':'message/rfc822'}});};
 await custody.withAccount(binding,async tx=>tx.write({health:'connected',secret:{access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',expires_at:Date.now()+3600000,
  scopes:provider==='gmail'?['openid','email','https://www.googleapis.com/auth/gmail.readonly',...(capabilities.includes('modify')?['https://www.googleapis.com/auth/gmail.modify']:[]),...(capabilities.includes('send')?['https://www.googleapis.com/auth/gmail.send']:[])]:['offline_access','User.Read','Mail.Read',...(capabilities.includes('modify')?['Mail.ReadWrite']:[]),...(capabilities.includes('send')?['Mail.Send']:[])],client_fingerprint:createOAuthProvider({provider,client,fetch,now:Date.now}).client_fingerprint,
  identity:{provider_subject:'private-verified-principal',primary_address:'owner@example.test',display_label:'Native source fixture',verified_sender_identities:['owner@example.test','reply@example.test']}}}));
 const {scope:_private,...options}=binding;
 const adapter=await createAppConnectionAdapter({options:{...options,origin:'https://fixture.invalid',clients:{[provider]:client}},custody,fetch,imageDependencies,host:{resolveContext:async()=>assert.fail('No Experience projection'),assertCurrent:async()=>assert.fail('No Experience authority')}});
 const context={org_id:'org',owner_user_id:'owner',installation_id:'installation',account_id:binding.account_id,resource_binding_id:'binding',authority_version:'native-current',expires_at:Date.now()+60000,
  recheck:async()=>{checks++;if(rawReturned)postRawChecks++;if(!allowed||lateDeny&&postRawChecks===3||checks===failCheck)throw Error('Synthetic revoked');}};
 const account={...options,health:'connected',primary_address:'owner@example.test',display_label:'Native source fixture',verified_sender_identities:[]};
 const locator=provider==='gmail'?{kind:'gmail',message_id:'message',thread_id:'thread',label_ids:['INBOX']}:{kind:'microsoft',message_id:'message',conversation_id:'conversation',folder_id:'inbox',id_type:'immutable'};
 const parent=new LogicalMailIndex(scope).upsert(scope,{account_id:binding.account_id,provider,locator});
 const source=providerSourceForParent(account,parent);
 return {adapter,context,source,calls,custody,binding,storeRows,get checks(){return checks;},failCheckAt(value){failCheck=value;},set hold(value){held=value;},set handler(value){handler=value;},deny(){allowed=false;},lateDeny(){lateDeny=true;},
  async change(kind){await custody.withAccount(binding,async tx=>{const row=tx.read();await tx.write({health:kind==='revoke'?'revoked':'connected',secret:{...row.secret,...(kind==='revoke'?{access_token:'discarded',refresh_token:'discarded',expires_at:0}:{}),...(kind==='principal'?{identity:{...row.secret.identity,provider_subject:'another-private-principal'}}:{})},advance_setup:true});});}};
}
test('actual Gmail/Graph native presentations preserve body with explicit attachment overflow and plain HTML fallback',async()=>{
 const parts=Array.from({length:33},(_,n)=>`--limit\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="${n}.txt"\r\n\r\nx\r\n`).join('');
 const bytes=Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=limit\r\n\r\n--limit\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<table><tr>'+'<td>cell</td>'.repeat(5000)+'</tr></table>\r\n'+parts+'--limit--\r\n');
 for(const provider of ['gmail','microsoft']){
  const f=await fixture(provider);f.handler=()=>provider==='gmail'?json({id:'message',threadId:'thread',raw:bytes.toString('base64url')}):new Response(bytes,{headers:{'content-type':'message/rfc822'}});
  const value=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.equal(value.files.length,32);assert.equal(value.omitted_file_count,1);assert.equal(value.presentation.rendering_fallback,'plain_text');assert.equal(value.presentation.format,'plain');assert.match(value.presentation.content,/cell/);
  const source=await f.adapter.nativeEmailSource({source:f.source},f.context);assert.deepEqual(Buffer.from(source.mime_bytes),bytes);source.mime_bytes.fill(0);
  f.deny();await assert.rejects(f.adapter.nativeEmailPresentation({source:f.source},f.context));
 }
});
test('actual native Gmail/Graph incoming >8MiB original, body and file remain exact under the explicit native profile',async()=>{
 const bytes=Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nMessage-ID: <native-size@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=size\r\n\r\n--size\r\nContent-Type: text/plain\r\n\r\nLARGE_BODY_PRESERVED\r\n--size\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="business.bin"\r\nContent-Transfer-Encoding: binary\r\n\r\n'+'A'.repeat(9*1024*1024)+'\r\n--size--\r\n');
 const hash=value=>createHash('sha256').update(value).digest('hex');
 try{for(const provider of ['gmail','microsoft']){
  const f=await fixture(provider);f.handler=()=>provider==='gmail'?json({id:'message',threadId:'thread',raw:bytes.toString('base64url')}):new Response(bytes,{headers:{'content-type':'message/rfc822'}});
  const view=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.match(view.presentation.plain_text,/LARGE_BODY_PRESERVED/);assert.equal(view.files[0].size_bytes,9*1024*1024);assert.equal(view.source_digest,hash(bytes));
  const original=await f.adapter.nativeEmailSource({source:f.source},f.context);try{assert.equal(hash(original.mime_bytes),hash(bytes));}finally{original.mime_bytes.fill(0);}
  const file=await f.adapter.nativeEmailFile({source:f.source,source_digest:view.source_digest,file_ref:view.files[0].file_ref},f.context);try{assert.equal(file.byte_length,9*1024*1024);assert.ok(file.bytes.every(value=>value===0x41));}finally{file.bytes.fill(0);}
  f.deny();await assert.rejects(f.adapter.nativeEmailPresentation({source:f.source},f.context));
 }}finally{bytes.fill(0);}
});

const threadGmail=(id,labels=['INBOX'],day=1)=>({id,threadId:'thread',labelIds:labels,historyId:'1',internalDate:String(Date.parse(`2026-10-0${day}T12:00:00Z`)),payload:{headers:[{name:'Subject',value:'Native conversation'}]}});
const threadGraph=(id,folder='inbox')=>({id,conversationId:'conversation',parentFolderId:folder,subject:'Native conversation',receivedDateTime:'2026-10-04T12:00:00Z',isRead:false,hasAttachments:false});
test('registered native Gmail conversation uses ordinary read custody and traverses Inbox/Sent/Archive in three bounded pages',async()=>{
 const f=await fixture(),rows=[threadGmail('message',['INBOX'],1),threadGmail('sent',['SENT'],2),threadGmail('archive',[],3)];
 f.handler=href=>{assert.equal(new URL(href).pathname,'/gmail/v1/users/me/threads/thread');return json({id:'thread',messages:rows});};
 const pages=[];let cursor=null;for(let n=0;n<3;n++){const page=await f.adapter.nativeEmailConversation({source:f.source,cursor,limit:1},f.context);pages.push(page);cursor=page.next_cursor;}
 assert.deepEqual(pages.flatMap(page=>page.items.map(row=>row.provider_source.locator.message_id)),['message','sent','archive']);
 assert.deepEqual(pages.flatMap(page=>page.items.map(row=>row.folders)),[['inbox'],['sent'],['archive']]);
 assert.deepEqual(pages.map(page=>page.complete),[false,false,true]);assert.equal(cursor,null);assert.equal(f.calls.length,3);
 assert.ok(pages.every(page=>page.anchor_logical_message_id===f.source.logical_message_id));
 assert.equal(new Set(pages.flatMap(page=>page.items.map(row=>row.logical_message_id))).size,3);
});
test('registered native Graph conversation verifies immutable anchor and follows exact account-wide paging outside Inbox',async()=>{
 const f=await fixture('microsoft'),next='https://graph.microsoft.com/v1.0/me/messages?$skip=37&$top=1';let collections=0;
 f.handler=(href,init)=>{const url=new URL(href);assert.equal(init.headers.Prefer,'IdType="ImmutableId"');
  if(url.pathname.endsWith('/messages/message'))return json({id:'message',conversationId:'conversation'});
  assert.equal(url.pathname,'/v1.0/me/messages');collections++;
  if(collections===1){assert.equal(url.searchParams.get('$filter'),"conversationId eq 'conversation'");return json({value:[threadGraph('message')],'@odata.nextLink':next});}
  assert.equal(href,next);return json({value:[threadGraph('sent','private-sent-folder')]});};
 const one=await f.adapter.nativeEmailConversation({source:f.source,cursor:null,limit:1},f.context),two=await f.adapter.nativeEmailConversation({source:f.source,cursor:one.next_cursor,limit:1},f.context);
 assert.deepEqual([...one.items,...two.items].map(row=>row.provider_source.locator.message_id),['message','sent']);assert.equal(two.complete,true);assert.equal(f.calls.length,4);
 assert.match(two.items[0].folders[0],/^folder:[a-f0-9]{64}$/);assert.equal(two.items[0].provider_source.locator.id_type,'immutable');
});
test('native conversation rejects source nomination, stale anchors, changed Gmail thread and foreign Graph messages',async()=>{
 const f=await fixture();for(const source of [{...f.source,account_id:'other'},{...f.source,logical_message_id:'mail_'+'f'.repeat(64)}])await assert.rejects(f.adapter.nativeEmailConversation({source,cursor:null,limit:1},f.context));
 await assert.rejects(f.adapter.nativeEmailConversation({source:f.source,cursor:null,limit:1,thread_id:'browser-thread'},f.context));assert.equal(f.calls.length,0);
 f.handler=()=>json({id:'thread',messages:[threadGmail('other')]});await assert.rejects(f.adapter.nativeEmailConversation({source:f.source,cursor:null,limit:1},f.context),/SOURCE_STALE/);
 let revision='1';f.handler=()=>json({id:'thread',messages:[threadGmail('message'),threadGmail('sent')].map(row=>({...row,historyId:revision}))});
 const first=await f.adapter.nativeEmailConversation({source:f.source,cursor:null,limit:1},f.context);revision='2';await assert.rejects(f.adapter.nativeEmailConversation({source:f.source,cursor:first.next_cursor,limit:1},f.context),/CURSOR_EXPIRED/);
 const graph=await fixture('microsoft');graph.handler=href=>new URL(href).pathname.endsWith('/message')?json({id:'message',conversationId:'conversation'}):json({value:[{...threadGraph('foreign'),conversationId:'other'}]});
 await assert.rejects(graph.adapter.nativeEmailConversation({source:graph.source,cursor:null,limit:1},graph.context),/RESPONSE_INVALID/);
 graph.handler=()=>json({id:'wrong',conversationId:'conversation'});await assert.rejects(graph.adapter.nativeEmailConversation({source:graph.source,cursor:null,limit:1},graph.context),/SOURCE_STALE/);
});
test('held credential disconnect and authority revocation deny native conversation metadata; malformed thread rows remain partial',async()=>{
 for(const kind of ['revoke','principal','revision']){const f=await fixture(),entered=barrier(),held=barrier();f.handler=()=>json({id:'thread',messages:[threadGmail('message')]});
  f.hold=async()=>{entered.release();await held.promise;};const read=f.adapter.nativeEmailConversation({source:f.source,cursor:null,limit:1},f.context);await entered.promise;await f.change(kind);held.release();await assert.rejects(read);}
 const f=await fixture();f.handler=()=>json({id:'thread',messages:[threadGmail('message'),{...threadGmail('broken'),threadId:'wrong'}]});
 const page=await f.adapter.nativeEmailConversation({source:f.source,cursor:null,limit:10},f.context);assert.equal(page.items.length,1);assert.equal(page.failure_count,1);assert.equal(page.complete,false);
});

test('actual registered factory native source reads exact Gmail/Graph MIME under native authority without Experience',async()=>{
 for(const provider of ['gmail','microsoft']){
  const f=await fixture(provider),result=await f.adapter.nativeEmailSource({source:f.source},f.context);
  assert.equal(result.schema_version,'deft.email_source.v1');assert.equal(result.account_id,f.binding.account_id);assert.equal(result.provider,provider);assert.equal(result.source_kind,'provider_original');
  assert.deepEqual(Buffer.from(result.mime_bytes),mime);assert.equal(result.byte_length,mime.length);assert.equal(result.digest,createHash('sha256').update(mime).digest('hex'));assert.equal(result.media_type,'message/rfc822');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.redirect,'error');
  assert.equal(f.calls[0].url,provider==='gmail'?'https://www.googleapis.com/gmail/v1/users/me/messages/message?format=raw':'https://graph.microsoft.com/v1.0/me/messages/message/$value');
  if(provider==='microsoft')assert.equal(f.calls[0].init.headers.Prefer,'IdType="ImmutableId"');
 }
});
test('cached source account/scope/logical/thread/epoch/immutable identity failures deny before provider I/O',async()=>{
 const f=await fixture();
 for(const source of [{...f.source,account_id:'another'},{...f.source,logical_message_id:'mail_'+'f'.repeat(64)},{...f.source,authority_epoch:2},{...f.source,locator:{...f.source.locator,thread_id:'wrong'}},{...f.source,url:'https://attacker.invalid'}])await assert.rejects(f.adapter.nativeEmailSource({source},f.context));
 for(const changed of [{owner_user_id:'other'},{org_id:'another'},{installation_id:'fabricated'},{account_id:'other'},{resource_binding_id:'other'}])await assert.rejects(f.adapter.nativeEmailSource({source:f.source},{...f.context,...changed}));
 await assert.rejects(f.adapter.nativeEmailSource({source:f.source,projection:{}},f.context));assert.equal(f.calls.length,0);
 const graph=await fixture('microsoft');await assert.rejects(graph.adapter.nativeEmailSource({source:{...graph.source,locator:{...graph.source.locator,id_type:'mutable'}}},graph.context));assert.equal(graph.calls.length,0);
});
test('native Gmail rejects missing or mismatched provider-returned thread and message IDs',async()=>{
 for(const data of [{id:'message',raw:mime.toString('base64url')},{id:'message',threadId:'wrong',raw:mime.toString('base64url')},{id:'wrong',threadId:'thread',raw:mime.toString('base64url')}]){
  const f=await fixture();f.handler=()=>json(data);await assert.rejects(f.adapter.nativeEmailSource({source:f.source},f.context),/EMAIL_SOURCE_RESPONSE_INVALID/);
 }
});
test('held disconnect, principal replacement and credential revision changes reject MIME output',async()=>{
 for(const kind of ['revoke','principal','revision']){
  const f=await fixture(),entered=barrier(),held=barrier();f.hold=async()=>{entered.release();await held.promise;};
  const reading=f.adapter.nativeEmailSource({source:f.source},f.context);await entered.promise;await f.change(kind);held.release();await assert.rejects(reading);assert.equal(f.calls.length,1);
 }
});
test('late native authority failure clears the returned MIME byte array before rejection',async()=>{
 const f=await fixture();f.lateDeny();const original=Uint8Array.prototype.fill;let cleared=null;
 Uint8Array.prototype.fill=function(value,...args){if(value===0&&this.byteLength===mime.byteLength&&Buffer.from(this).equals(mime))cleared=this;return original.call(this,value,...args);};
 try{await assert.rejects(f.adapter.nativeEmailSource({source:f.source},f.context));assert.ok(cleared);assert.ok([...cleared].every(byte=>byte===0));}finally{Uint8Array.prototype.fill=original;}
});
test('abort, deadline and byte limits remain enforced on the native source path with stream cancellation',async()=>{
 const aborted=await fixture(),controller=new AbortController();controller.abort();await assert.rejects(aborted.adapter.nativeEmailSource({source:aborted.source},{...aborted.context,signal:controller.signal}));assert.equal(aborted.calls.length,0);
 const expired=await fixture();await assert.rejects(expired.adapter.nativeEmailSource({source:expired.source},{...expired.context,expires_at:Date.now()-1}));assert.equal(expired.calls.length,0);
 const graph=await fixture('microsoft');let canceled=false;graph.handler=()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(35*1024*1024+1));},cancel(){canceled=true;}}),{headers:{'content-type':'message/rfc822'}});
 await assert.rejects(graph.adapter.nativeEmailSource({source:graph.source},graph.context),/EMAIL_PROVIDER_RESPONSE_LIMIT/);assert.equal(canceled,true);
 const held=await fixture('microsoft'),abort=new AbortController();let cancel=false;const entered=barrier();held.handler=()=>new Response(new ReadableStream({start(){entered.release();},cancel(){cancel=true;}}),{headers:{'content-type':'message/rfc822'}});
 const reading=held.adapter.nativeEmailSource({source:held.source},{...held.context,signal:abort.signal});await entered.promise;abort.abort();await assert.rejects(reading);assert.equal(cancel,true);
});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const part=(name,type,bytes,extra='')=>`--native-bound\r\nContent-Type: ${type}\r\nContent-Disposition: attachment; filename="${name}"\r\n${extra}Content-Transfer-Encoding: base64\r\n\r\n${bytes.toString('base64')}\r\n`;
const presentationMime=(html='<p>Native body</p><img src="cid:logo"><img src="https://images.example.test/photo"><script>untrusted()</script>',parts=[part('../report.txt','text/plain',Buffer.from('Exact attachment')),part('logo.png','image/png',png,'Content-ID: <logo>\r\n')])=>Buffer.from('From: Sender <sender@example.test>\r\nTo: owner@example.test\r\nCc: copy@example.test\r\nReply-To: replies@example.test\r\nSubject: Native résumé\r\nMessage-ID: <fixture@example.test>\r\nReferences: <prior@example.test>\r\nDate: Thu, 01 Oct 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=native-bound\r\n\r\n--native-bound\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'+html+'\r\n'+parts.join('')+'--native-bound--\r\n');
function useMime(f,bytes){f.handler=()=>f.binding.provider==='gmail'?json({id:'message',threadId:'thread',raw:bytes.toString('base64url')}):new Response(bytes,{headers:{'content-type':'message/rfc822'}});}

test('native presentation combines source-bound files, headers and verified reply metadata in one provider fetch',async()=>{
 for(const provider of ['gmail','microsoft']){
  let remoteCalls=0;const f=await fixture(provider,{lookup:async()=>{remoteCalls++;assert.fail('Presentation must not resolve remote images');}}),bytes=presentationMime();useMime(f,bytes);
  const result=await f.adapter.nativeEmailPresentation({source:f.source},f.context);
  assert.equal(result.schema_version,'deft.email_presentation.v1');assert.equal(result.content_trust,'unsanitized');assert.equal(result.account_id,f.binding.account_id);assert.equal(result.logical_message_id,f.source.logical_message_id);
  assert.equal(result.source_digest,createHash('sha256').update(bytes).digest('hex'));assert.equal(f.calls.length,1);assert.equal(remoteCalls,0);
  assert.equal(result.files[0].filename,'.._report.txt');assert.equal(result.files[0].preview,'text');assert.equal(result.files[1].preview,'image');
  assert.deepEqual(result.presentation.images.map(row=>row.kind),['cid','remote']);assert.ok(result.presentation.content.includes('<script>untrusted()</script>'),'HTML remains untrusted data for the renderer sanitizer');
  assert.ok(!result.presentation.content.includes('https://images.example.test'));assert.ok(result.presentation.content.includes('deft-image:'));
  assert.equal(result.presentation.format,'html');assert.equal(result.presentation.metadata.primary_address,'owner@example.test');
  assert.deepEqual(JSON.parse(result.presentation.metadata.verified_sender_identities),['owner@example.test','reply@example.test']);
  assert.equal(result.presentation.metadata.reply_to,'replies@example.test');assert.equal(result.presentation.metadata.reply_cc,'copy@example.test');assert.equal(result.presentation.metadata.message_id,'<fixture@example.test>');
  assert.deepEqual(result.presentation.headers.map(row=>row.label),['From','To','Cc','Reply-To','Date','Subject']);
  assert.equal(result.presentation.metadata.conversation_coverage_state,'unknown');
 }
});
test('native file and CID reads bind exact MIME digest and opaque references without a caller URL',async()=>{
 const f=await fixture(),bytes=presentationMime();useMime(f,bytes);const p=await f.adapter.nativeEmailPresentation({source:f.source},f.context);
 const selected={source:f.source,source_digest:p.source_digest};
 const file=await f.adapter.nativeEmailFile({...selected,file_ref:p.files[0].file_ref},f.context);
 assert.equal(file.schema_version,'deft.email_file.v1');assert.equal(file.filename,'.._report.txt');assert.equal(file.media_type,'text/plain');assert.equal(file.byte_length,16);assert.equal(Buffer.from(file.bytes).toString(),'Exact attachment');
 const image=await f.adapter.nativeEmailImage({...selected,image_ref:p.presentation.images[0].image_ref},f.context);
 assert.equal(image.schema_version,'deft.email_image.v1');assert.equal(image.media_type,'image/png');assert.deepEqual(Buffer.from(image.bytes),png);assert.equal(f.calls.length,3,'Exactly one source fetch per operation');
 const before=f.calls.length;
 for(const input of [{...selected,file_ref:p.files[0].file_ref,url:'https://attacker.invalid'},{...selected,file_ref:'x'},{source:f.source,file_ref:p.files[0].file_ref}])await assert.rejects(f.adapter.nativeEmailFile(input,f.context));
 assert.equal(f.calls.length,before);
 await assert.rejects(f.adapter.nativeEmailFile({...selected,file_ref:'f'.repeat(64)},f.context));
 useMime(f,presentationMime('<p>Changed MIME</p>'));await assert.rejects(f.adapter.nativeEmailFile({...selected,file_ref:p.files[0].file_ref},f.context),/EMAIL_NATIVE_SOURCE_INVALID/);
 file.bytes.fill(0);image.bytes.fill(0);
});
test('native remote image uses only source nomination and pinned public-address proxy with late checks',async()=>{
 let requests=0,host='',url='';const remote=png.slice(),f=await fixture('gmail',{lookup:async value=>{host=value;return [{address:'8.8.8.8',family:4}];},request:async(value,pinned,signal)=>{requests++;url=value.href;assert.equal(pinned.address,'8.8.8.8');assert.equal(signal.aborted,false);return {media_type:'image/png',bytes:remote};}});
 const bytes=presentationMime();useMime(f,bytes);const p=await f.adapter.nativeEmailPresentation({source:f.source},f.context),input={source:f.source,source_digest:p.source_digest,image_ref:p.presentation.images[1].image_ref};
 const image=await f.adapter.nativeEmailImage(input,f.context);assert.equal(host,'images.example.test');assert.equal(url,'https://images.example.test/photo');assert.equal(requests,1);assert.deepEqual(Buffer.from(image.bytes),png);assert.equal(f.calls.length,2);
 await assert.rejects(f.adapter.nativeEmailImage({...input,source_digest:'f'.repeat(64)},f.context));await assert.rejects(f.adapter.nativeEmailImage({...input,image_ref:'e'.repeat(64)},f.context));assert.equal(requests,1,'Wrong digest or nomination cannot fetch a remote URL');
 const privateF=await fixture('gmail',{lookup:async()=>[{address:'127.0.0.1',family:4}],request:async()=>assert.fail('Private image request denied')});useMime(privateF,bytes);
 await assert.rejects(privateF.adapter.nativeEmailImage({...input,source:privateF.source},privateF.context),/APP_IMAGE_UNAVAILABLE/);
 const revoked=await fixture('gmail',{lookup:async()=>[{address:'8.8.8.8',family:4}],request:async()=>{revoked.deny();return {media_type:'image/png',bytes:remote};}});useMime(revoked,bytes);
 await assert.rejects(revoked.adapter.nativeEmailImage({...input,source:revoked.source},revoked.context));assert.ok([...remote].every(byte=>byte===0));
});
test('native presentation/file/image reject wrong scope and held custody changes; final file denial clears bytes',async()=>{
 const f=await fixture();useMime(f,presentationMime());const p=await f.adapter.nativeEmailPresentation({source:f.source},f.context);
 const operations=[['nativeEmailPresentation',{source:f.source}],['nativeEmailFile',{source:f.source,source_digest:p.source_digest,file_ref:p.files[0].file_ref}],['nativeEmailImage',{source:f.source,source_digest:p.source_digest,image_ref:p.presentation.images[0].image_ref}]];
 for(const [method,input] of operations){
  const bad=await fixture();await assert.rejects(bad.adapter[method](input,{...bad.context,owner_user_id:'other'}));assert.equal(bad.calls.length,0);
  const held=await fixture(),entered=barrier(),blocked=barrier();useMime(held,presentationMime());held.hold=async()=>{entered.release();await blocked.promise;};
  const pending=held.adapter[method](input,held.context);await entered.promise;await held.change('principal');blocked.release();await assert.rejects(pending);
 }
 const successful=await fixture();useMime(successful,presentationMime());await successful.adapter.nativeEmailFile(operations[1][1],successful.context);const finalCheck=successful.checks;
 const late=await fixture();useMime(late,presentationMime());late.failCheckAt(finalCheck);const original=Uint8Array.prototype.fill;let cleared;
 Uint8Array.prototype.fill=function(value,...args){if(value===0&&Buffer.from(this).toString()==='Exact attachment')cleared=this;return original.call(this,value,...args);};
 try{await assert.rejects(late.adapter.nativeEmailFile(operations[1][1],late.context));assert.ok(cleared);assert.ok([...cleared].every(byte=>byte===0));}finally{Uint8Array.prototype.fill=original;}
});
test('native presentation retains truncation and MIME limits and observes aborted/expired account context',async()=>{
 const f=await fixture();useMime(f,presentationMime('<p>'+ 'é'.repeat(180000)+'</p>',[]));const p=await f.adapter.nativeEmailPresentation({source:f.source},f.context);
 assert.equal(p.presentation.truncated,true);assert.ok(Buffer.byteLength(p.presentation.content)<=262144);
 useMime(f,presentationMime('<p>Many files</p>',Array.from({length:33},(_,i)=>part('file'+i,'text/plain',Buffer.from('x')))));const overflow=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.equal(overflow.files.length,32);assert.equal(overflow.omitted_file_count,1);assert.match(overflow.presentation.content,/Many files/);
 const invalid=await fixture();await assert.rejects(invalid.adapter.nativeEmailPresentation({source:invalid.source},{...invalid.context,signal:AbortSignal.abort()}));await assert.rejects(invalid.adapter.nativeEmailPresentation({source:invalid.source},{...invalid.context,expires_at:Date.now()-1}));assert.equal(invalid.calls.length,0);
});
test('native presentation clears decoded source after parsing and rejects provider-thread identity drift',async()=>{
 const f=await fixture(),bytes=presentationMime();useMime(f,bytes);const original=Uint8Array.prototype.fill;let cleared;
 Uint8Array.prototype.fill=function(value,...args){if(value===0&&Buffer.from(this).equals(bytes))cleared=this;return original.call(this,value,...args);};
 try{const p=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.equal(p.files.length,2);assert.ok(cleared);assert.ok([...cleared].every(byte=>byte===0));}finally{Uint8Array.prototype.fill=original;}
 const stale=await fixture();stale.handler=()=>json({id:'message',threadId:'another-thread',raw:bytes.toString('base64url')});
 await assert.rejects(stale.adapter.nativeEmailPresentation({source:stale.source},stale.context),/EMAIL_SOURCE_RESPONSE_INVALID/);
});

test('actual native Gmail search executes shared query across provider pages and returns stable private-source identities',async()=>{
 const f=await fixture(),query='from:alice subject:"résumé" -has:attachment',compiled='from:"alice" subject:"résumé" -has:attachment';
 f.handler=(href)=>{
  const url=new URL(href);assert.equal(url.origin,'https://gmail.googleapis.com');
  if(url.pathname.endsWith('/messages')){
   assert.equal(url.searchParams.get('q'),compiled);assert.equal(url.searchParams.get('maxResults'),'1');assert.equal(url.searchParams.get('includeSpamTrash'),'true');
   return json(url.searchParams.get('pageToken')==='second'?{messages:[{id:'b'}]}:{messages:[{id:'a'}],nextPageToken:'second'});
  }
  const id=url.pathname.split('/').at(-1);assert.equal(url.searchParams.get('format'),'metadata');
  return json({id,threadId:'thread-'+id,labelIds:id==='a'?['INBOX','UNREAD']:['SENT'],internalDate:Date.parse('2026-10-04T12:00:00Z'),payload:{headers:[{name:'Subject',value:'résumé'}]}});
 };
 const first=await f.adapter.nativeEmailSearch({query,cursor:null,limit:1},f.context),second=await f.adapter.nativeEmailSearch({query,cursor:first.next_cursor,limit:1},f.context);
 assert.equal(first.status,'supported');assert.equal(first.original_query,query);assert.equal(first.has_more,true);assert.equal(first.query_complete,false);assert.equal(second.has_more,false);assert.equal(second.query_complete,true);assert.equal(second.provider_result_cap,null);
 const scope={org_id:f.context.org_id,owner_id:f.context.owner_user_id,installation_id:f.context.installation_id},index=new LogicalMailIndex(scope);
 const expected=['a','b'].map(id=>index.upsert(scope,{account_id:f.binding.account_id,provider:'gmail',locator:{kind:'gmail',message_id:id,thread_id:'thread-'+id,label_ids:id==='a'?['INBOX','UNREAD']:['SENT']}}).logical_message_id);
 assert.deepEqual([...first.items,...second.items].map(row=>row.logical_message_id),expected);assert.deepEqual(first.items[0].folders,['inbox']);assert.deepEqual(second.items[0].folders,['sent']);assert.equal(first.items[0].flags.seen,false);
 assert.equal(first.items[0].provider_source.account_id,f.binding.account_id);assert.equal(first.items[0].provider_source.logical_message_id,expected[0]);assert.equal(first.items[0].provider_source.locator.message_id,'a');assert.equal(f.calls.length,4);
 const before=f.calls.length;await assert.rejects(f.adapter.nativeEmailSearch({query:'from:bob',cursor:first.next_cursor,limit:1},f.context));assert.equal(f.calls.length,before,'Cursor cannot change compiled query');
});
test('native Graph search uses immutable IDs, generated KQL and canonical durable folder map with explicit1000 cap',async()=>{
 const f=await fixture('microsoft'),query='from:alice -subject:spam has:attachment larger:1K';let collections=0;
 const handler=(href,init)=>{const url=new URL(href);assert.equal(url.origin,'https://graph.microsoft.com');assert.equal(url.pathname,'/v1.0/me/messages');
  assert.equal(init.headers.Prefer,'IdType="ImmutableId"');
  if(!url.searchParams.has('$skiptoken'))assert.equal(url.searchParams.get('$search'),JSON.stringify('from:"alice" AND NOT subject:"spam" AND hasAttachments:true AND size>1000'));
  const id=++collections===1?'a':'b';return json({value:[{id,conversationId:'conversation',parentFolderId:'private-folder',from:{emailAddress:{address:'alice@example.test'}},subject:'Known Graph match',receivedDateTime:'2026-10-04T12:00:00Z',isRead:false,flag:{flagStatus:'flagged'}}],...(id==='a'?{'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=second'}:{})});};
 f.handler=handler;
 const context={...f.context,provider_state:{read:async key=>({state_key:key,storage_revision:1,generation:'generation',value:{system_folders:{'private-folder':'inbox'}}}),stale:async()=>assert.fail('Search does not sweep native inventory')}};
 const first=await f.adapter.nativeEmailSearch({query,cursor:null,limit:1},context),second=await f.adapter.nativeEmailSearch({query,cursor:first.next_cursor,limit:1},context);
 assert.equal(first.query_complete,false);assert.equal(second.query_complete,false);assert.equal(second.has_more,false);assert.equal(second.provider_result_cap,1000);assert.ok(second.limitations.includes('provider_result_cap_1000'));
 assert.deepEqual(first.items[0].folders,['inbox']);assert.equal(first.items[0].provider_source.locator.id_type,'immutable');assert.equal(first.items[0].flags.flagged,true);assert.equal(f.calls.length,2);
 const cold=await fixture('microsoft');cold.handler=handler;const page=await cold.adapter.nativeEmailSearch({query,cursor:null,limit:1},cold.context);
 assert.ok(page.items[0].folders[0].startsWith('folder:'));assert.ok(!page.items[0].folders.includes('inbox'),'No guessed canonical folder when private catalog is absent');
});
test('unsupported or malformed native queries preserve original input and never execute partial provider search',async()=>{
 for(const [provider,query,field] of [['gmail','in:all subject:good','in'],['microsoft','is:unread subject:good','is']]){
  const f=await fixture(provider),result=await f.adapter.nativeEmailSearch({query,cursor:null,limit:10},f.context);
  assert.equal(result.status,'unsupported');assert.equal(result.original_query,query);assert.equal(result.provider,provider);assert.deepEqual(result.items,[]);assert.equal(result.next_cursor,null);assert.equal(result.has_more,false);assert.equal(result.query_complete,false);assert.equal(result.unsupported[0].field,field);assert.equal(f.calls.length,0);
  await assert.rejects(f.adapter.nativeEmailSearch({query:'subject:"unfinished',cursor:null,limit:10},f.context),/EMAIL_QUERY_INVALID/);assert.equal(f.calls.length,0);
  await assert.rejects(f.adapter.nativeEmailSearch({query:'good',cursor:null,limit:10,url:'https://attacker.invalid'},f.context));assert.equal(f.calls.length,0);
 }
});
test('native search metadata failures remain partial, repeated IDs fail and held disconnect rejects matching hits',async()=>{
 const f=await fixture();f.handler=href=>{const url=new URL(href);return url.pathname.endsWith('/messages')?json({messages:[{id:'present'},{id:'gone'}]}):url.pathname.endsWith('/gone')?new Response('',{status:404}):json({id:'present',threadId:'thread',labelIds:['INBOX'],payload:{headers:[]}});};
 const page=await f.adapter.nativeEmailSearch({query:'known',cursor:null,limit:2},f.context);assert.equal(page.items.length,1);assert.equal(page.failure_count,1);assert.equal(page.query_complete,false);assert.equal(page.has_more,false);
 const duplicate=await fixture('microsoft');duplicate.handler=()=>json({value:Array(2).fill({id:'same',conversationId:'conversation',parentFolderId:'folder'})});await assert.rejects(duplicate.adapter.nativeEmailSearch({query:'known',cursor:null,limit:2},duplicate.context),/EMAIL_NATIVE_SEARCH_INVALID/);
 const held=await fixture('microsoft'),entered=barrier(),blocked=barrier();held.handler=()=>json({value:[{id:'match',conversationId:'conversation',parentFolderId:'folder'}]});held.hold=async()=>{entered.release();await blocked.promise;};
 const reading=held.adapter.nativeEmailSearch({query:'known',cursor:null,limit:1},held.context);await entered.promise;await held.change('revoke');blocked.release();await assert.rejects(reading);assert.equal(held.calls.length,1);
});

test('standalone owner consent narrows actual registered descriptor without changing custody identity; inspection never authorizes content/effects',async()=>{
 for(const provider of ['gmail','microsoft']){
  const f=await fixture(provider,undefined,['read','modify','send']),restricted={...f.context,owner_capabilities:['read']};
  const account=await f.adapter.nativeEmailAccount(restricted);assert.deepEqual(account.capabilities,['read']);assert.equal(account.principal_digest,createHash('sha256').update(JSON.stringify(['org','owner',provider,'private-verified-principal'])).digest('hex'));
  await assert.rejects(f.adapter.nativeEmailSendIdentity(restricted),/AUTHORITY_DENIED/);assert.equal(f.calls.length,0);
  const inspection={...f.context,lifecycle_inspect:true},metadata=await f.adapter.nativeEmailAccount(inspection);assert.deepEqual(metadata.capabilities,['read','modify','send']);
  for(const read of [()=>f.adapter.nativeEmailSource({source:f.source},inspection),()=>f.adapter.nativeEmailSearch({query:'known',cursor:null,limit:1},inspection),()=>f.adapter.nativeEmailSendIdentity(inspection)])await assert.rejects(read(),/AUTHORITY_DENIED/);
  for(const owner_capabilities of [[],['read','read'],['modify'],['read','permanent_delete']])await assert.rejects(f.adapter.nativeEmailAccount({...f.context,owner_capabilities}),/AUTHORITY_DENIED/);
  assert.equal(f.calls.length,0);const rows=[...f.storeRows.values()];assert.equal(rows.length,1,'descriptor reduction keeps the exact custody namespace');
 }
});

test('M22 actual native Gmail/Graph canonical folder scopes use existing collections and bind continuation',async()=>{
 const gmail={inbox:'INBOX',sent:'SENT',drafts:'DRAFT',spam:'SPAM',trash:'TRASH'},graph={inbox:'inbox',sent:'sentitems',drafts:'drafts',spam:'junkemail',trash:'deleteditems'};
 for(const provider of ['gmail','microsoft'])for(const role of Object.keys(gmail))for(const tail of ['',' subject:proof']){
  const f=await fixture(provider),query='in:'+role+tail;let n=0;
  f.handler=href=>{const u=new URL(href);if(provider==='gmail'&&u.pathname.endsWith('/messages')){assert.deepEqual(u.searchParams.getAll('labelIds'),[gmail[role]]);assert.equal(u.searchParams.get('q'),tail?'subject:"proof"':null);assert.equal(u.searchParams.get('includeSpamTrash'),'true');return json(n++?{messages:[{id:'b'}]}:{messages:[{id:'a'}],nextPageToken:'second'});}
   if(provider==='gmail')return json({id:u.pathname.split('/').at(-1),threadId:'thread',labelIds:[gmail[role]],internalDate:Date.parse('2026-10-04T12:00:00Z'),payload:{headers:[]}});
   assert.equal(u.pathname,`/v1.0/me/mailFolders/${graph[role]}/messages`);if(!u.searchParams.has('$skiptoken'))assert.equal(u.searchParams.get('$search'),tail?JSON.stringify('subject:"proof"'):null);
   const id=n++?'b':'a';return json({value:[threadGraph(id,'opaque-'+role)],...(id==='a'?{'@odata.nextLink':`https://graph.microsoft.com/v1.0/me/mailFolders/${graph[role]}/messages?$skiptoken=second`}:{})});};
  const a=await f.adapter.nativeEmailSearch({query,cursor:null,limit:1},f.context),count=f.calls.length;assert.equal(a.status,'supported');assert.equal(a.original_query,query);assert.ok(a.next_cursor);
  await assert.rejects(f.adapter.nativeEmailSearch({query:'in:'+(role==='inbox'?'sent':'inbox')+tail,cursor:a.next_cursor,limit:1},f.context));assert.equal(f.calls.length,count,'role change makes no provider request');
  const b=await f.adapter.nativeEmailSearch({query,cursor:a.next_cursor,limit:1},f.context);assert.equal(b.items.length,1);assert.equal(b.has_more,false);assert.equal(b.query_complete,provider==='gmail');assert.equal(new Set([...a.items,...b.items].map(x=>x.logical_message_id)).size,2);
 }
 const escape=await fixture('microsoft');escape.handler=()=>json({value:[threadGraph('a','opaque-drafts')],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=escaped'});const first=await escape.adapter.nativeEmailSearch({query:'in:drafts',cursor:null,limit:1},escape.context),before=escape.calls.length;await assert.rejects(escape.adapter.nativeEmailSearch({query:'in:drafts',cursor:first.next_cursor,limit:1},escape.context));assert.equal(escape.calls.length,before);
});
test('M22 unsupported scopes never issue partial queries and moved scoped rows retain explicit partial coverage',async()=>{
 for(const provider of ['gmail','microsoft']){const f=await fixture(provider);for(const query of ['in:sent in:inbox subject:proof','-in:inbox','in:archive']){const v=await f.adapter.nativeEmailSearch({query,cursor:null,limit:25},f.context);assert.equal(v.status,'unsupported');assert.equal(v.items.length,0);assert.equal(f.calls.length,0);}}
 const f=await fixture();f.handler=href=>new URL(href).pathname.endsWith('/messages')?json({messages:[{id:'a'}]}):json({id:'a',threadId:'thread',labelIds:['INBOX'],internalDate:Date.parse('2026-10-04T12:00:00Z'),payload:{headers:[]}});const moved=await f.adapter.nativeEmailSearch({query:'in:drafts',cursor:null,limit:25},f.context);assert.equal(moved.status,'supported');assert.equal(moved.items.length,0);assert.equal(moved.failure_count,1);assert.equal(moved.query_complete,false);
 const held=await fixture(),entered=barrier(),release=barrier();held.hold=async()=>{entered.release();await release.promise;};const pending=held.adapter.nativeEmailSearch({query:'in:inbox',cursor:null,limit:25},held.context);await entered.promise;held.deny();release.release();await assert.rejects(pending);
});

test('M22 normal listing-to-metadata folder moves keep valid hits and count only unsupported scoped rows',async()=>{
 const gmail=await fixture();gmail.handler=href=>{const u=new URL(href);return u.pathname.endsWith('/messages')?json({messages:[{id:'kept'},{id:'moved'}]}):json({id:u.pathname.split('/').at(-1),threadId:'thread',labelIds:[u.pathname.endsWith('/kept')?'DRAFT':'INBOX'],internalDate:Date.parse('2026-10-04T12:00:00Z'),payload:{headers:[]}});};
 const value=await gmail.adapter.nativeEmailSearch({query:'in:drafts',cursor:null,limit:25},gmail.context);assert.equal(value.status,'supported');assert.equal(value.items.length,1);assert.equal(value.items[0].provider_source.locator.message_id,'kept');assert.equal(value.failure_count,1);assert.equal(value.query_complete,false);assert.equal(value.has_more,false);
 const graph=await fixture('microsoft');graph.handler=()=>json({value:[threadGraph('kept','opaque-drafts'),threadGraph('moved','opaque-inbox'),threadGraph('unknown','opaque-unmapped')]});const context={...graph.context,provider_state:{read:async key=>({state_key:key,storage_revision:1,generation:'current',value:{system_folders:{'opaque-drafts':'drafts','opaque-inbox':'inbox'}}}),stale:async()=>assert.fail('Search does not mutate inventory')}};
 const scoped=await graph.adapter.nativeEmailSearch({query:'in:drafts',cursor:null,limit:25},context);assert.deepEqual(scoped.items.map(x=>x.provider_source.locator.message_id),['kept','unknown']);assert.equal(scoped.failure_count,1);assert.equal(scoped.query_complete,false);assert.deepEqual(scoped.items[0].folders,['drafts']);assert.match(scoped.items[1].folders[0],/^folder:/u,'unknown opaque role is not invented');
});
