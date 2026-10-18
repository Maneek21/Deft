import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
const {createOutgoingSnapshotService,serializeNativeDraft}=await import(process.env.EMAIL_INLINE_OUTGOING_BASELINE??new URL('./outgoing-snapshot.mjs',import.meta.url).href);
import {validMessageImage,validNativeOutgoingImage} from './providers/remote-image-proxy.mjs';
import {readDraftContent} from './providers/native-draft-content.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wAAAABJRU5ErkJggg==','base64');
const fileId='12345678-1234-4234-8234-123456789abc',draftId='22345678-1234-4234-8234-123456789abc',cid=`deft-${fileId}@deft.invalid`;
function fixture(provider='gmail'){
 const scope={org_id:'synthetic-org',owner_id:'synthetic-owner',installation_id:'synthetic-install'},account_id='synthetic-account';
 const file=(id,filename,media_type,bytes)=>({file_id:id,account_id,...scope,parent:{kind:'draft',id:draftId},availability:'ready',filename,media_type,
  byte_count:bytes.length,digest:hash(bytes),expires_at:'9999-12-31T23:59:59.999Z',bytes});
 return {scope,account_id,authority_epoch:1,provider,verified_from:[{address:'owner@example.test',display_name:''}],captured_at:'2026-10-08T01:00:00.000Z',message_id:'<synthetic-inline@deft.invalid>',
  limits:{max_recipients:200,max_body_bytes:1024*1024,max_files:32,max_file_bytes:25*1024*1024,max_total_file_bytes:25*1024*1024,max_mime_bytes:35*1024*1024,allowed_media_types:['image/png','text/plain']},
  draft:{account_id,draft_id:draftId,revision:3,mode:'compose',from:{address:'owner@example.test',display_name:''},to:[{address:'recipient@example.test',display_name:''}],cc:[],bcc:[],subject:'Owned image',
   body_format:'safe_html',body_bytes:Buffer.from('Diagram [Image: A & B]'),body_html_bytes:Buffer.from(`<p>Diagram <img src="cid:${cid}" alt="A &amp; B"></p>`),reply_parent:null,
   files:[file(fileId,'diagram.png','image/png',Buffer.from(png)),file('32345678-1234-4234-8234-123456789abc','notes.txt','text/plain',Buffer.from('Exact unrelated attachment'))]}};
}
const reference=value=>({account_id:value.account_id,draft_id:value.draft.draft_id,expected_revision:value.draft.revision});
function host(value,profile='native'){
 const calls={seal:0,verify:0,reserve:0};let retained;
 const service=createOutgoingSnapshotService({profile,resolve:async()=>value,seal:async view=>{calls.seal++;retained=view.payload_digest;return {snapshot_id:'snapshot',sealed_contract:'seal'};},
  verify:async view=>{calls.verify++;return view.payload_digest===retained;},reserve:async()=>{calls.reserve++;return 'reserved';}});
 return {service,calls};
}
test('native CID images compile as related scoped MIME exactly once across Gmail/Graph/SMTP and provider-draft storage',async()=>{
 for(const provider of ['gmail','microsoft','imap_smtp']){
  const value=fixture(provider),h=host(value),snapshot=await h.service.prepare(reference(value)),bound=await h.service.bind(snapshot,{operation_id:'operation',expected_digest:snapshot.payload_digest});
  const stored=await serializeNativeDraft(value,reference(value));
  for(const bytes of [snapshot.mime_bytes,bound.mime_bytes,stored.mime_bytes]){
   const raw=Buffer.from(bytes).toString('latin1'),parsed=await simpleParser(bytes,{keepCidLinks:true});
   assert.match(raw,/multipart\/related/u);assert.equal(parsed.html,value.draft.body_html_bytes.toString());assert.equal(parsed.text.trimEnd(),value.draft.body_bytes.toString());
   assert.equal(parsed.attachments.length,2);const inline=parsed.attachments.find(file=>file.contentId?.replace(/^<|>$/gu,'')===cid),ordinary=parsed.attachments.find(file=>file.filename==='notes.txt');
   assert.equal(inline.contentDisposition,'inline');assert.deepEqual(inline.content,png);assert.equal(inline.checksum,createHash('md5').update(png).digest('hex'));
   assert.equal(ordinary.contentDisposition,'attachment');assert.equal(ordinary.contentId,undefined);assert.equal(ordinary.content.toString(),'Exact unrelated attachment');
   assert.equal(raw.split(`Content-ID: <${cid}>`).length-1,1);
  }
  assert.equal(h.calls.reserve,1);snapshot.dispose();stored.mime_bytes.fill(0);
 }
 const legacy=host(fixture(),'legacy');await assert.rejects(legacy.service.prepare(reference(fixture())));assert.equal(legacy.calls.seal,0);
});
test('existing provider mirror canonical parser retains local CID identity, disposition, digest and mixed attachment multiplicity',async()=>{
 const value=fixture('microsoft'),stored=await serializeNativeDraft(value,reference(value)),parsed=await readDraftContent(stored.mime_bytes,{keepAttachmentBytes:true});
 assert.equal(parsed.canonical.html,value.draft.body_html_bytes.toString());assert.equal(parsed.canonical.text,value.draft.body_bytes.toString());
 const inline=parsed.canonical.attachments.find(file=>file.content_id===cid);assert.deepEqual(inline,{name:'diagram.png',content_type:'image/png',disposition:'inline',content_id:cid,content_digest:hash(png)});
 const ordinary=parsed.canonical.attachments.find(file=>file.name==='notes.txt');assert.equal(ordinary.disposition,'attachment');assert.equal(ordinary.content_id,'');
 assert.deepEqual(parsed.parts.find(file=>file.content_id===cid).bytes,new Uint8Array(png));assert.equal(parsed.parts.length,2);for(const part of parsed.parts)part.bytes.fill(0);stored.mime_bytes.fill(0);
});
test('native inline invalid binding/pair/magic is rejected before seal; ordinary raster attachments remain unchanged',async()=>{
 const patches=[value=>value.draft.files[0].file_id='foreign',value=>value.draft.files[0].media_type='text/plain',value=>value.draft.files[0].account_id='foreign',value=>{value.draft.files[0].bytes=Buffer.from('not a PNG image');value.draft.files[0].digest=hash(value.draft.files[0].bytes);value.draft.files[0].byte_count=value.draft.files[0].bytes.length;},value=>value.draft.body_bytes=Buffer.from('Diagram'),value=>value.draft.body_html_bytes=Buffer.from(`<p><img src="https://example.test/a" alt="A"></p>`)];
 for(const patch of patches){const value=fixture();patch(value);const h=host(value);await assert.rejects(h.service.prepare(reference(value)));assert.equal(h.calls.seal,0);assert.equal(h.calls.reserve,0);}
 const value=fixture();value.draft.body_html_bytes=Buffer.from('<p>Diagram</p>');value.draft.body_bytes=Buffer.from('Diagram');const h=host(value),snapshot=await h.service.prepare(reference(value));
 const parsed=await simpleParser(snapshot.mime_bytes);assert.equal(parsed.attachments[0].contentDisposition,'attachment');assert.equal(parsed.attachments[0].contentId,undefined);snapshot.dispose();
});
test('final bind independently rejects consistently rehashed crossed CID, invalid raster and message-parent transplant before verify/reserve',async()=>{
 for(const mutation of ['cid','raster','parent']){
  const value=fixture(),h=host(value),snapshot=await h.service.prepare(reference(value)),changed={...snapshot,payload:structuredClone(snapshot.payload),mime_bytes:snapshot.mime_bytes,body_bytes:snapshot.body_bytes,body_html_bytes:snapshot.body_html_bytes,file_bytes:snapshot.file_bytes};
  if(mutation==='cid'){changed.body_html_bytes=Buffer.from(value.draft.body_html_bytes.toString().replace(cid,'deft-42345678-1234-4234-8234-123456789abc@deft.invalid'));changed.payload.body.html={byte_count:changed.body_html_bytes.length,digest:hash(changed.body_html_bytes)};}
  if(mutation==='raster'){changed.file_bytes=[Buffer.from('not a raster'),changed.file_bytes[1]];changed.payload.files[0].digest=hash(changed.file_bytes[0]);changed.payload.files[0].byte_count=changed.file_bytes[0].length;}
  if(mutation==='parent')changed.payload.files[0].parent={kind:'message',id:'received-message'};
  changed.payload_digest=hash(canonical(changed.payload));await assert.rejects(h.service.bind(changed,{operation_id:'operation',expected_digest:changed.payload_digest}),error=>error.code==='OUTGOING_SNAPSHOT_BYTES_CHANGED');
  assert.equal(h.calls.verify,0);assert.equal(h.calls.reserve,0);snapshot.dispose();
 }
});
test('outgoing fixed raster profile permits larger valid dimensions/files without changing received limits and rejects animation/overflow',()=>{
 assert.equal(validNativeOutgoingImage(png,'image/png'),true);assert.equal(validMessageImage(png,'image/png'),true);
 const dimension=(width,height)=>{const bytes=Buffer.from(png);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);return bytes;};
 for(const [width,height]of [[8192,1],[4000,4000],[5000,800]])assert.equal(validNativeOutgoingImage(dimension(width,height),'image/png'),true);
 assert.equal(validMessageImage(dimension(5000,800),'image/png'),false);
 for(const [width,height]of [[8193,1],[4000,4001],[0,1]])assert.equal(validNativeOutgoingImage(dimension(width,height),'image/png'),false);
 // Valid chunk framing is retained while payload bytes are opaque to this
 // bounded header/magic check (not a complete codec decoder).
 const large=Buffer.alloc(2*1024*1024+33);png.copy(large,0,0,33);large.writeUInt32BE(large.length-45,33);large.write('IDAT',37);large.writeUInt32BE(0,large.length-12);large.write('IEND',large.length-8);
 assert.equal(validNativeOutgoingImage(large,'image/png'),true);assert.equal(validMessageImage(large,'image/png'),false);
 assert.equal(validNativeOutgoingImage(Buffer.alloc(25*1024*1024+1),'image/png'),false);
 const animated=Buffer.from(png);animated.write('acTL',37);assert.equal(validNativeOutgoingImage(animated,'image/png'),false);
 assert.equal(validNativeOutgoingImage(png,'image/jpeg'),false);assert.equal(validNativeOutgoingImage(png,'image/svg+xml'),false);
});
