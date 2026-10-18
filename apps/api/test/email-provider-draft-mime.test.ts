import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import test from 'node:test';
import {createEmailProviderDraftMimeBuilder} from '../src/lib/email-provider-draft-mime.js';
import type {EmailDraftRow} from '../src/lib/email-draft-store.js';
const {serializeNativeDraft}=await import(new URL('../../../examples/apps/email/outgoing-snapshot.mjs',import.meta.url).href);
const {simpleParser}=createRequire(new URL('../../../examples/apps/email/package.json',import.meta.url))('mailparser');
const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},bytes=Buffer.from('Exact synthetic attachment');
const file={file_id:randomUUID(),filename:'notes.txt',media_type:'text/plain',size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};

test('current local inline file IDs persist into unsent provider MIME with exact CID/raster and no Bcc loss',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wAAAABJRU5ErkJggg==','base64');
 const image={...file,filename:'diagram.png',media_type:'image/png',size_bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')},cid=`deft-${image.file_id}@deft.invalid`;
 const f=fixture();f.input.draft={...f.input.draft,content:{...f.input.draft.content,body:'[Image: Diagram]',body_html:`<p><img src="cid:${cid}" alt="Diagram"></p>`,attachments:[image]}};
 let reads=0;f.ports.readFile=async()=>{reads++;const value=Buffer.from(png);f.retained.push(value);return {...image,bytes:value};};
 const value=await createEmailProviderDraftMimeBuilder(f.ports)(f.input),parsed=await simpleParser(value.mime_bytes,{keepCidLinks:true});
 assert.equal(parsed.attachments[0].contentId,`<${cid}>`);assert.equal(parsed.attachments[0].contentDisposition,'inline');assert.deepEqual(parsed.attachments[0].content,png);assert.equal(parsed.bcc.value[0].address,'hidden@example.test');assert.equal(reads,1);assert.ok(f.retained.every(bytes=>bytes.every(byte=>byte===0)));value.mime_bytes.fill(0);
 f.input.draft={...f.input.draft,content:{...f.input.draft.content,body:'wrong plain'}};await assert.rejects(createEmailProviderDraftMimeBuilder(f.ports)(f.input));assert.equal(reads,1,'Invalid pair never reads bytes or invokes MIME');
});

test('unsent provider-draft MIME preserves linked HTML, destination-aware plain and original attachment bytes',async()=>{
 const f=fixture(),html='<p><a href="mailto:team@example.test">Contact the team</a></p>',body='Contact the team (mailto:team@example.test)';
 f.input.draft={...f.input.draft,content:{...f.input.draft.content,body,body_html:html}};
 const value=await createEmailProviderDraftMimeBuilder(f.ports)(f.input),parsed=await simpleParser(value.mime_bytes);
 assert.equal(parsed.html,html);assert.equal(parsed.text.trimEnd(),body);assert.deepEqual(parsed.attachments[0].content,bytes);
 assert.equal(value.mime_digest,createHash('sha256').update(value.mime_bytes).digest('hex'));
 assert.ok(f.retained.every(value=>value.every(byte=>byte===0)));value.mime_bytes.fill(0);
 const wrong=fixture();wrong.input.draft={...wrong.input.draft,content:{...wrong.input.draft.content,body:'Contact the team',body_html:html}};
 await assert.rejects(createEmailProviderDraftMimeBuilder(wrong.ports)(wrong.input));assert.ok(wrong.retained.every(value=>value.every(byte=>byte===0)));
});
function fixture(fromAddress?:string,includeVerified=true){
 let revoked=false;const retained:Uint8Array[]=[];
 const draft:EmailDraftRow={draft_id:randomUUID(),revision:1,content_revision:1,status:'draft',content:{mode:'compose',to:'',cc:'',bcc:'hidden@example.test',subject:'',body:'Hello',body_html:'',reply_record_id:'',attachments:[file],...(fromAddress?{from_identity:{address:fromAddress}}:{})},origin:{kind:'human',created_by_user_id:'owner',originating_run_id:null},last_edited_by_user_id:'owner',created_at:'2026-10-01T00:00:00.000Z',updated_at:'2026-10-01T00:00:00.000Z'};
 const account={account_id:'account',provider:'gmail' as const,resource_binding_id:'binding',authority_epoch:2,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','modify'],primary_address:'owner@example.test',display_label:'Owner'};
 const ports={resolve:async()=>({account,...(includeVerified?{verified_sender_identities:['owner@example.test','team@example.test']}:{}),installation_id:'install',serialize:serializeNativeDraft}),readFile:async()=>{const value=Buffer.from(bytes);retained.push(value);return {...file,bytes:value};},readReply:async()=>{throw Error('Unexpected reply');}};
 const input={scope,draft,capability:{scope,resource_binding_id:'binding',authority_version:'v1',expires_at:Date.now()+60000},recheck:async()=>{if(revoked)throw Error('Revoked');}};
 return {ports,input,retained,revoke:()=>{revoked=true;}};
}
test('queue-owned draft MIME keeps Bcc/exact files, permits unfinished recipients and is stable across attempts',async()=>{
 const f=fixture(),build=createEmailProviderDraftMimeBuilder(f.ports),first=await build(f.input),second=await build(f.input);
 assert.deepEqual(first.mime_bytes,second.mime_bytes);const parsed=await simpleParser(first.mime_bytes);
 assert.equal(parsed.bcc.value[0].address,'hidden@example.test');assert.equal(parsed.to,undefined);assert.deepEqual(parsed.attachments[0].content,bytes);
 assert.equal(first.provider,'gmail');assert.equal(first.authority_epoch,2);assert.ok(f.retained.every(value=>value.every(byte=>byte===0)));
 first.mime_bytes.fill(0);second.mime_bytes.fill(0);
});
test('provider draft MIME uses only the current verified saved From identity',async()=>{
 const f=fixture('team@example.test'),first=await createEmailProviderDraftMimeBuilder(f.ports)(f.input),parsed=await simpleParser(first.mime_bytes);
 assert.equal(parsed.from.value[0].address,'team@example.test');assert.equal(parsed.bcc.value[0].address,'hidden@example.test');first.mime_bytes.fill(0);
 const denied=fixture('not-verified@example.test');await assert.rejects(createEmailProviderDraftMimeBuilder(denied.ports)(denied.input));
});
test('primary-only draft MIME remains available without send inventory but explicit From requires it',async()=>{
 const primary=fixture(undefined,false);
 const mime=await createEmailProviderDraftMimeBuilder(primary.ports)(primary.input);mime.mime_bytes.fill(0);
 const explicit=fixture('owner@example.test',false);
 await assert.rejects(createEmailProviderDraftMimeBuilder(explicit.ports)(explicit.input));
});
test('crossed attachment metadata, invalid partial addresses and unsupported authority cannot serialize a remote draft',async()=>{
 const fileCase=fixture();fileCase.ports.readFile=async()=>({...file,filename:'forged.txt',bytes:Buffer.from(bytes)});
 await assert.rejects(createEmailProviderDraftMimeBuilder(fileCase.ports)(fileCase.input),/EMAIL_DRAFT_SYNC_CONTENT_INVALID/);
 const incomplete=fixture();incomplete.input.draft={...incomplete.input.draft,content:{...incomplete.input.draft.content,to:'unfinished@'}};
 await assert.rejects(createEmailProviderDraftMimeBuilder(incomplete.ports)(incomplete.input));
 const denied=fixture();const resolve=denied.ports.resolve;denied.ports.resolve=async()=>{const value=await resolve();value.account.capabilities=['read'];return value;};
 await assert.rejects(createEmailProviderDraftMimeBuilder(denied.ports)(denied.input),/EMAIL_DRAFT_SYNC_CONTENT_INVALID/);
});
test('revocation after MIME compilation zeros returned bytes and never exposes them to the effect caller',async()=>{
 const f=fixture();let mime:Uint8Array|undefined;const resolve=f.ports.resolve;
 f.ports.resolve=async()=>{const value=await resolve();return {...value,serialize:async(...args:unknown[])=>{const result=await serializeNativeDraft(...args);mime=result.mime_bytes;f.revoke();return result;}};};
 await assert.rejects(createEmailProviderDraftMimeBuilder(f.ports)(f.input),/Revoked/);assert.ok(mime?.every(byte=>byte===0));
});


test('long formatted provider draft preserves exact body and original attachment bytes without sending',async()=>{
 const f=fixture(),body='x'.repeat(96*1024),html='<p><em>'+body+'</em></p>';f.input.draft={...f.input.draft,content:{...f.input.draft.content,body,body_html:html}};
 const value=await createEmailProviderDraftMimeBuilder(f.ports)(f.input),parsed=await simpleParser(value.mime_bytes);assert.equal(parsed.html,html);assert.equal(parsed.text.trimEnd(),body);assert.deepEqual(parsed.attachments[0].content,bytes);value.mime_bytes.fill(0);
});
