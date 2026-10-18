import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {createOutgoingSnapshotService,replyRecipients,typedMailbox,serializeNativeDraft} from './outgoing-snapshot.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const fixture=name=>readFile(new URL(`./fixtures/launch-stage0/${name}`,import.meta.url));
const typed=address=>({address,display_name:''});
const addresses=value=>(value?.value??[]).map(row=>({address:row.address,display_name:row.name??''}));
const scope={org_id:'synthetic-org',owner_id:'synthetic-owner',installation_id:'synthetic-email-installation'};
const now='2026-09-30T12:00:00.000Z';
const policy={max_recipients:20,max_body_bytes:65536,max_files:4,max_file_bytes:1048576,max_total_file_bytes:2097152,max_mime_bytes:4194304,allowed_media_types:['application/pdf','text/plain']};
const reference=context=>({account_id:context.account_id,draft_id:context.draft.draft_id,expected_revision:context.draft.revision});
const operation=snapshot=>({operation_id:'synthetic-operation',expected_digest:snapshot.payload_digest});
const errorCode=code=>error=>error.code===code;

test('native descriptive links survive prepare, final bind and provider-draft MIME with exact projections; legacy remains closed',async()=>{
 const [context]=await contexts();
 context.draft.body_format='safe_html';context.draft.body_bytes=Buffer.from('Read the guide (https://intranet.test/guide?x=1&y=2).\nContact (mailto:team@example.test)');
 context.draft.body_html_bytes=Buffer.from('<p>Read <a href="https://intranet.test/guide?x=1&amp;y=2"><strong>the guide</strong></a>.</p><p><a href="mailto:team@example.test">Contact</a></p>');
 const legacy=fixtureHost([context]);await assert.rejects(legacy.service.prepare(reference(context)),errorCode('OUTGOING_BODY_INVALID'));assert.equal(legacy.counts.seal,0);assert.equal(legacy.counts.reserve,0);
 const native=fixtureHost([context],{profile:'native'}),snapshot=await native.service.prepare(reference(context));
 const bound=await native.service.bind(snapshot,operation(snapshot));assert.equal(native.counts.reserve,1);
 for(const value of [snapshot,bound,await serializeNativeDraft(context,reference(context))]){
  const parsed=await simpleParser(value.mime_bytes);assert.equal(parsed.html,context.draft.body_html_bytes.toString());
  assert.equal(parsed.text.trimEnd(),context.draft.body_bytes.toString());assert.deepEqual(parsed.attachments[0].content,context.draft.files[0].bytes);
 }
 assert.equal(snapshot.payload.body.digest,digest(context.draft.body_bytes));assert.equal(snapshot.payload.body.html.digest,digest(context.draft.body_html_bytes));
});

test('native descriptive links reject unsafe or mismatched pairs before sealing and independently before final reservation',async()=>{
 const [base]=await contexts();
 for(const [html,text]of [['<p><a href="javascript:alert(1)">bad</a></p>','bad'],['<p><a href="https://user:pass@example.test/">bad</a></p>','bad'],['<p><a href="https://example.test/">Guide</a></p>','Guide'],['<p><a href="https://example.test/" title="extra">Guide</a></p>','Guide (https://example.test/)'],['<p>'+'x'.repeat(262_145)+'</p>','x'.repeat(262_145)]]){
  const context=structuredClone(base);context.draft.body_format='safe_html';context.draft.body_html_bytes=Buffer.from(html);context.draft.body_bytes=Buffer.from(text);context.limits.max_body_bytes=1048576;
  const host=fixtureHost([context],{profile:'native'});await assert.rejects(host.service.prepare(reference(context)),errorCode('OUTGOING_BODY_INVALID'));assert.equal(host.counts.seal,0);assert.equal(host.counts.reserve,0);
 }
 const valid=structuredClone(base);valid.draft.body_format='safe_html';valid.draft.body_html_bytes=Buffer.from('<p><a href="https://example.test/">Guide</a></p>');valid.draft.body_bytes=Buffer.from('Guide (https://example.test/)');
 const host=fixtureHost([valid],{profile:'native'}),snapshot=await host.service.prepare(reference(valid));
 // A consistently rehashed caller pair still has to pass the strict grammar
 // before host verification or reservation, independently of digest custody.
 const changed={...snapshot,payload:structuredClone(snapshot.payload),body_bytes:Buffer.from('Guide')};
 changed.payload.body.digest=digest(changed.body_bytes);changed.payload.body.byte_count=changed.body_bytes.length;
 changed.payload_digest=digest(canonical(changed.payload));
 await assert.rejects(host.service.bind(changed,operation(changed)),errorCode('OUTGOING_SNAPSHOT_BYTES_CHANGED'));
 assert.equal(host.counts.verify,0);assert.equal(host.counts.reserve,0);
});

test('provider draft serializer accepts empty compose recipients and preserves Bcc and exact attachments without Send reservation',async()=>{
 const [context]=await contexts();context.draft.mode='compose';context.draft.reply_parent=null;
 for(const file of context.draft.files)file.parent={kind:'draft',id:context.draft.draft_id};
 context.draft.to=[];context.draft.cc=[];context.draft.bcc=[];context.draft.subject='';context.draft.body_bytes=Buffer.alloc(0);
 const empty=await serializeNativeDraft(context,reference(context)),parsed=await simpleParser(empty.mime_bytes);
 assert.equal(parsed.to,undefined);assert.deepEqual(parsed.attachments[0].content,context.draft.files[0].bytes);assert.equal(empty.mime_digest,digest(empty.mime_bytes));
 await assert.rejects(fixtureHost([context]).service.prepare(reference(context)),errorCode('OUTGOING_RECIPIENT_LIMIT'));
 context.draft.bcc=[typed('hidden@example.test')];const bcc=await serializeNativeDraft(context,reference(context));
 assert.deepEqual(addresses((await simpleParser(bcc.mime_bytes)).bcc),context.draft.bcc);
 await assert.rejects(serializeNativeDraft(context,{...reference(context),expected_revision:999}),errorCode('OUTGOING_DRAFT_STALE'));
 context.draft.files[0].account_id='foreign';await assert.rejects(serializeNativeDraft(context,reference(context)),errorCode('OUTGOING_FILE_PROVENANCE_DENIED'));
 empty.mime_bytes.fill(0);bcc.mime_bytes.fill(0);
});

test('canonical rich MIME retains independent exact HTML/plain digests and denies substitution before reservation',async()=>{
 const [context]=await contexts();context.draft.body_format='safe_html';context.draft.body_bytes=Buffer.from('Hello team\nOne\n- Item');
 context.draft.body_html_bytes=Buffer.from('<p>Hello <strong>team</strong><br>One</p><ul><li><p>Item</p></li></ul>');
 const host=fixtureHost([context]),snapshot=await host.service.prepare(reference(context)),parsed=await simpleParser(snapshot.mime_bytes);
 assert.equal(parsed.html,context.draft.body_html_bytes.toString());assert.equal(parsed.text.trimEnd(),context.draft.body_bytes.toString());assert.deepEqual(parsed.attachments[0].content,context.draft.files[0].bytes);
 assert.equal(snapshot.payload.body.html.digest,digest(context.draft.body_html_bytes));assert.equal(snapshot.payload.body.digest,digest(context.draft.body_bytes));
 assert.deepEqual((await host.service.prepare(reference(context))).mime_bytes,snapshot.mime_bytes);const copy=snapshot.body_html_bytes;copy.fill(0);assert.equal(digest(snapshot.body_html_bytes),snapshot.payload.body.html.digest);
 for(const key of ['body_html_bytes','body_bytes']){const changed={...snapshot};changed[key]=Buffer.from(changed[key]);changed[key][0]^=1;await assert.rejects(host.service.bind(changed,operation(snapshot)),errorCode('OUTGOING_SNAPSHOT_BYTES_CHANGED'));}
 assert.equal(host.counts.reserve,0);assert.deepEqual((await host.service.bind(snapshot,operation(snapshot))).mime_bytes,snapshot.mime_bytes);
});
test('Gmail reply transport takes its exact thread only from the immutable trusted parent; Forward cannot inherit it',async()=>{
 const [context]=await contexts(),host=fixtureHost([context]),snapshot=await host.service.prepare(reference(context));
 assert.equal(snapshot.payload.reply_parent.thread_id,context.draft.reply_parent.thread_id);
 const changed={...snapshot,payload:structuredClone(snapshot.payload)};changed.payload.reply_parent.thread_id='foreign-thread';
 await assert.rejects(host.service.bind(changed,operation(snapshot)),errorCode('OUTGOING_SNAPSHOT_CHANGED'));assert.equal(host.counts.reserve,0);
 assert.equal((await host.service.bind(snapshot,operation(snapshot))).thread_id,context.draft.reply_parent.thread_id);
 const absent=structuredClone(context);delete absent.draft.reply_parent.thread_id;
 await assert.rejects(fixtureHost([absent]).service.prepare(reference(absent)),errorCode('OUTGOING_REFERENCE_INVALID'));
 const forward=structuredClone(context);forward.draft.mode='forward';forward.draft.reply_parent=null;forward.draft.files.forEach(file=>{file.parent={kind:'draft',id:forward.draft.draft_id};});
 const forwarded=fixtureHost([forward]),forwardSnapshot=await forwarded.service.prepare(reference(forward));
 assert.equal((await forwarded.service.bind(forwardSnapshot,operation(forwardSnapshot))).thread_id,undefined);
});

test('unsafe or mismatched rich content and hidden HTML in plain mode cannot be retained',async()=>{
 const [base]=await contexts();for(const html of ['<p>Different</p>','<p onclick="x">Hello</p>','<p><img src="https://remote.test"></p>']){
  const context=structuredClone(base);context.draft.body_format='safe_html';context.draft.body_html_bytes=Buffer.from(html);const host=fixtureHost([context]);
  await assert.rejects(host.service.prepare(reference(context)),errorCode('OUTGOING_BODY_INVALID'));assert.equal(host.counts.seal,0);
 }
 const plain=structuredClone(base);plain.draft.body_html_bytes=Buffer.from('<p>Hidden</p>');await assert.rejects(fixtureHost([plain]).service.prepare(reference(plain)),errorCode('OUTGOING_BODY_FORMAT_INVALID'));
});

async function contexts(){
 const [pdf,personal,work]=await Promise.all([fixture('synthetic-brief.pdf'),fixture('gmail-personal-inbox.eml').then(simpleParser),fixture('gmail-work-inbox.eml').then(simpleParser)]);
 assert.equal(digest(pdf),'7dcd3e988227137bbea91d996b903482a80f1f49ca3fdebd5ad6db9242b6669f');
 return [personal,work].map((parsed,index)=>{
  const accountId=index?'gmail-work':'gmail-personal',owner=index?'work@example.test':'personal@example.test';
  const ownAliases=[typed(owner),typed(`${index?'work':'personal'}-alias@example.test`)];
  const parent={reply_to:addresses(parsed.replyTo),from:addresses(parsed.from),to:addresses(parsed.to),cc:[...addresses(parsed.cc),typed(owner.toUpperCase()),...ownAliases]};
  Object.defineProperty(parent,'bcc',{get(){throw Error('received Bcc must never be read');}});
  const selected=replyRecipients(parent,ownAliases,{all:true,maxRecipients:policy.max_recipients});
  const draftId=`draft-${accountId}`,logicalId=`message-${accountId}`;
  return {scope:{...scope},account_id:accountId,authority_epoch:7,provider:'gmail',verified_from:[{address:owner,display_name:index?'Synthetic Work':'Synthetic Personal'}],own_addresses:ownAliases,
   captured_at:now,message_id:`<outgoing-${accountId}@example.test>`,limits:structuredClone(policy),draft:{account_id:accountId,draft_id:draftId,revision:3,mode:'reply_all',
    from:{address:owner,display_name:index?'Synthetic Work':'Synthetic Personal'},to:structuredClone(selected.to),cc:structuredClone(selected.cc),bcc:[typed('blind-copy@example.test')],
    subject:`Re: ${parsed.subject}`,body_format:'plain',body_bytes:Buffer.from('I reviewed the synthetic brief.\nThe PDF is attached.\n','utf8'),
    reply_parent:{account_id:accountId,org_id:scope.org_id,owner_id:scope.owner_id,logical_message_id:logicalId,message_id:parsed.messageId,thread_id:`thread-${accountId}`,references:['<earlier@example.test>']},
    files:[{file_id:`file-${accountId}`,account_id:accountId,org_id:scope.org_id,owner_id:scope.owner_id,parent:{kind:'message',id:logicalId},availability:'ready',
     filename:'synthetic-brief.pdf',media_type:'application/pdf',byte_count:pdf.byteLength,digest:digest(pdf),bytes:Buffer.from(pdf),expires_at:'2026-10-01T12:00:00.000Z'}]}};
 });
}

test('native profile expands durable draft header/file bounds while legacy defaults stay fixed',async()=>{
 const [base]=await contexts(),native=structuredClone(base);native.draft.subject='s'.repeat(201);native.draft.files[0].filename=`${'n'.repeat(201)}.pdf`;
 const legacy=fixtureHost([native]);await assert.rejects(legacy.service.prepare(reference(native)),errorCode('OUTGOING_SUBJECT_INVALID'));
 const selected=fixtureHost([native],{profile:'native'}),snapshot=await selected.service.prepare(reference(native));
 assert.equal(snapshot.payload.subject.length,201);assert.equal(snapshot.payload.files[0].filename.length,205);
 const blank=structuredClone(base);blank.draft.subject='';assert.equal((await fixtureHost([blank],{profile:'native'}).service.prepare(reference(blank))).payload.subject,'');
});

// Synthetic fixture only. Production custody, keys and current authority must
// come from the host; importing the author module supplies none of them.
function fixtureHost(initial,{verifyHook,reserveState,profile='legacy'}={}){
 const current=new Map(initial.map(context=>[context.account_id,structuredClone(context)])),sealed=new Map(),operations=new Map(),drafts=new Map();
 const counts={resolve:0,seal:0,verify:0,reserve:0};let sequence=0;
 const sign=(id,payloadDigest)=>createHmac('sha256','synthetic-fixture-host-key').update(`${id}:${payloadDigest}`).digest('hex');
 const service=createOutgoingSnapshotService({profile,
  resolve:async ref=>{counts.resolve++;const context=current.get(ref.account_id);if(!context)throw Error('fixture account denied');return structuredClone(context);},
  seal:async retained=>{counts.seal++;const snapshotId=`synthetic-snapshot-${++sequence}`;sealed.set(snapshotId,structuredClone(retained));return {snapshot_id:snapshotId,sealed_contract:sign(snapshotId,retained.payload_digest)};},
  verify:async proposed=>{
   counts.verify++;const retained=sealed.get(proposed.snapshot_id),context=current.get(proposed.payload.account_id);
   if(!retained||proposed.sealed_contract!==sign(proposed.snapshot_id,retained.payload_digest)||proposed.payload_digest!==retained.payload_digest
    ||JSON.stringify(proposed.payload)!==JSON.stringify(retained.payload)||!context||context.revoked||context.authority_epoch!==proposed.payload.authority_epoch
    ||context.draft.revision!==proposed.payload.draft_revision||JSON.stringify(context.scope)!==JSON.stringify(proposed.payload.scope))return false;
   if(verifyHook)await verifyHook();return true;
  },
  reserve:async identity=>{
   counts.reserve++;if(reserveState){if(reserveState==='throws')throw Error('fixture custody unavailable');return reserveState;}
   const context=current.get(identity.account_id);
   if(!context||context.revoked||context.authority_epoch!==identity.authority_epoch||context.draft.revision!==identity.draft_revision||JSON.stringify(context.scope)!==JSON.stringify(identity.scope))return 'unknown';
   const encoded=JSON.stringify(identity),existing=operations.get(identity.operation_id),draftKey=JSON.stringify([identity.scope,identity.account_id,identity.draft_id,identity.draft_revision]);
   if(existing)return existing===encoded?'replay':'unknown';
   if(drafts.has(draftKey))return 'unknown';
   operations.set(identity.operation_id,encoded);drafts.set(draftKey,identity.snapshot_id);return 'reserved';
  },
 });
 return {service,current,counts,sealed,operations};
}

test('two synthetic accounts freeze Reply all, verified From, exact PDF and MIME bytes',async()=>{
 const inputs=await contexts(),host=fixtureHost(inputs);
 for(const [index,context] of inputs.entries()){
  const snapshot=await host.service.prepare(reference(context)),parsed=await simpleParser(snapshot.mime_bytes);
  assert.equal(snapshot.payload.account_id,context.account_id);assert.deepEqual(snapshot.payload.scope,scope);
  assert.equal(snapshot.payload.draft_revision,3);assert.equal(snapshot.payload.mode,'reply_all');assert.deepEqual(snapshot.payload.verified_from,context.draft.from);
  assert.deepEqual(addresses(parsed.from),[context.draft.from]);assert.deepEqual(addresses(parsed.to),context.draft.to);assert.deepEqual(addresses(parsed.cc),context.draft.cc);
  assert.equal(parsed.inReplyTo,context.draft.reply_parent.message_id);assert.deepEqual(parsed.references,['<earlier@example.test>',context.draft.reply_parent.message_id]);
  assert.equal(parsed.html,false);assert.equal(parsed.text.replace(/\r\n/gu,'\n'),context.draft.body_bytes.toString('utf8'));
  assert.equal(parsed.attachments.length,1);assert.equal(parsed.attachments[0].contentType,'application/pdf');assert.deepEqual(parsed.attachments[0].content,context.draft.files[0].bytes);
  assert.equal(snapshot.payload.files[0].digest,digest(parsed.attachments[0].content));assert.equal(snapshot.payload.body.digest,digest(context.draft.body_bytes));
  assert.equal(snapshot.mime_digest,digest(snapshot.mime_bytes));assert.equal(snapshot.payload.mime.byte_count,snapshot.mime_bytes.byteLength);
  assert.ok(Object.isFrozen(snapshot.payload.files[0].parent));assert.throws(()=>{snapshot.payload.subject='mutated';},TypeError);
  const exposed=snapshot.mime_bytes;exposed.fill(0);assert.equal(digest(snapshot.mime_bytes),snapshot.mime_digest);
  const files=snapshot.file_bytes;files[0].fill(0);assert.equal(digest(snapshot.file_bytes[0]),snapshot.payload.files[0].digest);
  const body=snapshot.body_bytes;body.fill(0);assert.equal(digest(snapshot.body_bytes),snapshot.payload.body.digest);
  const repeated=await host.service.prepare(reference(context));assert.notEqual(repeated.snapshot_id,snapshot.snapshot_id);assert.equal(repeated.payload_digest,snapshot.payload_digest);assert.deepEqual(repeated.mime_bytes,snapshot.mime_bytes);
  const packet=await host.service.bind(snapshot,{operation_id:`operation-${index}`,expected_digest:snapshot.payload_digest});
  assert.equal(packet.transport_kind,'gmail_raw');assert.equal(packet.account_id,context.account_id);assert.equal(packet.from_address,context.draft.from.address);assert.deepEqual(packet.mime_bytes,snapshot.mime_bytes);
 }
 assert.equal(host.counts.reserve,2);
});

test('API MIME retains selected Bcc; SMTP MIME omits it and exact envelope retains it',async()=>{
 const [base]=await contexts(),digests=new Set();
 for(const [provider,kind] of [['gmail','gmail_raw'],['microsoft','graph_raw'],['imap_smtp','smtp_raw']]){
  const context=structuredClone(base);context.provider=provider;const host=fixtureHost([context]),snapshot=await host.service.prepare(reference(context));
  assert.equal(snapshot.payload.transport_kind,kind);assert.equal(snapshot.envelope.to.at(-1),'blind-copy@example.test');
  const headers=snapshot.mime_bytes.toString('utf8').split('\r\n\r\n')[0],parsed=await simpleParser(snapshot.mime_bytes);
  assert.equal(/^Bcc:/gmu.test(headers),provider!=='imap_smtp');assert.equal(addresses(parsed.bcc).length,provider==='imap_smtp'?0:1);
  assert.deepEqual(snapshot.envelope,{from:context.draft.from.address,to:[...context.draft.to,...context.draft.cc,...context.draft.bcc].map(row=>row.address)});
  digests.add(snapshot.payload_digest);
 }
 assert.equal(digests.size,3);
});

test('reply recipients deduplicate within bounds, exclude own aliases and never read received Bcc',()=>{
 const parent={from:[typed('from@example.test')],reply_to:[typed('reply@example.test'),typed('REPLY@example.test')],to:[typed('me@example.test'),typed('other@example.test')],cc:[typed('OTHER@example.test'),typed('alias@example.test')]};
 Object.defineProperty(parent,'bcc',{get(){throw Error('must not read received Bcc');}});
 assert.deepEqual(replyRecipients(parent,[typed('ME@example.test'),typed('alias@example.test')],{all:true,maxRecipients:2}),{to:[typed('reply@example.test')],cc:[typed('other@example.test')],bcc:[]});
 assert.deepEqual(replyRecipients(parent,[],{all:false,maxRecipients:1}),{to:[typed('reply@example.test')],cc:[],bcc:[]});
 assert.throws(()=>replyRecipients(parent,[],{all:true,maxRecipients:1}),errorCode('OUTGOING_RECIPIENT_LIMIT'));
 assert.throws(()=>replyRecipients({...parent,to:Array.from({length:201},(_,index)=>typed(`recipient${index}@example.test`))},[],{all:true}),errorCode('OUTGOING_RECIPIENT_LIMIT'));
 assert.throws(()=>typedMailbox({address:'safe@example.test',display_name:'Name\r\nBcc: injected@example.test'}),errorCode('OUTGOING_MAILBOX_INVALID'));
});

test('host callbacks are required and caller references cannot assert authority or content',async()=>{
 assert.throws(()=>createOutgoingSnapshotService(),errorCode('OUTGOING_HOST_CONTRACT_REQUIRED'));
 const [context]=await contexts(),host=fixtureHost([context]);
 for(const extra of [{verified_from:context.draft.from},{sealed:true},{subject:'Caller asserted subject'},{body_bytes:Buffer.from('Caller asserted body')}]){
  await assert.rejects(host.service.prepare({...reference(context),...extra}),errorCode('OUTGOING_REFERENCE_INVALID'));
 }
 assert.equal(host.counts.resolve,0);assert.equal(host.counts.seal,0);
 await assert.rejects(host.service.prepare({...reference(context),expected_revision:2}),errorCode('OUTGOING_DRAFT_STALE'));
});

test('header controls, unverified sender, HTML, malformed UTF8 and budgets fail before sealing',async()=>{
 const [base]=await contexts();
 const cases=[
  [context=>{context.draft.from=typed('other@example.test');},'OUTGOING_FROM_NOT_VERIFIED'],
  [context=>{context.draft.subject='Hello\r\nBcc: injected@example.test';},'OUTGOING_SUBJECT_INVALID'],
  [context=>{context.draft.subject='Hello\u0085Bcc: injected@example.test';},'OUTGOING_SUBJECT_INVALID'],
  [context=>{context.draft.subject='Hello\u2028Bcc: injected@example.test';},'OUTGOING_SUBJECT_INVALID'],
  [context=>{context.draft.subject='';},'OUTGOING_SUBJECT_INVALID'],
  [context=>{context.draft.from.display_name='Personal\u0001';},'OUTGOING_MAILBOX_INVALID'],
  [context=>{context.draft.to[0].address='queue@example.test\r\nFrom: injected@example.test';},'OUTGOING_MAILBOX_INVALID'],
  [context=>{context.draft.reply_parent.message_id='<safe@example.test>\r\nBcc: injected@example.test';},'OUTGOING_REPLY_HEADERS_INVALID'],
  [context=>{context.draft.body_format='html';},'OUTGOING_BODY_FORMAT_INVALID'],
  [context=>{context.draft.body_bytes=Buffer.from([0xc3,0x28]);},'OUTGOING_BODY_UTF8_INVALID'],
  [context=>{context.draft.body_bytes=Buffer.from('unsafe\0body');},'OUTGOING_BODY_INVALID'],
  [context=>{context.limits.max_body_bytes=1;},'OUTGOING_BYTES_INVALID'],
  [context=>{context.limits.max_mime_bytes=1;},'OUTGOING_MIME_LIMIT'],
  [context=>{context.limits.max_recipients=1;},'OUTGOING_RECIPIENT_LIMIT'],
  [context=>{context.captured_at='invalid';},'OUTGOING_TIMESTAMP_INVALID'],
 ];
 for(const [mutate,code] of cases){const context=structuredClone(base);mutate(context);const host=fixtureHost([context]);await assert.rejects(host.service.prepare(reference(context)),errorCode(code));assert.equal(host.counts.seal,0,code);}
});

test('file owner/account/parent and ordered metadata/bytes cannot be substituted',async()=>{
 const [base]=await contexts();
 const cases=[
  [file=>{file.owner_id='other-owner';},'OUTGOING_FILE_PROVENANCE_DENIED'],[file=>{file.org_id='other-org';},'OUTGOING_FILE_PROVENANCE_DENIED'],
  [file=>{file.account_id='gmail-work';},'OUTGOING_FILE_PROVENANCE_DENIED'],[file=>{file.parent.id='other-parent';},'OUTGOING_FILE_PROVENANCE_DENIED'],
  [file=>{file.parent.extra='unverified';},'OUTGOING_FILE_PROVENANCE_DENIED'],[file=>{file.availability='expired';},'OUTGOING_FILE_PROVENANCE_DENIED'],
  [file=>{file.bytes[0]^=1;},'OUTGOING_FILE_BYTES_CHANGED'],[file=>{file.byte_count++;},'OUTGOING_FILE_BYTES_CHANGED'],
  [file=>{file.filename='../brief.pdf';},'OUTGOING_FILE_INVALID'],[file=>{file.filename='brief.pdf\nBcc: hidden';},'OUTGOING_FILE_INVALID'],
  [file=>{file.expires_at=now;},'OUTGOING_FILE_EXPIRED'],[file=>{file.expires_at='invalid';},'OUTGOING_TIMESTAMP_INVALID'],
 ];
 for(const [mutate,code] of cases){const context=structuredClone(base);mutate(context.draft.files[0]);const host=fixtureHost([context]);await assert.rejects(host.service.prepare(reference(context)),errorCode(code));assert.equal(host.counts.seal,0,code);}
 const denied=structuredClone(base);denied.limits.allowed_media_types=['text/plain'];const host=fixtureHost([denied]);await assert.rejects(host.service.prepare(reference(denied)),errorCode('OUTGOING_FILE_INVALID'));
 const two=structuredClone(base),second=structuredClone(two.draft.files[0]);second.file_id='second-pdf';second.filename='second.pdf';two.draft.files.push(second);
 const first=await fixtureHost([two]).service.prepare(reference(two));two.draft.files.reverse();const reversed=await fixtureHost([two]).service.prepare(reference(two));
 assert.notEqual(first.payload_digest,reversed.payload_digest);assert.notEqual(first.mime_digest,reversed.mime_digest);
});

test('each snapshot content mutation is rejected before operation reservation',async()=>{
 const [context]=await contexts(),host=fixtureHost([context]),snapshot=await host.service.prepare(reference(context));
 const edits=[payload=>{payload.subject='different';},payload=>{payload.account_id='gmail-work';},payload=>{payload.verified_from.address='other@example.test';},
  payload=>{payload.to[0].address='other@example.test';},payload=>{payload.bcc=[];},payload=>{payload.draft_revision++;},payload=>{payload.reply_headers.in_reply_to='<other@example.test>';},
  payload=>{payload.files[0].filename='different.pdf';},payload=>{payload.files[0].parent.id='other-parent';},payload=>{payload.body.digest='0'.repeat(64);}];
 for(const edit of edits){const changed={...snapshot,payload:structuredClone(snapshot.payload)};edit(changed.payload);await assert.rejects(host.service.bind(changed,operation(snapshot)),errorCode('OUTGOING_SNAPSHOT_CHANGED'));}
 for(const property of ['mime_bytes','body_bytes','file_bytes']){
  const changed={...snapshot};if(property==='file_bytes')changed[property][0][0]^=1;else changed[property][0]^=1;
  await assert.rejects(host.service.bind(changed,operation(snapshot)),errorCode('OUTGOING_SNAPSHOT_BYTES_CHANGED'));
 }
 const forged={...snapshot,sealed_contract:'author-asserted-seal'};await assert.rejects(host.service.bind(forged,operation(snapshot)),errorCode('OUTGOING_HOST_AUTHORITY_DENIED'));
 const recalculated={...snapshot,payload:structuredClone(snapshot.payload)};recalculated.payload.subject='author substituted content';recalculated.payload_digest=digest(canonical(recalculated.payload));
 await assert.rejects(host.service.bind(recalculated,operation(recalculated)),errorCode('OUTGOING_HOST_AUTHORITY_DENIED'));
 assert.equal(host.counts.reserve,0);
});

test('exact operation replay yields metadata only; unknown or crossed binding never yields transport bytes',async()=>{
 const inputs=await contexts(),host=fixtureHost(inputs),snapshot=await host.service.prepare(reference(inputs[0]));
 const packet=await host.service.bind(snapshot,operation(snapshot));assert.equal(packet.mime_digest,snapshot.mime_digest);assert.deepEqual(packet.mime_bytes,snapshot.mime_bytes);
 const replay=await host.service.bind(snapshot,operation(snapshot));assert.equal(replay.replay,true);assert.equal(replay.mime_bytes,undefined);assert.equal(replay.envelope,undefined);
 await assert.rejects(host.service.bind(snapshot,{...operation(snapshot),operation_id:'another-operation'}),errorCode('OUTGOING_OPERATION_UNCERTAIN_NO_RESEND'));
 const other=await host.service.prepare(reference(inputs[1]));await assert.rejects(host.service.bind(other,{...operation(other),operation_id:'synthetic-operation'}),errorCode('OUTGOING_OPERATION_UNCERTAIN_NO_RESEND'));
 await assert.rejects(host.service.bind(snapshot,{...operation(snapshot),expected_digest:other.payload_digest}),errorCode('OUTGOING_SNAPSHOT_CHANGED'));
 for(const reserveState of ['unknown','throws']){const isolated=fixtureHost([inputs[0]],{reserveState}),ready=await isolated.service.prepare(reference(inputs[0]));await assert.rejects(isolated.service.bind(ready,operation(ready)),errorCode('OUTGOING_OPERATION_UNCERTAIN_NO_RESEND'));}
});

test('revocation, scope, authority epoch and draft changes after preparation deny dispatch',async()=>{
 const [context]=await contexts();
 for(const mutate of [current=>{current.revoked=true;},current=>{current.scope.owner_id='other-owner';},current=>{current.authority_epoch++;},current=>{current.draft.revision++;}]){
  const host=fixtureHost([context]),snapshot=await host.service.prepare(reference(context));mutate(host.current.get(context.account_id));
  await assert.rejects(host.service.bind(snapshot,operation(snapshot)),errorCode('OUTGOING_HOST_AUTHORITY_DENIED'));assert.equal(host.counts.reserve,0);
 }
});

test('mutation during async host verification cannot change the captured dispatch identity',async()=>{
 const [context]=await contexts();let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),verified=new Promise(resolve=>{entered=resolve;});
 const host=fixtureHost([context],{verifyHook:async()=>{entered();await gate;}}),snapshot=await host.service.prepare(reference(context));
 const mutable={...snapshot,payload:structuredClone(snapshot.payload),envelope:structuredClone(snapshot.envelope)};
 const binding=host.service.bind(mutable,operation(snapshot));await verified;
 mutable.payload.account_id='gmail-work';mutable.payload.draft_revision=999;mutable.payload.verified_from.address='attacker@example.test';mutable.envelope.to.push('attacker@example.test');
 release();const packet=await binding;
 assert.equal(packet.account_id,context.account_id);assert.equal(packet.draft_revision,3);assert.equal(packet.from_address,context.draft.from.address);assert.deepEqual(packet.envelope,snapshot.envelope);
 assert.deepEqual(packet.mime_bytes,snapshot.mime_bytes);
});

test('the injected host reservation rechecks revocation atomically after verification',async()=>{
 const [context]=await contexts();let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),verified=new Promise(resolve=>{entered=resolve;});
 const host=fixtureHost([context],{verifyHook:async()=>{entered();await gate;}}),snapshot=await host.service.prepare(reference(context));
 const binding=host.service.bind(snapshot,operation(snapshot));await verified;host.current.get(context.account_id).revoked=true;release();
 await assert.rejects(binding,errorCode('OUTGOING_OPERATION_UNCERTAIN_NO_RESEND'));assert.equal(host.operations.size,0);assert.equal(host.counts.reserve,1);
});
