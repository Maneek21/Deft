import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailNativeOutgoingSnapshotBuilder } from '../src/lib/email-native-outgoing-snapshot.js';
const { createOutgoingSnapshotService } = await import(new URL('../../../examples/apps/email/outgoing-snapshot.mjs', import.meta.url).href) as any;

const scope = { org_id: 'org_test', owner_user_id: 'user_test', account_id: 'account_test' };
const actor = { user_id: 'user_test', web_session_id: 'session_test', access_expires_at: Date.now() + 60_000 };
const capability = { scope, resource_binding_id: 'binding_test', authority_version: 'version_test', expires_at: Date.now() + 50_000 } as any;
const identity = (provider: 'gmail' | 'microsoft' | 'imap_smtp' = 'gmail') => ({ account_id: scope.account_id, provider, resource_binding_id: 'binding_test', authority_epoch: 4,
  connection_revision: 2, principal_digest: 'a'.repeat(64), health: 'connected', capabilities: ['read', 'send'], primary_address: 'owner@example.test',
  display_label: 'Mailbox', org_id: scope.org_id, owner_user_id: scope.owner_user_id, installation_id: 'install_test', connection_target: 'target_test',
  action_binding_id: 'action_test', verified_sender_identities: ['owner@example.test','team@example.test'] });
const baseContent = (patch: Record<string, unknown> = {}) => ({ mode: 'compose', to: 'Ada Lovelace <ada@example.test>', cc: '', bcc: '', subject: 'A saved draft',
  body: 'Hello, world.', body_html: '', reply_record_id: '', attachments: [], ...patch });
const draft = (content: unknown) => ({ draft_id: 'e4fdb030-330b-4fd6-81fb-e7973865de22', revision: 3, content_revision: 3, status: 'draft',
  content, origin: { kind: 'human', created_by_user_id: scope.owner_user_id, originating_run_id: null }, last_edited_by_user_id: scope.owner_user_id,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) as any;
const recheck = async () => {};

test('owned native inline raster reaches actual MIME across all transports and refuses mismatched pair before attachment reads',async()=>{
 const {simpleParser}=createRequire(new URL('../../../examples/apps/email/package.json',import.meta.url))('mailparser');
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/wAAAABJRU5ErkJggg==','base64');
 const meta={file_id:randomUUID(),filename:'diagram.png',media_type:'image/png',size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const cid=`deft-${meta.file_id}@deft.invalid`,body_html=`<p>Diagram <img src="cid:${cid}" alt="A &amp; B"></p>`,body='Diagram [Image: A & B]';
 for(const provider of ['gmail','microsoft','imap_smtp'] as const){const h=harness(provider,{meta,bytes}),result=await h.prepare(baseContent({body,body_html,attachments:[meta]}));
  const parsed=await simpleParser(Buffer.from(result.mime_bytes!),{keepCidLinks:true});assert.equal(parsed.html,body_html);assert.equal(parsed.text.trimEnd(),body);
  assert.equal(parsed.attachments.length,1);assert.equal(parsed.attachments[0].contentId,`<${cid}>`);assert.equal(parsed.attachments[0].contentDisposition,'inline');assert.deepEqual(parsed.attachments[0].content,bytes);assert.equal(h.calls.reserve,1);result.mime_bytes?.fill(0);
 }
 for(const content of [baseContent({body:'Diagram',body_html,attachments:[meta]}),baseContent({body,body_html,attachments:[]})]){const h=harness('gmail',{meta,bytes});await assert.rejects(h.prepare(content));assert.equal(h.calls.attachment,0);assert.equal(h.calls.reserve,0);}
 const badBytes=Buffer.from('not a PNG image'),badMeta={...meta,size_bytes:badBytes.length,sha256:createHash('sha256').update(badBytes).digest('hex')},bad=harness('gmail',{meta:badMeta,bytes:badBytes});
 await assert.rejects(bad.prepare(baseContent({body,body_html,attachments:[badMeta]})));assert.equal(bad.calls.reserve,0);
});

test('native saved-link projection reaches actual host MIME while unsafe or mismatched pairs reserve nothing',async()=>{
 const {simpleParser}=createRequire(new URL('../../../examples/apps/email/package.json',import.meta.url))('mailparser');
 const html='<p><a href="https://docs.example.test/guide">Read the guide</a></p>',body='Read the guide (https://docs.example.test/guide)';
 for(const provider of ['gmail','microsoft','imap_smtp'] as const){
  const h=harness(provider),result=await h.prepare(baseContent({body,body_html:html})),parsed=await simpleParser(Buffer.from(result.mime_bytes!));
  assert.equal(parsed.html,html);assert.equal(parsed.text?.trimEnd(),body);assert.equal(h.calls.reserve,1);result.mime_bytes?.fill(0);
 }
 for(const patch of [{body:'Read the guide',body_html:html},{body:'bad',body_html:'<p><a href="data:text/plain,bad">bad</a></p>'}]){
  const h=harness();await assert.rejects(h.prepare(baseContent(patch)));assert.equal(h.calls.reserve,0);
 }
});

function harness(provider: 'gmail' | 'microsoft' | 'imap_smtp' = 'gmail', attachment?: { meta: any; bytes: Buffer }, reply?: any, reservation: 'reserved'|'replay'|'unknown' = 'reserved',graphPreparation=false,modify=false) {
  const calls = { reserve: 0, attachment: 0, reply: 0 };
  const builder = createEmailNativeOutgoingSnapshotBuilder({
    createOutgoingSnapshotService: (ports: any) => createOutgoingSnapshotService({ ...ports, profile: 'native' }),
    graphPreparation,
    accounts: { getSendIdentity: async () => ({...identity(provider),capabilities:['read','send',...(modify?['modify']:[])]}) as any },
    attachments: { readForSend: async (_actor, _scope, _draft, _file, expected) => {
      calls.attachment++;
      if (!attachment) throw Error('no attachment');
      assert.deepEqual(expected, attachment.meta);
      return { ...attachment.meta, bytes: Buffer.from(attachment.bytes) };
    } },
    replies: async () => { calls.reply++; if (!reply) throw Error('no reply'); return reply; },
  });
  const prepare = (content: unknown,calendar_reply?:Readonly<{ics_text:string;method:'REPLY'}>) => builder.prepareAndBind({ actor, scope, capability, recheck, draft: draft(content), operation_id: randomUUID(),...(calendar_reply?{calendar_reply}:{}),
    reserve: async () => { calls.reserve++; return reservation; } });
  return { calls, prepare };
}
test('host calendar response serializer emits exact METHOD REPLY and rejects changed recipient/attendee before reservation',async()=>{
 const ics='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nUID:reviewed-invitation\r\nDTSTAMP:20261004T120000Z\r\nSEQUENCE:2\r\nDTSTART:20261005T120000Z\r\nDTEND:20261005T130000Z\r\nORGANIZER:mailto:organizer@example.test\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:owner@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
 const h=harness(),value=await h.prepare(baseContent({to:'organizer@example.test'}),{ics_text:ics,method:'REPLY'});
 const {inspectEmailSourceFiles}=await import(new URL('../../../examples/apps/email/providers/incoming-source-files.mjs',import.meta.url).href);const parsed=await inspectEmailSourceFiles(value.mime_bytes!,{calendar_parts:true});
 assert.equal(parsed.calendar_parts.parts.length,1);assert.equal(parsed.calendar_parts.parts[0].ics_text,ics);assert.equal(parsed.calendar_parts.parts[0].media_type_method,'REPLY');assert.equal(h.calls.reserve,1);value.mime_bytes!.fill(0);
 for(const [content,text]of [[baseContent({to:'attacker@example.test'}),ics],[baseContent({to:'organizer@example.test',bcc:'extra@example.test'}),ics],[baseContent({to:'organizer@example.test'}),ics.replace('owner@example.test','unverified@example.test')],[baseContent({to:'organizer@example.test'}),ics.replace('METHOD:REPLY','METHOD:REQUEST')]]){
  const denied=harness();await assert.rejects(denied.prepare(content,{ics_text:text as string,method:'REPLY'}));assert.equal(denied.calls.reserve,0);
 }
});

test('builds provider-ready MIME from saved draft and returns reduced server transport', async () => {
  const h = harness();
  const result = await h.prepare(baseContent());
  assert.equal(result.state, 'reserved');
  assert.equal(h.calls.reserve, 1);
  assert.equal((result.transport as any).from_address, 'owner@example.test');
  assert.equal((result.transport as any).transport_kind, 'gmail_raw');
  assert.equal('envelope' in (result.transport as any), false);
  assert.equal((result.mime_bytes as Uint8Array).length > 100, true);
  result.mime_bytes?.fill(0);
});
test('held snapshot verification refuses implementation change before reservation',async()=>{
 let identityCalls=0,reservations=0;
 const builder=createEmailNativeOutgoingSnapshotBuilder({createOutgoingSnapshotService:(ports:any)=>createOutgoingSnapshotService({...ports,profile:'native'}),accounts:{getSendIdentity:async()=>({...identity(),implementation_digest:(++identityCalls===1?'b':'c').repeat(64)}) as any},attachments:{readForSend:async()=>{throw Error('No attachment');}},replies:async()=>{throw Error('No reply');}});
 await assert.rejects(builder.prepareAndBind({actor,scope,capability,recheck,draft:draft(baseContent()),operation_id:randomUUID(),reserve:async()=>{reservations++;return 'reserved';}}));assert.equal(reservations,0);assert.ok(identityCalls>=2);
});

test('selected From is current verified identity for MIME and SMTP envelope; unverified choice fails before reservation', async()=>{
  const smtp=harness('imap_smtp');
  const result=await smtp.prepare(baseContent({from_identity:{address:'team@example.test'},bcc:'blind@example.test'}));
  assert.equal((result.transport as any).from_address,'team@example.test');
  assert.deepEqual((result.transport as any).envelope,{from:'team@example.test',to:['ada@example.test','blind@example.test']});
  assert.match(Buffer.from(result.mime_bytes!).toString('latin1'),/From: team@example\.test/u);
  result.mime_bytes?.fill(0);
  const denied=harness('gmail');
  await assert.rejects(()=>denied.prepare(baseContent({from_identity:{address:'spoof@example.test'}})),{code:'EMAIL_SEND_SENDER_UNAVAILABLE'});
  assert.equal(denied.calls.reserve,0);
});

test('uses private reply resolver metadata and retains the Gmail thread id internally', async () => {
  const reply = { account_id: scope.account_id, provider: 'gmail', logical_message_id: 'mail_' + 'b'.repeat(64),
    message_id: '<parent@example.test>', references: ['<root@example.test>'], from: 'Rae <rae@example.test>', to: 'owner@example.test', cc: '',
    reply_to: '', thread_id: 'thread_private_1' };
  const h = harness('gmail', undefined, reply);
  const result = await h.prepare(baseContent({ mode: 'reply', reply_record_id: reply.logical_message_id }));
  assert.equal(h.calls.reply, 2);
  assert.equal((result.transport as any).thread_id, 'thread_private_1');
  result.mime_bytes?.fill(0);
});

test('includes verified durable attachment bytes, while mismatch fails before reservation', async () => {
  const bytes = Buffer.from('attachment bytes');
  const meta = { file_id: randomUUID(), filename: 'notes.txt', media_type: 'text/plain', size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const h = harness('gmail', { meta, bytes });
  const result = await h.prepare(baseContent({ attachments: [meta] }));
  assert.equal(h.calls.attachment, 1);
  assert.equal(h.calls.reserve, 1);
  result.mime_bytes?.fill(0);

  const bad = harness('gmail', { meta, bytes: Buffer.from('changed') });
  await assert.rejects(() => bad.prepare(baseContent({ attachments: [meta] })), { code: 'EMAIL_SEND_ATTACHMENT_UNAVAILABLE' });
  assert.equal(bad.calls.reserve, 0);
});

test('enforces the Graph direct MIME limit before reservation', async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 128, 0x61);
  const meta = { file_id: randomUUID(), filename: 'payload.bin', media_type: 'application/octet-stream', size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const h = harness('microsoft', { meta, bytes });
  await assert.rejects(() => h.prepare(baseContent({ attachments: [meta] })), { code: 'EMAIL_SEND_LIMIT_EXCEEDED' });
  assert.equal(h.calls.reserve, 0);
});

test('large Graph MIME requires both a host Outbox preparation capability and current modify scope',async()=>{
  const bytes=Buffer.alloc(3*1024*1024+128,0x62),meta={file_id:randomUUID(),filename:'report.bin',media_type:'application/octet-stream',size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const content=baseContent({attachments:[meta]});
  const noModify=harness('microsoft',{meta,bytes},undefined,'reserved',true,false);
  await assert.rejects(()=>noModify.prepare(content),{code:'EMAIL_SEND_LIMIT_EXCEEDED'});
  assert.equal(noModify.calls.reserve,0);
  const prepared=harness('microsoft',{meta,bytes},undefined,'reserved',true,true);
  const result=await prepared.prepare(content);
  assert.equal(result.state,'reserved');assert.ok(result.mime_bytes!.length>3*1024*1024);
  assert.equal((result.transport as any).transport_kind,'graph_raw');assert.equal(prepared.calls.reserve,1);
  result.mime_bytes?.fill(0);
});

test('prepared Graph budget includes base64 attachment expansion plus the saved body',async()=>{
  const bytes=Buffer.alloc(25*1024*1024,0x63),meta={file_id:randomUUID(),filename:'largest-report.bin',media_type:'application/octet-stream',size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const prepared=harness('microsoft',{meta,bytes},undefined,'reserved',true,true);
  const result=await prepared.prepare(baseContent({attachments:[meta],body:'A'.repeat(256*1024)}));
  assert.ok(result.mime_bytes!.length>34*1024*1024);assert.ok(result.mime_bytes!.length<=35*1024*1024);
  assert.equal(prepared.calls.reserve,1);result.mime_bytes?.fill(0);
});

test('refuses a reply draft when its native source cannot be freshly resolved', async () => {
  const h = harness();
  await assert.rejects(() => h.prepare(baseContent({ mode: 'reply', reply_record_id: 'mail_' + 'c'.repeat(64) })),
    { code: 'EMAIL_SEND_REPLY_UNAVAILABLE' });
  assert.equal(h.calls.reserve, 0);
});

test('lost reservation returns no prepared transport and is classified as non-replayable', async () => {
  const h = harness('gmail', undefined, undefined, 'unknown');
  await assert.rejects(() => h.prepare(baseContent()), { code: 'EMAIL_SEND_UNKNOWN' });
  assert.equal(h.calls.reserve, 1);
});

test('native SMTP binds Bcc only into the trusted envelope and never serializes it into MIME', async () => {
  const h = harness('imap_smtp');
  const result = await h.prepare(baseContent({ cc: 'copy@example.test', bcc: 'blind@example.test' }));
  const transport = result.transport as any;
  assert.deepEqual(transport.envelope, { from: 'owner@example.test', to: ['ada@example.test', 'copy@example.test', 'blind@example.test'] });
  const mime = Buffer.from(result.mime_bytes!).toString('latin1');
  assert.equal(mime.includes('Bcc:'), false);
  assert.equal(mime.includes('blind@example.test'), false);
  result.mime_bytes?.fill(0);
});


test('native 220 KiB rich body reaches actual MIME through both snapshot parse stages without a policy bump',async()=>{
 const {simpleParser}=createRequire(new URL('../../../examples/apps/email/package.json',import.meta.url))('mailparser');
 const text='x'.repeat(220*1024),html='<p><strong>'+text+'</strong></p>',h=harness();
 const result=await h.prepare(baseContent({body:text,body_html:html})),parsed=await simpleParser(Buffer.from(result.mime_bytes!));
 assert.equal(parsed.html,html);assert.equal(parsed.text?.trimEnd(),text);assert.equal(h.calls.reserve,1);result.mime_bytes!.fill(0);
 const wrong=harness();await assert.rejects(wrong.prepare(baseContent({body:text+'!',body_html:html})));assert.equal(wrong.calls.reserve,0);
});
