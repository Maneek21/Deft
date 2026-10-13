import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {buildEmailActionPayload} from '../outgoing-payload-builder.mjs';
import {createRecipientVerificationProbe,bindRecipientProbeToPayload,verifyGmailRecipientProbe,RECIPIENT_VERIFICATION_LIMITS} from './recipient-verification.mjs';

const recipient='recipient@example.test',sender='sender@example.test';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const makeProbe=(extra={})=>createRecipientVerificationProbe({recipient,expected_sender:sender,body_text:'Controlled fixture body.',...extra});
function message(probe,id,{body=probe.body_text,attachments=[]}={}){
 const text=Buffer.from(body),headers=[{name:'From',value:`Expected sender <${probe.expected_sender}>`},{name:'To',value:probe.recipient},{name:'Subject',value:probe.subject},{name:'Message-ID',value:probe.message_id},{name:'Delivered-To',value:probe.recipient}];
 const plain={mimeType:'text/plain',filename:'',headers:[{name:'Content-Type',value:'text/plain; charset=utf-8'}],body:{size:text.length,data:text.toString('base64url')}};
 return {id,threadId:`thread-${id}`,labelIds:['INBOX'],internalDate:'1790766000000',payload:attachments.length?{mimeType:'multipart/mixed',headers,parts:[plain,...attachments]}:{...plain,headers:[...headers,...plain.headers]}};
}
function fixture(probe,{messages=[message(probe,'received-1')],profile=recipient,nextPageToken,mutateFull,mutateMetadata,attachments={},listExtra={},authority=()=>true,afterFetch}={}){
 const calls=[];
 const account={account_id:'recipient-fixture',provider:'gmail',display_label:'Controlled recipient fixture',primary_address:recipient,verified_sender_identities:[recipient],capabilities:['read','search'],connection_target:'fixture-recipient',resource_binding_id:'fixture-read',action_binding_id:null,authority_epoch:1,health:'connected'};
 const fetch=async(url,init)=>{
  const parsed=new URL(url);calls.push({url:parsed,method:init.method});assert.equal(parsed.origin,'https://gmail.googleapis.com');assert.equal(init.method,'GET');
  let response;
  if(parsed.pathname.endsWith('/profile'))response=json({emailAddress:profile});
  else if(parsed.pathname.endsWith('/messages'))response=json({messages:messages.map(row=>({id:row.id,threadId:row.threadId})),...(nextPageToken?{nextPageToken}:{}),...listExtra});
  else if(parsed.pathname.includes('/attachments/')){
   const attachmentId=decodeURIComponent(parsed.pathname.split('/attachments/')[1]),bytes=attachments[attachmentId];
   assert.ok(bytes instanceof Uint8Array,`unexpected attachment read ${attachmentId}`);response=json({size:bytes.length,data:Buffer.from(bytes).toString('base64url')});
  }else{
   const id=decodeURIComponent(parsed.pathname.split('/messages/')[1]),row=messages.find(value=>value.id===id);assert.ok(row,`unexpected message read ${id}`);
   let value=structuredClone(row);
   if(parsed.searchParams.get('format')==='metadata'){
    value={...value,payload:{headers:value.payload.headers}};mutateMetadata?.(value,id);
   }else{assert.equal(parsed.searchParams.get('format'),'full');mutateFull?.(value,id);}
   response=json(value);
  }
  afterFetch?.(parsed);return response;
 };
 return {calls,provider_options:{account,fetch,assertAuthority:async()=>authority(),getAccessToken:async()=> 'fixture-only-token'}};
}
const run=(probe,one)=>verifyGmailRecipientProbe({probe,provider_options:one.provider_options});
const fullReads=one=>one.calls.filter(call=>call.url.searchParams.get('format')==='full');
const attachmentReads=one=>one.calls.filter(call=>call.url.pathname.includes('/attachments/'));
const bodyPart=row=>row.payload.parts?.[0]??row.payload;

async function nativePayload(probe,bytes){
 const binding={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),
  grant_snapshot_id:randomUUID(),resource_target_key:'primary',state_key:'drafts',draft_id:randomUUID(),draft_revision:2,
  artifact_digest:'sha256:'+'a'.repeat(64),declaration_digest:'sha256:'+'b'.repeat(64),runtime_binding_id:randomUUID(),
  action_key:'send_message',action_contract_digest:'sha256:'+'c'.repeat(64),input_digest:'sha256:'+'d'.repeat(64)};
 const account={account_id:'sender-native',provider:'gmail',display_label:'Controlled sender',primary_address:sender,
  verified_sender_identities:[sender],capabilities:['read','send'],connection_target:'primary',resource_binding_id:randomUUID(),
  action_binding_id:binding.runtime_binding_id,authority_epoch:1,health:'connected'};
 const input={to:recipient,subject:probe.subject,body:probe.body_text};
 return buildEmailActionPayload({binding,input,draft_value:{...input,mode:'compose',reply_record_id:''},
  draft_updated_at:'2026-09-30T00:00:00.000Z',files:[{reference:{file_id:randomUUID(),upload_operation_id:randomUUID(),
   filename:'native.pdf',media_type:'application/pdf',byte_length:bytes.length,digest:hash(bytes),expires_at:'2026-10-01T00:00:00.000Z'},bytes}],
  max_payload_bytes:4194304,expires_at:'2026-10-01T00:00:00.000Z'},account);
}

test('native saved-draft MIME verifies with the production Message-ID and exact PDF',async()=>{
 const bytes=Buffer.from('%PDF-1.4\nNative controlled proof\n%%EOF');
 const probe=makeProbe({attachments:[{filename:'native.pdf',media_type:'application/pdf',bytes}]});
 const built=await nativePayload(probe,bytes),parsed=await simpleParser(built.bytes);
 const received={...probe,message_id:parsed.messageId};
 const part={mimeType:'application/pdf',filename:'native.pdf',headers:[],body:{size:bytes.length,data:parsed.attachments[0].content.toString('base64url')}};
 const one=fixture(probe,{messages:[message(received,'native-received',{body:parsed.text,attachments:[part]})]});
 const bound=bindRecipientProbeToPayload(probe,built.metadata),result=await run(bound,one);
 assert.equal(bound.schema_version,'deft.email_recipient_probe.v2');assert.equal(bound.message_id,parsed.messageId);
 assert.equal(bound.payload_digest,built.metadata.payload_digest);assert.equal(bound.body_text,probe.body_text);
 assert.ok(Object.isFrozen(bound)&&Object.isFrozen(bound.attachments)&&Object.isFrozen(bound.attachments[0]));
 assert.equal(one.calls[1].url.searchParams.get('q'),`rfc822msgid:${parsed.messageId} to:${recipient} from:${sender}`);
 assert.equal(result.status,'receipt_observed');
 assert.equal(result.exact_receipts[0].attachments[0].sha256,hash(bytes));
});

test('retained payload binding cannot change approved content or accept a substituted digest',async()=>{
 const bytes=Buffer.from('%PDF-1.4\nBinding proof\n%%EOF'),probe=makeProbe({attachments:[{filename:'native.pdf',media_type:'application/pdf',bytes}]}),built=await nativePayload(probe,bytes);
 const invalid=error=>error.code==='EMAIL_RECIPIENT_PROBE_INVALID';
 for(const mutate of [value=>{value.payload.verified_from.address='other@example.test';},value=>{value.payload.to[0].address='other@example.test';},
  value=>{value.payload.cc=[{address:'other@example.test',display_name:''}];},value=>{value.payload.bcc=[{address:'other@example.test',display_name:''}];},
  value=>{value.payload.subject='Substitute';},value=>{value.body_text='Substitute';},value=>{value.payload.body.digest='0'.repeat(64);},
  value=>{value.payload.body.byte_count++;},value=>{value.payload.files[0].digest='0'.repeat(64);},value=>{value.payload.files[0].filename='other.pdf';},
  value=>{value.payload.files[0].media_type='text/plain';},value=>{value.payload.files[0].byte_count++;},value=>{value.payload.files=[];},
  value=>{value.payload.envelope.to=['other@example.test'];},value=>{value.payload.message_id='<other@example.test>';},
  value=>{value.payload.message_id=value.payload.message_id.replace('deft.invalid','deftXinvalid');},value=>{value.payload.verified_from.address=42;},
  value=>{value.payload.files=[null];},value=>{value.payload=null;},value=>{value.payload.mode='reply';}]){
  const metadata=structuredClone(built.metadata);mutate(metadata);metadata.payload_digest=hash(JSON.stringify(canonical(metadata.payload)));
  assert.throws(()=>bindRecipientProbeToPayload(probe,metadata),invalid);
 }
 assert.throws(()=>bindRecipientProbeToPayload(probe,{...built.metadata,payload_digest:'0'.repeat(64)}),invalid);
 const bound=bindRecipientProbeToPayload(probe,built.metadata);assert.throws(()=>bindRecipientProbeToPayload(bound,built.metadata),invalid);
 const one=fixture(probe);
 await assert.rejects(run({...probe,message_id:bound.message_id},one),invalid);
 await assert.rejects(run({...bound,payload_digest:'wrong'},one),invalid);
 await assert.rejects(run({...bound,message_id:bound.message_id.replace('deft.invalid','deftXinvalid')},one),invalid);
 await assert.rejects(run({...bound,unreviewed:true},one),invalid);assert.equal(one.calls.length,0);
});

test('probe has fresh256-bit identity, normalized LF body and immutable copied attachment expectations',()=>{
 const bytes=Buffer.from('private fixture bytes'),probe=makeProbe({recipient:'Recipient@example.test',expected_sender:'Sender@example.test',body_text:'First\r\nSecond\r\n\r\n',attachments:[{filename:'fixture.pdf',media_type:'application/pdf',bytes}]}),another=makeProbe();
 assert.equal(Buffer.from(probe.nonce,'base64url').length,32);assert.notEqual(probe.nonce,another.nonce);assert.equal(probe.message_id,`<deft-probe.${probe.nonce}@probe.deft.invalid>`);
 assert.equal(probe.recipient,recipient);assert.equal(probe.expected_sender,sender);assert.equal(probe.body_text,`First\nSecond\n\nDeft probe nonce: ${probe.nonce}\n`);assert.equal(probe.body_sha256,hash(Buffer.from(probe.body_text)));
 bytes.fill(0);assert.equal(probe.attachments[0].sha256,hash(Buffer.from('private fixture bytes')));assert.ok(Object.isFrozen(probe)&&Object.isFrozen(probe.attachments)&&Object.isFrozen(probe.attachments[0]));
});

test('probe rejects header injection, duplicate names, invalid bodies and per-file/count/aggregate bounds',()=>{
 const file={filename:'fixture.pdf',media_type:'application/pdf',bytes:Buffer.from('x')};
 for(const extra of [{recipient:'recipient@example.test\r\nBcc: other@example.test'},{subject:'Bad\nSubject'},{body_text:'Bad\rcarriage'},{body_text:'Deft probe nonce: forged'},{body_text:'x'.repeat(RECIPIENT_VERIFICATION_LIMITS.body_bytes)},{attachments:[file,file]},{attachments:Array.from({length:9},(_,index)=>({...file,filename:`${index}.pdf`}))},{attachments:[{...file,bytes:Buffer.alloc(RECIPIENT_VERIFICATION_LIMITS.attachment_bytes+1)}]},{attachments:[{...file,filename:'first.pdf',bytes:Buffer.alloc(4500000)},{...file,filename:'second.pdf',bytes:Buffer.alloc(4500000)}]}])assert.throws(()=>makeProbe(extra),error=>error.code==='EMAIL_RECIPIENT_PROBE_INVALID');
});

test('absent probe searches only exact Message-ID/sender/recipient and performs no full reads or sends',async()=>{
 const probe=makeProbe(),one=fixture(probe,{messages:[]}),result=await run(probe,one);
 assert.equal(result.status,'not_observed');assert.deepEqual(result.exact_receipts,[]);assert.equal(one.calls.length,2);assert.equal(fullReads(one).length,0);
 const query=one.calls[1].url;assert.equal(query.searchParams.get('q'),`rfc822msgid:${probe.message_id} to:${recipient} from:${sender}`);assert.equal(query.searchParams.get('maxResults'),'3');assert.equal(query.searchParams.get('includeSpamTrash'),'true');assert.equal(query.searchParams.has('pageToken'),false);
});

test('actual recipient profile must match before any message query',async()=>{
 const probe=makeProbe(),one=fixture(probe,{profile:'another@example.test'}),result=await run(probe,one);
 assert.equal(result.status,'unavailable');assert.equal(result.reason_code,'EMAIL_RECIPIENT_MAILBOX_MISMATCH');assert.equal(one.calls.length,1);
});

test('one exact full MIME receipt verifies canonical body/nonce and emits no delivered or acceptance assertion',async()=>{
 const probe=makeProbe({body_text:'First line.\n\nUnicode: café.'}),one=fixture(probe,{messages:[message(probe,'received-1',{body:probe.body_text.replace(/\n/g,'\r\n')})]}),result=await run(probe,one);
 assert.equal(result.status,'receipt_observed');assert.equal(result.exact_receipts.length,1);assert.equal(result.exact_receipts[0].body_sha256,probe.body_sha256);assert.deepEqual(result.mismatches,[]);assert.equal(fullReads(one).length,1);
 assert.equal('delivery_status' in result,false);assert.equal('transport_outcome' in result,false);assert.equal(JSON.stringify(result).includes(probe.body_text),false);
});

test('provider acceptance without a received message remains absent',async()=>{
 const probe=makeProbe(),one=fixture(probe,{messages:[],listExtra:{transport_outcome:'provider_accepted',delivery_status:'delivered'}}),result=await run(probe,one);
 assert.equal(result.status,'not_observed');assert.deepEqual(result.exact_receipts,[]);assert.equal(JSON.stringify(result).includes('delivered'),false);
});

test('wrong sender/recipient/Message-ID/subject metadata cannot cause a body read or exact receipt',async()=>{
 for(const [name,value] of [['From','other@example.test'],['To','other@example.test'],['Message-ID','<unrelated@example.test>'],['Subject','Unrelated subject']]){
  const probe=makeProbe(),one=fixture(probe,{mutateMetadata:row=>{row.payload.headers.find(header=>header.name===name).value=value;}}),result=await run(probe,one);
  assert.equal(result.status,'mismatch');assert.equal(result.exact_receipts.length,0);assert.equal(fullReads(one).length,0);
 }
});

test('nonce/body substitution under exact headers is a mismatch',async()=>{
 const probe=makeProbe(),one=fixture(probe,{messages:[message(probe,'received-1',{body:probe.body_text.replace('Controlled','Substituted')})]}),result=await run(probe,one);
 assert.equal(result.status,'mismatch');assert.deepEqual(result.mismatches,[{provider_message_id:'received-1',reason:'body'}]);assert.deepEqual(result.exact_receipts,[]);
});

test('distinct exact copies are reported as duplicate receipts',async()=>{
 const probe=makeProbe(),one=fixture(probe,{messages:[message(probe,'received-1'),message(probe,'received-2')]}),result=await run(probe,one);
 assert.equal(result.status,'duplicate_receipts');assert.equal(result.exact_receipts.length,2);assert.deepEqual(result.mismatches,[]);assert.equal(fullReads(one).length,2);
});

test('exact plus substituted copies are ambiguous rather than a unique success',async()=>{
 const probe=makeProbe(),one=fixture(probe,{messages:[message(probe,'received-1'),message(probe,'received-2',{body:'Wrong nonce/body.'})]}),result=await run(probe,one);
 assert.equal(result.status,'ambiguous');assert.equal(result.exact_receipts.length,1);assert.equal(result.mismatches.length,1);
});

test('pagination, partial metadata and repeated provider IDs fail closed without full MIME reads',async()=>{
 const probe=makeProbe();
 for(const options of [{nextPageToken:'more-candidates'},{messages:[message(probe,'received-1'),message(probe,'received-1')]},{mutateMetadata:row=>{delete row.threadId;}}]){
  const one=fixture(probe,options),result=await run(probe,one);assert.equal(result.status,'ambiguous');assert.deepEqual(result.exact_receipts,[]);assert.equal(fullReads(one).length,0);
 }
});

test('provider candidate overflow cannot broaden the fixed query budget',async()=>{
 const probe=makeProbe(),one=fixture(probe,{messages:Array.from({length:4},(_,index)=>message(probe,`received-${index}`))}),result=await run(probe,one);
 assert.equal(result.status,'unavailable');assert.equal(result.reason_code,'EMAIL_PROVIDER_RESPONSE_INVALID');assert.equal(one.calls.length,2);assert.equal(fullReads(one).length,0);assert.deepEqual(result.exact_receipts,[]);
});

test('exact inline and externally fetched attachment bytes satisfy the same digest expectation',async()=>{
 const bytes=Buffer.from('%PDF-1.7\nSynthetic exact attachment bytes\n%%EOF'),probe=makeProbe({attachments:[{filename:'fixture.pdf',media_type:'application/pdf',bytes}]});
 for(const external of [false,true]){
  const attachment={mimeType:'application/pdf',filename:'fixture.pdf',headers:[],body:external?{size:bytes.length,attachmentId:'selected-attachment'}:{size:bytes.length,data:bytes.toString('base64url')}},one=fixture(probe,{messages:[message(probe,'received-1',{attachments:[attachment]})],attachments:{'selected-attachment':bytes}}),result=await run(probe,one);
  assert.equal(result.status,'receipt_observed');assert.deepEqual(result.exact_receipts[0].attachments,probe.attachments);assert.equal(attachmentReads(one).length,external?1:0);
 }
});

test('attachment byte substitution is a mismatch, and unexpected inventory is not downloaded',async()=>{
 const bytes=Buffer.from('same length expected'),different=Buffer.from('same length replaced'),probe=makeProbe({attachments:[{filename:'fixture.pdf',media_type:'application/pdf',bytes}]}),part={mimeType:'application/pdf',filename:'fixture.pdf',headers:[],body:{size:bytes.length,attachmentId:'selected-attachment'}};
 assert.equal(bytes.length,different.length);
 const one=fixture(probe,{messages:[message(probe,'received-1',{attachments:[part]})],attachments:{'selected-attachment':different}}),result=await run(probe,one);assert.equal(result.status,'mismatch');assert.equal(result.mismatches[0].reason,'attachments');
 const unexpected=fixture(probe,{messages:[message(probe,'received-1',{attachments:[{...part,filename:'unexpected.pdf'}]})]}),denied=await run(probe,unexpected);assert.equal(denied.status,'mismatch');assert.equal(attachmentReads(unexpected).length,0);
});

test('duplicate critical headers, hidden recipients and wrong Delivered-To cannot verify receipt',async()=>{
 for(const [name,value] of [['From',sender],['To',recipient],['Message-ID','placeholder'],['Subject','second subject'],['Cc','other@example.test'],['Bcc','other@example.test'],['Delivered-To','other@example.test']]){
  const probe=makeProbe(),one=fixture(probe,{mutateFull:row=>{if(name==='Delivered-To')row.payload.headers.find(header=>header.name===name).value=value;else row.payload.headers.push({name,value:name==='Message-ID'?probe.message_id:value});}}),result=await run(probe,one);
  assert.equal(result.status,'mismatch',name);assert.equal(result.exact_receipts.length,0);
 }
});

test('malformed/oversized MIME parts, invalid body bytes and unsupported charset fail closed',async()=>{
 const probe=makeProbe();
 for(const mutateFull of [row=>{bodyPart(row).body.data='not-base64url!';},row=>{bodyPart(row).body.size++;},row=>{bodyPart(row).body={size:1,data:Buffer.from([255]).toString('base64url')};},row=>{bodyPart(row).body.size=RECIPIENT_VERIFICATION_LIMITS.body_bytes+1;},row=>{bodyPart(row).headers.find(header=>header.name==='Content-Type').value='text/plain; charset=iso-8859-1';},row=>{const leaf=bodyPart(row);row.payload={...row.payload,mimeType:'multipart/mixed',parts:Array.from({length:RECIPIENT_VERIFICATION_LIMITS.parts},()=>structuredClone(leaf))};}]){
  const one=fixture(probe,{mutateFull}),result=await run(probe,one);assert.equal(result.status,'mismatch');assert.equal(result.exact_receipts.length,0);assert.equal(attachmentReads(one).length,0);
 }
});

test('changed expectation digest/account fails before provider reads',async()=>{
 const probe=makeProbe(),one=fixture(probe);
 await assert.rejects(run({...probe,body_sha256:'0'.repeat(64)},one),error=>error.code==='EMAIL_RECIPIENT_PROBE_INVALID');assert.equal(one.calls.length,0);
 one.provider_options.account.primary_address='other@example.test';await assert.rejects(run(probe,one),error=>error.code==='EMAIL_RECIPIENT_PROBE_INVALID');assert.equal(one.calls.length,0);
});

test('revocation after full provider I/O discards receipt evidence',async()=>{
 const probe=makeProbe();let allowed=true;
 const one=fixture(probe,{authority:()=>allowed,afterFetch:url=>{if(url.searchParams.get('format')==='full')allowed=false;}}),result=await run(probe,one);
 assert.equal(result.status,'unavailable');assert.equal(result.reason_code,'EMAIL_ACCOUNT_REVOKED');assert.deepEqual(result.exact_receipts,[]);
});


test('bound production IDs require canonical full-entropy encoding and body wrapping remains a mismatch',async()=>{
 const bytes=Buffer.from('%PDF-1.4\nStrict compatibility fixture\n%%EOF'),probe=makeProbe({body_text:'The attached one-page PDF is synthetic test content.',attachments:[{filename:'native.pdf',media_type:'application/pdf',bytes}]});
 const built=await nativePayload(probe,bytes),bound=bindRecipientProbeToPayload(probe,built.metadata);
 const noncanonical=`<${'A'.repeat(42)}B@deft.invalid>`;
 await assert.rejects(run({...bound,message_id:noncanonical},fixture(bound)),error=>error.code==='EMAIL_RECIPIENT_PROBE_INVALID');
 const received=message(bound,'wrapped',{body:bound.body_text.replace('attached one-page','attached\none-page')});
 const one=fixture(bound,{messages:[received]}),result=await run(bound,one);
 assert.equal(result.status,'mismatch');assert.equal(result.exact_receipts.length,0);
});
