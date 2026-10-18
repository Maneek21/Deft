import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {createAppConnectionAdapter} from './native-imap-connection.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {providerSourceForParent} from './provider-browser.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
test('actual IMAP explicit native profile reads33/200 full seeds and retains201 body with unavailable seed',async()=>{
 for(const count of [33,200,201]){
  const to=Array.from({length:count},(_,n)=>`Person ${n} <p${n}@example.test>`).join(', '),bytes=Buffer.from(`From: sender@example.test\r\nTo: ${to}\r\nMessage-ID: <parent@example.test>\r\nContent-Type: text/plain\r\n\r\nFull native body.`);
  const f=await fixture();f.bytes=bytes;const value=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.equal(value.presentation.content,'Full native body.');
  if(count<=200){assert.equal(value.reply_seed_unavailable,undefined);assert.equal(value.presentation.metadata.reply_to_list.split('@example.test').length-1,count);}
  else{assert.deepEqual(value.reply_seed_unavailable,['reply_to_list']);assert.equal(value.presentation.metadata.reply_to_list,'');}
  const original=await f.adapter.nativeEmailSource({source:f.source},f.context);assert.deepEqual(Buffer.from(original.mime_bytes),bytes);original.mime_bytes.fill(0);
  f.account.health='revoked';await assert.rejects(f.adapter.nativeEmailPresentation({source:f.source},f.context));
 }
});
const mime=Buffer.from('From: Sender <sender@example.test>\r\nTo: configured@example.test\r\nSubject: Native IMAP résumé\r\nMessage-ID: <message@example.test>\r\nReferences: <prior@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>IMAP body</p><script>untrusted()</script><img src="cid:logo"><img src="https://images.example.test/photo">\r\n--fixture\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="../report.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from('Exact attachment').toString('base64')+'\r\n--fixture\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename="logo.png"\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\n'+png.toString('base64')+'\r\n--fixture--\r\n');
async function fixture(){
 const scope={org_id:'org',owner_id:'owner',installation_id:'installation'},account={org_id:'org',owner_user_id:'owner',installation_id:'installation',account_id:'account',provider:'imap_smtp',resource_binding_id:'binding',authority_epoch:1,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read'],primary_address:'configured@example.test',display_label:'IMAP configured sender',connection_target:'target',action_binding_id:null,verified_sender_identities:[]};
 const locator={kind:'imap_smtp',mailbox:'Localized Inbox',uidvalidity:'100',uid:7},source=providerSourceForParent(account,new LogicalMailIndex(scope).upsert(scope,{account_id:'account',provider:'imap_smtp',locator}));
 let bytes=mime,validity='100',size=mime.length,expectedSize=mime.length,uid=7,onDownload=()=>{},afterWork=()=>{},onRemote=()=>{},makeStream=()=>Readable.from([bytes]),lastStream,lastCopy,remoteCopy;
 const calls={connect:0,download:0,cleanup:0,release:0,remote:0,lookup:0};
 const context={org_id:'org',owner_user_id:'owner',installation_id:'installation',account_id:'account',resource_binding_id:'binding',authority_version:'v1',expires_at:Date.now()+60000,recheck:async()=>{}};
 const host={current:async()=>structuredClone(account),async withAuthorizedClient(_context,expected,work){calls.connect++;assert.equal(Object.hasOwn(expected,'org_id'),false);assert.equal(Object.hasOwn(expected,'verified_sender_identities'),false);
  const client={authenticated:true,secureConnection:true,mailbox:null,async getMailboxLock(path,options){assert.equal(path,locator.mailbox);assert.deepEqual(options,{readOnly:true});this.mailbox={path,readOnly:true,uidValidity:validity};return {release(){calls.release++;}};},
   async fetchOne(value,query,options){assert.equal(value,7);assert.deepEqual(query,{uid:true,size:true});assert.deepEqual(options,{uid:true});return {uid,size};},
   async download(value,part,options){calls.download++;assert.equal(value,7);assert.equal(part,undefined);assert.deepEqual(options,{uid:true,maxBytes:35*1024*1024+1,chunkSize:65536});lastStream=makeStream();onDownload();return {meta:{expectedSize},content:lastStream};},close(){}};
  try{const result=await work(client);lastCopy=result?.mime_bytes;afterWork();return result;}finally{calls.cleanup++;}},async withAuthorizedSmtp(){assert.fail('Source never opens SMTP');}};
 const adapter=await createAppConnectionAdapter({host:{nativeEmailImapHost:async()=>host},imageDependencies:{lookup:async()=>{calls.lookup++;return [{address:'8.8.8.8',family:4}];},request:async(_url,pinned,signal)=>{calls.remote++;assert.equal(pinned.address,'8.8.8.8');assert.equal(signal.aborted,false);remoteCopy=png.slice();onRemote();return {media_type:'image/png',bytes:remoteCopy};}}});
 return {adapter,context,source,account,calls,get stream(){return lastStream;},get copy(){return lastCopy;},get remoteCopy(){return remoteCopy;},set bytes(value){bytes=value;size=value.length;expectedSize=value.length;},set validity(value){validity=value;},set size(value){size=value;},set expectedSize(value){expectedSize=value;},set uid(value){uid=value;},set onDownload(value){onDownload=value;},set afterWork(value){afterWork=value;},set onRemote(value){onRemote=value;},set makeStream(value){makeStream=value;}};
}
test('actual registered IMAP calendar part extraction preserves exact UID source and does not require modify or SMTP',async()=>{
 const f=await fixture();f.bytes=Buffer.from('Content-Type: text/calendar; charset=utf-8; method=REQUEST\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n');
 const value=await f.adapter.nativeEmailCalendarParts({source:f.source},f.context);assert.equal(value.provider,'imap_smtp');assert.equal(value.receiving_identity.primary_address,'configured@example.test');assert.equal(value.parts[0].media_type_method,'REQUEST');assert.equal(f.calls.download,1);
 const denied=await fixture();denied.onDownload=()=>{denied.account.health='revoked';};await assert.rejects(denied.adapter.nativeEmailCalendarParts({source:denied.source},denied.context));
});
test('registered IMAP source returns exact RFC822 bytes and bound digest from readonly current UID tuple',async()=>{
 const f=await fixture(),result=await f.adapter.nativeEmailSource({source:f.source},f.context);assert.equal(result.schema_version,'deft.email_source.v1');assert.equal(result.provider,'imap_smtp');assert.equal(result.media_type,'message/rfc822');assert.equal(result.digest,createHash('sha256').update(mime).digest('hex'));assert.deepEqual(Buffer.from(result.mime_bytes),mime);assert.equal(f.calls.download,1);assert.equal(f.calls.release,1);assert.equal(f.calls.cleanup,1);
});
test('actual native IMAP incoming >8MiB preserves body and exact readonly source under fresh UID guards',async()=>{
 const bytes=Buffer.from('From: sender@example.test\r\nTo: configured@example.test\r\nMessage-ID: <native-size@example.test>\r\nContent-Type: text/plain\r\n\r\nLARGE_IMAP_BODY_PRESERVED\r\n'+'A'.repeat(9*1024*1024));
 try{const f=await fixture();f.bytes=bytes;
  const view=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.match(view.presentation.plain_text,/LARGE_IMAP_BODY_PRESERVED/);assert.equal(view.presentation.truncated,true);
  const original=await f.adapter.nativeEmailSource({source:f.source},f.context);try{assert.equal(createHash('sha256').update(original.mime_bytes).digest('hex'),createHash('sha256').update(bytes).digest('hex'));}finally{original.mime_bytes.fill(0);}
  f.validity='different';await assert.rejects(f.adapter.nativeEmailSource({source:f.source},f.context));
 }finally{bytes.fill(0);}
});
test('actual IMAP presentation preserves body and exact UID source with attachment overflow and complex HTML fallback',async()=>{
 const f=await fixture(),parts=Array.from({length:33},(_,n)=>`--limit\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="${n}.txt"\r\n\r\nx\r\n`).join('');
 const bytes=Buffer.from('From: sender@example.test\r\nTo: configured@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=limit\r\n\r\n--limit\r\nContent-Type: text/html\r\n\r\n<table><tr>'+'<td>cell</td>'.repeat(5000)+'</tr></table>\r\n'+parts+'--limit--\r\n');f.bytes=bytes;
 const value=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.equal(value.files.length,32);assert.equal(value.omitted_file_count,1);assert.equal(value.presentation.rendering_fallback,'plain_text');assert.equal(value.presentation.format,'plain');assert.deepEqual(value.presentation.images,[]);
 const original=await f.adapter.nativeEmailSource({source:f.source},f.context);assert.deepEqual(Buffer.from(original.mime_bytes),bytes);original.mime_bytes.fill(0);
 f.account.health='revoked';await assert.rejects(f.adapter.nativeEmailPresentation({source:f.source},f.context));
});
test('IMAP presentation reuses MIME inspector, untrusted HTML boundary, explicit sender metadata and exact source-derived attachments/CID',async()=>{
 const f=await fixture(),page=await f.adapter.nativeEmailPresentation({source:f.source},f.context);assert.equal(page.content_trust,'unsanitized');assert.match(page.presentation.content,/<script>untrusted\(\)<\/script>/);assert.equal(page.presentation.metadata.primary_address,'configured@example.test');assert.equal(page.presentation.metadata.verified_sender_identities,'[]');assert.equal(page.presentation.metadata.message_id,'<message@example.test>');assert.equal(page.files.length,2);assert.equal(f.calls.remote,0);
 const file=await f.adapter.nativeEmailFile({source:f.source,source_digest:page.source_digest,file_ref:page.files[0].file_ref},f.context);assert.equal(Buffer.from(file.bytes).toString(),'Exact attachment');assert.equal(file.filename,'.._report.txt');assert.equal(file.media_type,'text/plain');
 const image=await f.adapter.nativeEmailImage({source:f.source,source_digest:page.source_digest,image_ref:page.presentation.images.find(row=>row.kind==='cid').image_ref},f.context);assert.deepEqual(Buffer.from(image.bytes),png);assert.equal(f.calls.remote,0);
 const remote=await f.adapter.nativeEmailImage({source:f.source,source_digest:page.source_digest,image_ref:page.presentation.images.find(row=>row.kind==='remote').image_ref},f.context);assert.deepEqual(Buffer.from(remote.bytes),png);assert.equal(f.calls.remote,1);assert.equal(f.calls.lookup,1);
});
test('wrong scope/source/UIDVALIDITY/UID and stale MIME digest deny without guessed provider locator or arbitrary image URL',async()=>{
 const f=await fixture();for(const source of [{...f.source,account_id:'other'},{...f.source,logical_message_id:'mail_'+'b'.repeat(64)},{...f.source,locator:{...f.source.locator,uid:8}},{...f.source,url:'imap://caller'}])await assert.rejects(f.adapter.nativeEmailSource({source},f.context));assert.equal(f.calls.download,0);
 const badScope=await fixture();await assert.rejects(badScope.adapter.nativeEmailSource({source:badScope.source},{...badScope.context,owner_user_id:'another'}));assert.equal(badScope.calls.connect,0);
 const stale=await fixture();stale.validity='200';await assert.rejects(stale.adapter.nativeEmailSource({source:stale.source},stale.context),/SOURCE_STALE/);assert.equal(stale.calls.download,0);
 const missing=await fixture();missing.uid=8;await assert.rejects(missing.adapter.nativeEmailSource({source:missing.source},missing.context),/SOURCE_STALE/);
 const changed=await fixture(),page=await changed.adapter.nativeEmailPresentation({source:changed.source},changed.context);changed.bytes=Buffer.from(mime.toString().replace('IMAP body','Changed body'));
 await assert.rejects(changed.adapter.nativeEmailFile({source:changed.source,source_digest:page.source_digest,file_ref:page.files[0].file_ref},changed.context),/SOURCE_STALE/);
 await assert.rejects(f.adapter.nativeEmailImage({source:f.source,source_digest:'a'.repeat(64),image_ref:'b'.repeat(64),url:'https://caller.invalid'},f.context));
});
test('partial/oversized downloads never return truncated original; held credential withdrawal destroys source and stream',async()=>{
 for(const kind of ['size','expected','short','overflow']){const f=await fixture();if(kind==='size')f.size=35*1024*1024+1;if(kind==='expected')f.expectedSize=mime.length+1;if(kind==='short')f.makeStream=()=>Readable.from([mime.subarray(0,mime.length-1)]);if(kind==='overflow')f.makeStream=()=>Readable.from([mime,Buffer.from('extra')]);
  await assert.rejects(f.adapter.nativeEmailSource({source:f.source},f.context));assert.equal(f.calls.release,1);assert.equal(f.calls.cleanup,1);if(f.stream)assert.equal(f.stream.destroyed,true);}
 for(const mutate of [f=>f.account.principal_digest='b'.repeat(64),f=>f.account.connection_revision++,f=>f.account.health='revoked']){const f=await fixture();f.onDownload=()=>mutate(f);await assert.rejects(f.adapter.nativeEmailSource({source:f.source},f.context));assert.equal(f.stream.destroyed,true);assert.equal(f.calls.cleanup,1);}
});
test('IMAP source observes abort during blocked stream and presentation exposes explicit256KiB truncation',async()=>{
 const f=await fixture(),controller=new AbortController();let entered;const ready=new Promise(resolve=>entered=resolve);f.makeStream=()=>new Readable({read(){entered();}});
 const pending=f.adapter.nativeEmailSource({source:f.source},{...f.context,signal:controller.signal});await ready;controller.abort();await assert.rejects(pending);assert.equal(f.stream.destroyed,true);assert.equal(f.calls.cleanup,1);
 const large=await fixture();large.bytes=Buffer.from('From: sender@example.test\r\nTo: configured@example.test\r\nContent-Type: text/plain\r\n\r\n'+'x'.repeat(300000));const page=await large.adapter.nativeEmailPresentation({source:large.source},large.context);assert.equal(page.presentation.truncated,true);assert.ok(Buffer.byteLength(page.presentation.content)<=262144);
});
test('late account withdrawal clears complete source and remote image bytes before any return',async()=>{
 const source=await fixture();source.afterWork=()=>{source.account.connection_revision++;};await assert.rejects(source.adapter.nativeEmailSource({source:source.source},source.context));assert.ok(source.copy?.every(byte=>byte===0));assert.equal(source.stream.destroyed,true);
 const image=await fixture(),page=await image.adapter.nativeEmailPresentation({source:image.source},image.context);image.onRemote=()=>{image.account.health='revoked';};await assert.rejects(image.adapter.nativeEmailImage({source:image.source,source_digest:page.source_digest,image_ref:page.presentation.images.find(row=>row.kind==='remote').image_ref},image.context));assert.ok(image.remoteCopy?.every(byte=>byte===0));assert.equal(image.calls.remote,1);
});
