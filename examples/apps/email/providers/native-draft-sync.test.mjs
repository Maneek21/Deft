import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createAppConnectionAdapter} from './connection-http.mjs';
import {createEncryptedEmailCustody} from './custody-encrypted.mjs';
import {createOAuthProvider} from './oauth-provider.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const attachment=Buffer.from('Exact mirrored attachment ✓');
const mime=Buffer.from('From: owner@example.test\r\nTo: to@example.test\r\nCc: cc@example.test\r\nBcc: blind@example.test\r\nSubject: Mirrored résumé\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=mirror\r\n\r\n--mirror\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nExact draft body\r\n--mirror\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=proof.txt\r\nContent-Transfer-Encoding: base64\r\n\r\n'+attachment.toString('base64')+'\r\n--mirror--\r\n');
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
async function fixture(provider='gmail'){
 const scope={org_id:'org-mirror',owner_id:'owner-mirror',installation_id:'installation-mirror'},binding={scope,account_id:'mirror-account',provider,connection_target:'mirror-target',resource_binding_id:'mirror-binding',action_binding_id:'mirror-action',authority_epoch:1,capabilities:['read','modify']};
 const rows=new Map(),custody=createEncryptedEmailCustody({encryption_key:new Uint8Array(32).fill(27),key_id:'mirror-fixture',store:{async withLock({key},work){return work({async read(){return structuredClone(rows.get(key)??null);},async compareAndSwap({expected_revision,value}){const old=rows.get(key);if((old?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(old?.revision??0)+1,value:structuredClone(value)});return true;}});}}});
 const client={client_id:'synthetic-mirror-client',client_secret:'synthetic-mirror-secret',redirect_uri:'https://fixture.invalid/email/connections/callback',...(provider==='microsoft'?{tenant:'common'}:{})};
 let bytes=mime,version=1,present=false,isDraft=true,live=true,permit=true,lose=false,readbackMismatch=false,afterEffect=async()=>{};const calls=[],reservations=[];
 const ref=provider==='gmail'?'gmail-draft-container':'immutable-graph-draft';
 const fetch=async(url,init)=>{calls.push({url,method:init.method,body:init.body instanceof Uint8Array?Buffer.from(init.body):init.body});assert.equal(init.redirect,'error');assert.ok(init.headers.Authorization.startsWith('Bearer '));
  if(init.method==='POST'||init.method==='PUT'){bytes=provider==='gmail'?Buffer.from(init.body):Buffer.from(init.body,'base64');version++;present=true;await afterEffect();if(lose)throw Error('Synthetic acknowledged request response loss');if(readbackMismatch)bytes=Buffer.from(bytes.toString().replace('Exact draft body','Externally changed'));return json(provider==='gmail'?{id:ref,message:{id:'gmail-message-'+version}}:{id:ref,isDraft:true,changeKey:'graph-version-'+version});}
  if(init.method==='DELETE'){present=false;await afterEffect();if(lose)throw Error('Synthetic delete response loss');return new Response(null,{status:204});}
  if(!present)return json({},404);
  if(provider==='gmail')return json({id:ref,message:{id:'gmail-message-'+version,historyId:String(version),labelIds:isDraft?['DRAFT']:['SENT'],raw:bytes.toString('base64url')}});
  if(url.endsWith('/$value'))return new Response(bytes,{headers:{'content-type':'message/rfc822'}});
  return json({id:ref,isDraft,changeKey:'graph-version-'+version});
 };
 await custody.withAccount(binding,async tx=>tx.write({health:'connected',secret:{access_token:'synthetic-mirror-access',refresh_token:'synthetic-mirror-refresh',expires_at:Date.now()+3600000,
  scopes:provider==='gmail'?['openid','email','https://www.googleapis.com/auth/gmail.modify']:['offline_access','User.Read','Mail.Read','Mail.ReadWrite'],
  client_fingerprint:createOAuthProvider({provider,client,fetch}).client_fingerprint,identity:{provider_subject:'mirror-principal',primary_address:'owner@example.test',display_label:'Mirror owner',verified_sender_identities:[]}}}));
 const {scope:ignored,...options}=binding,adapter=await createAppConnectionAdapter({options:{...options,origin:'https://fixture.invalid',clients:{[provider]:client}},custody,fetch,host:{resolveContext:async()=>assert.fail('No Experience projection'),assertCurrent:async()=>assert.fail('No Experience authority')}});
 const context={org_id:scope.org_id,owner_user_id:scope.owner_id,installation_id:scope.installation_id,account_id:binding.account_id,resource_binding_id:binding.resource_binding_id,authority_version:'mirror-human-current',expires_at:Date.now()+60000,recheck:async()=>{if(!live)throw Error('revoked');},draft_sync_before_effect:async value=>{reservations.push(value);return permit;}};
 return {adapter,context,calls,reservations,ref,get bytes(){return bytes;},get version(){return version;},externalEdit(){bytes=Buffer.from(bytes.toString().replace('Exact draft body','External editor body'));version++;},deny(){live=false;},set permit(value){permit=value;},set lose(value){lose=value;},set isDraft(value){isDraft=value;},set readbackMismatch(value){readbackMismatch=value;},set afterEffect(value){afterEffect=value;},async replacePrincipal(){await custody.withAccount(binding,async tx=>{const row=tx.read();await tx.write({health:'connected',secret:{...row.secret,identity:{...row.secret.identity,provider_subject:'changed-mirror-principal'}},advance_setup:true});});}};
}
const request=(operation,extra={})=>({operation,operation_id:randomUUID(),...extra});
const desired=bytes=>({mime_bytes:bytes,mime_digest:hash(bytes)});
test('registered Gmail and Graph mapped draft MIME creation/inspection preserves Bcc, Unicode and exact attachment bytes',async()=>{
 for(const provider of ['gmail','microsoft']){const f=await fixture(provider),input=request('create',{desired:desired(mime)}),created=await f.adapter.nativeEmailDraftSync(input,f.context);
  assert.equal(created.outcome,'created');assert.equal(created.provider_draft_ref,f.ref);assert.equal(created.baseline_digest,hash(mime));assert.deepEqual(Buffer.from(created.mime_bytes),mime);assert.deepEqual(f.bytes,mime);assert.equal(f.reservations.length,1);assert.equal(f.reservations[0].desired_digest,hash(mime));assert.equal(f.reservations[0].account_id,'mirror-account');assert.ok(created.limitations.includes('compare_before_effect_is_not_atomic_cas'));
  const inspected=await f.adapter.nativeEmailDraftSync(request('inspect',{provider_draft_ref:f.ref}),f.context);assert.equal(inspected.outcome,'present');assert.equal(inspected.provider_version,created.provider_version);assert.deepEqual(Buffer.from(inspected.mime_bytes),mime);
  const write=f.calls.find(call=>call.method==='POST');assert.equal(write.url,provider==='gmail'?'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media':'https://graph.microsoft.com/v1.0/me/messages');assert.deepEqual(provider==='gmail'?write.body:Buffer.from(write.body,'base64'),mime);
 }
});
test('Gmail replaces content under stable container with new message version; external edits conflict before update/delete',async()=>{
 const f=await fixture(),created=await f.adapter.nativeEmailDraftSync(request('create',{desired:desired(mime)}),f.context),changed=Buffer.from(mime.toString().replace('Exact draft body','New local draft body'));
 const updated=await f.adapter.nativeEmailDraftSync(request('update',{provider_draft_ref:f.ref,baseline_digest:created.baseline_digest,provider_version:created.provider_version,desired:desired(changed)}),f.context);assert.equal(updated.outcome,'updated');assert.equal(updated.provider_draft_ref,created.provider_draft_ref);assert.notEqual(updated.provider_version,created.provider_version);assert.deepEqual(Buffer.from(updated.mime_bytes),changed);
 const other=await fixture(),baseline=await other.adapter.nativeEmailDraftSync(request('create',{desired:desired(mime)}),other.context);other.externalEdit();const writes=other.calls.filter(row=>row.method!=='GET').length,reserved=other.reservations.length;
 for(const operation of ['update','delete']){const result=await other.adapter.nativeEmailDraftSync(request(operation,{provider_draft_ref:other.ref,baseline_digest:baseline.baseline_digest,provider_version:baseline.provider_version,...(operation==='update'?{desired:desired(changed)}:{})}),other.context);assert.equal(result.outcome,'conflict');assert.equal(result.mime_bytes,undefined);}
 assert.equal(other.calls.filter(row=>row.method!=='GET').length,writes);assert.equal(other.reservations.length,reserved);
});
test('Graph full-MIME update is explicit unsupported without I/O; mapped current drafts delete and missing/non-drafts never mutate',async()=>{
 for(const provider of ['gmail','microsoft']){const f=await fixture(provider),created=await f.adapter.nativeEmailDraftSync(request('create',{desired:desired(mime)}),f.context),baseline={provider_draft_ref:f.ref,baseline_digest:created.baseline_digest,provider_version:created.provider_version};
  if(provider==='microsoft'){const count=f.calls.length;const result=await f.adapter.nativeEmailDraftSync(request('update',{...baseline,desired:desired(mime)}),f.context);assert.equal(result.outcome,'unsupported');assert.equal(f.calls.length,count);}
  f.isDraft=false;assert.equal((await f.adapter.nativeEmailDraftSync(request('delete',baseline),f.context)).outcome,'conflict');f.isDraft=true;
  const deleted=await f.adapter.nativeEmailDraftSync(request('delete',baseline),f.context);assert.equal(deleted.outcome,'deleted');assert.equal((await f.adapter.nativeEmailDraftSync(request('inspect',{provider_draft_ref:f.ref}),f.context)).outcome,'missing');
 }
});
test('lost create response remains unknown without retry; known draft readback mismatch conflicts and reservation denial effects nothing',async()=>{
 const f=await fixture();f.lose=true;const result=await f.adapter.nativeEmailDraftSync(request('create',{desired:desired(mime)}),f.context);assert.equal(result.outcome,'unknown');assert.equal(result.provider_draft_ref,undefined);assert.equal(f.calls.length,1);assert.equal(f.reservations.length,1);
 const changed=await fixture();changed.readbackMismatch=true;const conflict=await changed.adapter.nativeEmailDraftSync(request('create',{desired:desired(mime)}),changed.context);assert.equal(conflict.outcome,'conflict');assert.equal(conflict.provider_draft_ref,changed.ref);assert.ok(conflict.limitations.includes('provider_readback_content_mismatch'));assert.equal(conflict.mime_bytes,undefined);
 const denied=await fixture();denied.permit=false;await assert.rejects(denied.adapter.nativeEmailDraftSync(request('create',{desired:desired(mime)}),denied.context),/RESERVATION_DENIED/);assert.equal(denied.calls.length,0);
});
test('bad scope/digest/size/sender and held credential withdrawal deny; read-only methods reject effect callback context',async()=>{
 const f=await fixture();for(const input of [request('create',{desired:{mime_bytes:mime,mime_digest:'f'.repeat(64)}}),request('create',{desired:desired(Buffer.from(mime.toString().replace('owner@example.test','attacker@example.test')))}),request('delete',{provider_draft_ref:'unmapped',baseline_digest:'f'.repeat(64)})])await assert.rejects(f.adapter.nativeEmailDraftSync(input,f.context));
 await assert.rejects(f.adapter.nativeEmailDraftSync(request('create',{desired:desired(mime)}),{...f.context,owner_user_id:'foreign'}));await assert.rejects(f.adapter.nativeEmailAccount(f.context));assert.equal(f.calls.length,0);
 const graph=await fixture('microsoft');await assert.rejects(graph.adapter.nativeEmailDraftSync(request('create',{desired:desired(Buffer.alloc(3*1024*1024+1,65))}),graph.context),/SIZE_UNSUPPORTED/);assert.equal(graph.calls.length,0);
 const held=await fixture();held.afterEffect=async()=>held.replacePrincipal();await assert.rejects(held.adapter.nativeEmailDraftSync(request('create',{desired:desired(mime)}),held.context));assert.equal(held.calls.length,1);assert.equal(held.reservations.length,1);
});
