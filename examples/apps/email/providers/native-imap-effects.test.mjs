import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createNativeImapEffectsBridge,NATIVE_SMTP_LIMITS} from './native-imap-effects.mjs';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {providerSourceForParent} from './provider-browser.mjs';
const barrier=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
import {nativeImapEffectsFixture as fixture} from './native-imap-effects-fixture.mjs';
const apply=(f,kind,destination)=>({mode:'apply',operation_id:randomUUID(),operation:{kind,...(destination?{destination:{account_id:'account',provider:'imap_smtp',kind:'folder',id:destination}}:{})},sources:[f.source]});
test('native SMTP sends digest-exact raw bytes once with trusted To/Cc/Bcc envelope and honest pending Sent copy',async()=>{
 const f=fixture(),bridge=f.bridge(),identity=await bridge.nativeEmailSendIdentity(f.context);assert.equal(identity.provider,'imap_smtp');assert.equal(identity.action_binding_id,'action');assert.equal(f.calls.smtp,0);
 const original=Buffer.from(f.request.mime_bytes),result=await bridge.nativeEmailSend(f.request,f.sendContext);
 assert.equal(result.provider,'imap_smtp');assert.equal(result.transport_outcome,'provider_accepted');assert.equal(result.delivery_status,'unknown');assert.equal(result.sent_copy_outcome,'pending');assert.equal(result.provider_message_id,null);
 assert.equal(f.calls.send,1);assert.equal(f.calls.close,1);assert.deepEqual(f.request.mime_bytes,original);
});
test('native SMTP denies invalid digest/sender/envelope/MIME/profile authority before reservation or effect',async()=>{
 for(const changed of [f=>({...f.request,mime_digest:'b'.repeat(64)}),f=>({...f.request,from_address:'other@example.test'}),f=>({...f.request,envelope:{from:f.request.from_address,to:['to@example.test','TO@example.test']}}),
  f=>({...f.request,envelope:{from:f.request.from_address,to:['blind@example.test']}}),f=>{const bytes=Buffer.from(f.request.mime_bytes.toString().replace('Subject:','Bcc: blind@example.test\r\nSubject:'));return {...f.request,mime_bytes:bytes,mime_digest:createHash('sha256').update(bytes).digest('hex')};},f=>({...f.request,mime_bytes:new Uint8Array(NATIVE_SMTP_LIMITS.mime_bytes+1)})]){
  const f=fixture();await assert.rejects(f.bridge().nativeEmailSend(changed(f),f.sendContext));assert.equal(f.calls.reserve,0);assert.equal(f.calls.send,0);}
 const f=fixture();f.descriptor.capabilities=['read'];await assert.rejects(f.bridge().nativeEmailSend(f.request,f.sendContext));assert.equal(f.calls.send,0);
});
test('SMTP partial acceptance/response loss and held principal/revision withdrawal never retry',async()=>{
 for(const kind of ['partial','lost','principal','revision','revoke']){const f=fixture();if(kind==='partial')f.result={accepted:['to@example.test'],rejected:['cc@example.test']};
  else f.onSend=async()=>{if(kind==='lost')throw Error('acknowledgement lost');if(kind==='principal')f.descriptor.principal_digest='b'.repeat(64);if(kind==='revision')f.descriptor.connection_revision++;if(kind==='revoke')f.deny();};
  await assert.rejects(f.bridge().nativeEmailSend(f.request,f.sendContext));assert.equal(f.calls.send,1);assert.equal(f.calls.close,1);}
});
test('abort during SMTP acknowledgement denies output and clears the private raw copy; expired admission never connects',async()=>{
 const f=fixture(),entered=barrier(),held=barrier(),controller=new AbortController();f.onSend=async()=>{entered.release();await held.promise;};
 const pending=f.bridge().nativeEmailSend(f.request,{...f.sendContext,signal:controller.signal});await entered.promise;controller.abort();held.release();await assert.rejects(pending);
 assert.equal(f.calls.send,1);assert.equal(f.calls.close,1);assert.ok([...f.captured].every(byte=>byte===0));assert.ok(f.request.mime_bytes.some(byte=>byte!==0));
 const expired=fixture();await assert.rejects(expired.bridge().nativeEmailSend(expired.request,{...expired.sendContext,expires_at:Date.now()-1}));assert.equal(expired.calls.smtp,0);
});
test('native IMAP flags reuse durable conditional state machine, preserve unrelated flags, replay and conditional undo',async()=>{
 const f=fixture(),bridge=f.bridge(),input=apply(f,'mark_read'),result=await bridge.nativeEmailTriage(input,f.triageContext);
 assert.equal(result.items[0].state,'succeeded');assert.equal(result.items[0].logical_message_id,f.source.logical_message_id);assert.equal(result.items[0].undo_supported,true);assert.equal(result.automatic_retry,false);
 assert.deepEqual([...f.boxes.get('INBOX').rows.get(1).flags].sort(),['\\Answered','\\Seen']);const reads=f.calls.imap;
 const replay=await f.bridge().nativeEmailTriage(input,f.triageContext);assert.equal(Object.hasOwn(replay.items[0],'confirmed_flags'),false);assert.deepEqual(replay,{...result,items:result.items.map(({confirmed_flags:_flags,...item})=>item)});assert.equal(f.calls.imap,reads);assert.equal(f.calls.write,1);
 const undone=await f.bridge().nativeEmailTriage({mode:'undo',operation_id:input.operation_id,undo_operation_id:randomUUID()},f.triageContext);assert.equal(undone.items[0].state,'succeeded');assert.deepEqual([...f.boxes.get('INBOX').rows.get(1).flags],['\\Answered']);
 assert.equal(f.calls.list,0,'Flag operations do not fetch all folder metadata');
});
test('native IMAP archive/trash/Move use actual special-use catalog and retain exact COPYUID locator in encrypted-journal port',async()=>{
 for(const [kind,destination]of [['archive','Localized Archive'],['trash','Localized Trash'],['move','Private Work']]){const f=fixture(),input=apply(f,kind,kind==='move'?destination:null),result=await f.bridge().nativeEmailTriage(input,f.triageContext);
  assert.equal(result.items[0].state,'succeeded');assert.equal(f.boxes.get('INBOX').rows.has(1),false);assert.equal(f.boxes.get(destination).rows.has(99),true);
  assert.deepEqual(f.ledger.get(input.operation_id).items[0].after.locator,{kind:'imap_smtp',mailbox:destination,uidvalidity:f.boxes.get(destination).validity,uid:99});assert.equal(JSON.stringify(result).includes('mailbox'),false);
 }
});
test('IMAP UIDVALIDITY/read-only-capability conflicts deny writes; unknown started outcomes survive restart without repetition',async()=>{
 const stale=fixture();stale.boxes.get('INBOX').validity='200';await assert.rejects(stale.bridge().nativeEmailTriage(apply(stale,'star'),stale.triageContext),/LOCATOR_STALE/);assert.equal(stale.calls.write,0);
 for(const kind of ['condstore','move','tls']){const f=fixture();f[kind]=false;let result;try{result=await f.bridge().nativeEmailTriage(apply(f,kind==='move'?'archive':'star'),f.triageContext);}catch{}
  if(result)assert.equal(result.items[0].state,'failed');assert.equal(f.calls.write,0);}
 for(const kind of ['lost','finish']){const f=fixture(),input=apply(f,'star');if(kind==='lost')f.onWrite=async()=>{throw Error('response lost');};else f.finishLoss=true;
  try{const result=await f.bridge().nativeEmailTriage(input,f.triageContext);assert.equal(result.items[0].state,'unknown');}catch{}
  f.finishLoss=false;f.onWrite=async()=>{};const writes=f.calls.write,result=await f.bridge().nativeEmailTriage(input,f.triageContext);assert.equal(result.items[0].state,'unknown');assert.equal(f.calls.write,writes);}
});

test('M25 actual IMAP fresh flags and Undo ACK only this effect; apply/status/Undo replay never reuses old flags',async()=>{
 const f=fixture(),a=apply(f,'mark_read'),fresh=await f.bridge().nativeEmailTriage(a,f.triageContext);assert.deepEqual(fresh.items[0].confirmed_flags,{seen:true,flagged:false,answered:true});
 await f.bridge().nativeEmailTriage(apply(f,'mark_unread'),f.triageContext);let reads=f.calls.imap,writes=f.calls.write;
 for(const input of [a,{mode:'status',operation_id:a.operation_id}]){const replay=await f.bridge().nativeEmailTriage(input,f.triageContext);assert.equal(replay.items[0].state,'succeeded');assert.equal(Object.hasOwn(replay.items[0],'confirmed_flags'),false);}assert.equal(f.calls.imap,reads);assert.equal(f.calls.write,writes);assert.equal(f.boxes.get('INBOX').rows.get(1).flags.has('\\Seen'),false);
 const star=apply(f,'star');await f.bridge().nativeEmailTriage(star,f.triageContext);const undo={mode:'undo',operation_id:star.operation_id,undo_operation_id:randomUUID()},undone=await f.bridge().nativeEmailTriage(undo,f.triageContext);assert.deepEqual(undone.items[0].confirmed_flags,{seen:false,flagged:false,answered:true});
 await f.bridge().nativeEmailTriage(apply(f,'star'),f.triageContext);reads=f.calls.imap;writes=f.calls.write;for(const input of [undo,{mode:'status',operation_id:undo.undo_operation_id}])assert.equal(Object.hasOwn((await f.bridge().nativeEmailTriage(input,f.triageContext)).items[0],'confirmed_flags'),false);assert.equal(f.calls.imap,reads);assert.equal(f.calls.write,writes);assert.equal(f.boxes.get('INBOX').rows.get(1).flags.has('\\Flagged'),true);
});
