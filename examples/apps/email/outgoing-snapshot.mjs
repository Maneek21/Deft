import {createHash} from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import {singleAddress} from './account-config.mjs';
import {parseSafeComposeHtml,parseNativeSafeComposeHtml,nativeComposeInlineFileIds,nativeComposeImageCid} from '@deft/app-kit/experience';
import {validNativeOutgoingImage} from './providers/remote-image-proxy.mjs';

const fail=code=>{const error=Error(code);error.code=code;throw error;};
const controls=/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const clean=(value,max,empty=false)=>typeof value==='string'&&(empty||value.length>0)&&value.length<=max&&!controls.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const frozen=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const id=value=>{if(!clean(value,256))fail('OUTGOING_REFERENCE_INVALID');return value;};
const timestamp=value=>{const date=new Date(value);if(!clean(value,40)||!Number.isFinite(date.getTime())||date.toISOString()!==value)fail('OUTGOING_TIMESTAMP_INVALID');return value;};
const copyBytes=(value,max)=>{if(!(value instanceof Uint8Array)||value.byteLength>max)fail('OUTGOING_BYTES_INVALID');return Buffer.from(value);};
export function typedMailbox(value){
 if(!exact(value,['address','display_name'])||!singleAddress(value.address)||!clean(value.display_name,128,true))fail('OUTGOING_MAILBOX_INVALID');
 return {address:value.address,display_name:value.display_name};
}
function mailboxes(rows,max=200){if(!Array.isArray(rows)||rows.length>max)fail('OUTGOING_RECIPIENT_LIMIT');return rows.map(typedMailbox);}
function recipients(to,cc,bcc,excluded=[]){
 const seen=new Set(excluded.map(row=>row.address.toLowerCase())),select=rows=>rows.filter(row=>{const key=row.address.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
 return {to:select(to),cc:select(cc),bcc:select(bcc)};
}
/** Received Bcc is deliberately never read or copied into reply candidates. */
export function replyRecipients(parent,ownAliases,{all=false,maxRecipients=200}={}){
 if(!parent||!Number.isInteger(maxRecipients)||maxRecipients<1||maxRecipients>200)fail('OUTGOING_REPLY_INVALID');
 const own=mailboxes(ownAliases,32),replyTo=mailboxes(parent.reply_to??[]),from=mailboxes(parent.from??[]);
 const ownAddresses=new Set(own.map(row=>row.address.toLowerCase())),ownSent=from.length>0&&from.every(row=>ownAddresses.has(row.address.toLowerCase()));
 const to=ownSent?mailboxes(parent.to??[]):replyTo.length?replyTo:from,cc=all?(ownSent?mailboxes(parent.cc??[]):[...mailboxes(parent.to??[]),...mailboxes(parent.cc??[])]):[];
 const result=recipients(to,cc,[],own);
 if(result.to.length+result.cc.length<1||result.to.length+result.cc.length>maxRecipients)fail('OUTGOING_RECIPIENT_LIMIT');
 return frozen(result);
}
const messageId=value=>{if(!clean(value,200)||!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(value))fail('OUTGOING_REPLY_HEADERS_INVALID');return value;};
function validateComposeBody(html,text,profile,files,fileBytes,draftId){
 if(profile!=='native'){if(parseSafeComposeHtml(html).plainText!==text)fail('OUTGOING_BODY_INVALID');return [];}
 // Existing ordinary file identifiers remain unchanged. Inline nominations
 // alone must use canonical current draft UUIDs; no received/message transplant.
 const inlineAttachments=files.map(file=>({file_id:file.file_id,filename:file.filename,media_type:file.media_type,size_bytes:file.byte_count,sha256:file.digest}));
 const options={inlineAttachments};if(parseNativeSafeComposeHtml(html,options).plainText!==text)fail('OUTGOING_BODY_INVALID');
 const ids=nativeComposeInlineFileIds(html,options);
 for(const id of ids){const index=files.findIndex(file=>file.file_id===id),file=files[index];
  if(!file||file.parent?.kind!=='draft'||file.parent.id!==draftId||!validNativeOutgoingImage(fileBytes[index],file.media_type))fail('OUTGOING_BODY_INVALID');
 }
 return ids;
}
function limits(value,profile='legacy'){
 const keys=['max_recipients','max_body_bytes','max_files','max_file_bytes','max_total_file_bytes','max_mime_bytes','allowed_media_types'];
 const native=profile==='native';
 if(!exact(value,keys)||['max_recipients','max_body_bytes','max_files','max_file_bytes','max_total_file_bytes','max_mime_bytes'].some(key=>!Number.isSafeInteger(value[key])||value[key]<1)
   ||value.max_recipients>200||value.max_files>(native?32:16)||value.max_body_bytes>1048576||value.max_file_bytes>(native?26214400:8388608)
   ||value.max_total_file_bytes>(native?26214400:16777216)||value.max_mime_bytes>(native?36700160:25165824)
   ||!Array.isArray(value.allowed_media_types)||value.allowed_media_types.length<1||value.allowed_media_types.length>32||value.allowed_media_types.some(type=>!clean(type,100)||!/^[-\w.+]+\/[-\w.+]+$/u.test(type)))fail('OUTGOING_LIMITS_INVALID');
 return structuredClone(value);
}
function resolveDraft(value,reference,profile='legacy',allowEmptyRecipients=false){
 if(!value||!exact(value.scope,['org_id','owner_id','installation_id']))fail('OUTGOING_HOST_AUTHORITY_INVALID');
 Object.values(value.scope).forEach(id);const scope={...value.scope},draft=value.draft,policy=limits(value.limits,profile),capturedAt=timestamp(value.captured_at);
 if(!draft||value.account_id!==reference.account_id||draft.account_id!==value.account_id||draft.draft_id!==reference.draft_id||draft.revision!==reference.expected_revision
   ||!Number.isSafeInteger(value.authority_epoch)||value.authority_epoch<1||!['gmail','microsoft','imap_smtp'].includes(value.provider)
   ||!['compose','reply','reply_all','forward'].includes(draft.mode))fail('OUTGOING_DRAFT_STALE');
 const from=typedMailbox(draft.from),verified=mailboxes(value.verified_from,32);
 if(!verified.some(row=>canonical(row)===canonical(from)))fail('OUTGOING_FROM_NOT_VERIFIED');
 const selected=recipients(mailboxes(draft.to,policy.max_recipients),mailboxes(draft.cc,policy.max_recipients),mailboxes(draft.bcc,policy.max_recipients));
 if(!allowEmptyRecipients&&selected.to.length+selected.cc.length+selected.bcc.length<1||selected.to.length+selected.cc.length+selected.bcc.length>policy.max_recipients)fail('OUTGOING_RECIPIENT_LIMIT');
 if(!clean(draft.subject,profile==='native'?998:200,profile==='native'))fail('OUTGOING_SUBJECT_INVALID');
 if(!['plain','safe_html'].includes(draft.body_format))fail('OUTGOING_BODY_FORMAT_INVALID');
 const body=copyBytes(draft.body_bytes,policy.max_body_bytes);let text;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{fail('OUTGOING_BODY_UTF8_INVALID');}
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text))fail('OUTGOING_BODY_INVALID');
 let html=null,htmlBytes=null;
 if(draft.body_format==='safe_html'){
  htmlBytes=copyBytes(draft.body_html_bytes,policy.max_body_bytes);
  try{html=new TextDecoder('utf-8',{fatal:true}).decode(htmlBytes);if(html==='')fail('OUTGOING_BODY_INVALID');}
  catch{fail('OUTGOING_BODY_INVALID');}
 }else if(draft.body_html_bytes!==undefined)fail('OUTGOING_BODY_FORMAT_INVALID');
 let parent=null;
 if(draft.reply_parent!==null){
  const input=draft.reply_parent;
  if(!input||input.account_id!==value.account_id||input.org_id!==scope.org_id||input.owner_id!==scope.owner_id)fail('OUTGOING_REPLY_PARENT_DENIED');
  if(!Array.isArray(input.references)||input.references.length>32)fail('OUTGOING_REPLY_HEADERS_INVALID');
  parent={logical_message_id:id(input.logical_message_id),message_id:messageId(input.message_id),references:input.references.map(messageId)};
  if(value.provider==='gmail'&&['reply','reply_all'].includes(draft.mode))parent.thread_id=id(input.thread_id);
  if(parent.references.join(' ').length>1000)fail('OUTGOING_REPLY_HEADERS_INVALID');
 }
 if(['reply','reply_all'].includes(draft.mode)&&!parent)fail('OUTGOING_REPLY_PARENT_DENIED');
 if(!Array.isArray(draft.files)||draft.files.length>policy.max_files)fail('OUTGOING_FILE_LIMIT');
 let total=0;const seenFiles=new Set(),fileBytes=[],files=draft.files.map(file=>{
  if(!file||file.account_id!==value.account_id||file.org_id!==scope.org_id||file.owner_id!==scope.owner_id
    ||!exact(file.parent,['kind','id'])||!(file.parent.kind==='draft'&&file.parent.id===draft.draft_id||file.parent.kind==='message'&&parent&&file.parent.id===parent.logical_message_id)
    ||file.availability!=='ready')fail('OUTGOING_FILE_PROVENANCE_DENIED');
  const fileId=id(file.file_id);if(seenFiles.has(fileId))fail('OUTGOING_FILE_INVALID');seenFiles.add(fileId);
  if(!clean(file.filename,profile==='native'?255:200)||/[\\/]/u.test(file.filename)||!clean(file.media_type,100)||!policy.allowed_media_types.includes(file.media_type))fail('OUTGOING_FILE_INVALID');
  const bytes=copyBytes(file.bytes,policy.max_file_bytes);total+=bytes.byteLength;
  if(file.byte_count!==bytes.byteLength||file.digest!==hash(bytes)||total>policy.max_total_file_bytes)fail('OUTGOING_FILE_BYTES_CHANGED');
  const expiresAt=timestamp(file.expires_at);if(expiresAt<=capturedAt)fail('OUTGOING_FILE_EXPIRED');
  fileBytes.push(bytes);return {file_id:fileId,account_id:file.account_id,org_id:file.org_id,owner_id:file.owner_id,parent:{...file.parent},
   filename:file.filename,media_type:file.media_type,byte_count:bytes.byteLength,digest:file.digest,expires_at:expiresAt};
 });
 let inlineFileIds=[];
 if(html!==null){try{inlineFileIds=validateComposeBody(html,text,profile,files,fileBytes,draft.draft_id);}catch{body.fill(0);htmlBytes?.fill(0);fileBytes.forEach(bytes=>bytes.fill(0));fail('OUTGOING_BODY_INVALID');}}
 const transportKind=({gmail:'gmail_raw',microsoft:'graph_raw',imap_smtp:'smtp_raw'})[value.provider];
 const replyHeaders=['reply','reply_all'].includes(draft.mode)?{in_reply_to:parent.message_id,references:[...new Set([...parent.references,parent.message_id])]}:null;
 if(replyHeaders&&replyHeaders.references.join(' ').length>1000)fail('OUTGOING_REPLY_HEADERS_INVALID');
 let calendarText=null,calendar=null;
 if(value.calendar_reply!==undefined){
  const reply=value.calendar_reply;
  if(profile!=='native'||!exact(reply,['ics_text','method'])||reply.method!=='REPLY'||typeof reply.ics_text!=='string'||Buffer.byteLength(reply.ics_text)>262144||/[\u0000\u000b\u000c]/u.test(reply.ics_text))fail('OUTGOING_CALENDAR_REPLY_INVALID');
  const lines=reply.ics_text.replace(/\r\n/gu,'\n').split('\n').filter(Boolean);
  if(lines[0]!=='BEGIN:VCALENDAR'||lines.at(-1)!=='END:VCALENDAR'||lines.filter(line=>line==='METHOD:REPLY').length!==1||lines.some(line=>line.startsWith('METHOD:')&&line!=='METHOD:REPLY')||lines.filter(line=>line==='BEGIN:VEVENT').length!==1)fail('OUTGOING_CALENDAR_REPLY_INVALID');
  calendarText=reply.ics_text;calendar={method:'REPLY',byte_count:Buffer.byteLength(calendarText),digest:hash(calendarText)};
 }
 const payload={schema_version:'deft.email_outgoing_snapshot.v1',scope,account_id:value.account_id,authority_epoch:value.authority_epoch,provider:value.provider,
  transport_kind:transportKind,draft_id:draft.draft_id,draft_revision:draft.revision,mode:draft.mode,verified_from:from,...selected,subject:draft.subject,
  body:{format:draft.body_format,byte_count:body.byteLength,digest:hash(body),...(htmlBytes?{html:{byte_count:htmlBytes.byteLength,digest:hash(htmlBytes)}}:{})},files,reply_parent:parent,reply_headers:replyHeaders,captured_at:capturedAt,message_id:messageId(value.message_id),limits:policy,...(calendar?{calendar_reply:calendar}:{})};
 return {payload,body,text,html,htmlBytes,fileBytes,calendarText,inlineFileIds};
}
function snapshotView(metadata,mimeBytes,bodyBytes,fileBytes,htmlBytes){
 const view={...metadata,get mime_bytes(){return Buffer.from(mimeBytes);},get body_bytes(){return Buffer.from(bodyBytes);},get file_bytes(){return Object.freeze(fileBytes.map(bytes=>Buffer.from(bytes)));}};
 if(htmlBytes)Object.defineProperty(view,'body_html_bytes',{enumerable:true,get(){return Buffer.from(htmlBytes);}});
 Object.defineProperty(view,'dispose',{enumerable:false,value(){mimeBytes.fill(0);bodyBytes.fill(0);fileBytes.forEach(bytes=>bytes.fill(0));htmlBytes?.fill(0);}});
 return Object.freeze(view);
}
async function compileMime({payload,text,html,fileBytes,calendarText,inlineFileIds=[]},keepBcc=payload.transport_kind!=='smtp_raw'){
 const envelope=frozen({from:payload.verified_from.address,to:[...payload.to,...payload.cc,...payload.bcc].map(row=>row.address)});
 const address=row=>({address:row.address,name:row.display_name});
 const compiled=new MailComposer({from:address(payload.verified_from),to:payload.to.map(address),cc:payload.cc.map(address),bcc:payload.bcc.map(address),
  subject:payload.subject,text,...(html!==null?{html}:{}),...(calendarText?{icalEvent:{method:'REPLY',content:calendarText}}:{}),textEncoding:'base64',messageId:payload.message_id,date:new Date(payload.captured_at),envelope,newline:'windows',baseBoundary:hash(canonical(payload)),
  disableFileAccess:true,disableUrlAccess:true,...(payload.reply_headers?{inReplyTo:payload.reply_headers.in_reply_to,references:payload.reply_headers.references}:{}),
  attachments:payload.files.map((file,index)=>({filename:file.filename,contentType:file.media_type,contentDisposition:inlineFileIds.includes(file.file_id)?'inline':'attachment',
   ...(inlineFileIds.includes(file.file_id)?{cid:nativeComposeImageCid(file.file_id)}:{}),content:fileBytes[index]}))}).compile();
 compiled.keepBcc=keepBcc;
 const bytes=await new Promise((accept,reject)=>compiled.build((error,value)=>error?reject(error):accept(value)));
 if(!Buffer.isBuffer(bytes)||bytes.byteLength>payload.limits.max_mime_bytes){bytes?.fill?.(0);fail('OUTGOING_MIME_LIMIT');}
 return {bytes,envelope};
}
/** Trusted host-only draft serializer. It cannot reserve or send anything.
 * Valid unfinished drafts may have no recipients; Bcc remains in provider
 * draft storage. Send retains its separate recipient/reservation requirements. */
export async function serializeNativeDraft(value,reference){
 if(!exact(reference,['account_id','draft_id','expected_revision'])||!Number.isSafeInteger(reference.expected_revision)||reference.expected_revision<1)fail('OUTGOING_REFERENCE_INVALID');
 id(reference.account_id);id(reference.draft_id);
 const resolved=resolveDraft(value,{...reference},'native',true);
 try{const {bytes}=await compileMime(resolved,true);return {mime_bytes:bytes,mime_digest:hash(bytes)};}
 finally{resolved.body.fill(0);resolved.htmlBytes?.fill(0);resolved.fileBytes.forEach(bytes=>bytes.fill(0));}
}
/** Proposal seam: resolve supplies the current draft; seal retains exact bytes;
 * verify checks host custody and current authority; reserve atomically rechecks
 * authority and returns reserved/replay/unknown for the exact operation identity.
 * This module supplies no host keys, storage, authority or provider effects. */
export function createOutgoingSnapshotService({resolve,seal,verify,reserve,profile='legacy'}={}){
 if([resolve,seal,verify,reserve].some(callback=>typeof callback!=='function'))fail('OUTGOING_HOST_CONTRACT_REQUIRED');
 if(!['legacy','native'].includes(profile))fail('OUTGOING_PROFILE_INVALID');
 return Object.freeze({
  async prepare(reference){
   if(!exact(reference,['account_id','draft_id','expected_revision'])||!Number.isSafeInteger(reference.expected_revision)||reference.expected_revision<1)fail('OUTGOING_REFERENCE_INVALID');
   id(reference.account_id);id(reference.draft_id);const request={...reference};
   const {payload,body,text,html,htmlBytes,fileBytes,calendarText,inlineFileIds}=resolveDraft(await resolve(Object.freeze(request)),request,profile);
   const {bytes,envelope}=await compileMime({payload,text,html,fileBytes,calendarText,inlineFileIds});
   const complete=frozen({...payload,envelope,mime:{byte_count:bytes.byteLength,digest:hash(bytes)}}),digest=hash(canonical(complete));
   const sealed=await seal(Object.freeze({payload:complete,payload_digest:digest,mime_bytes:Buffer.from(bytes),body_bytes:Buffer.from(body),...(htmlBytes?{body_html_bytes:Buffer.from(htmlBytes)}:{}),file_bytes:fileBytes.map(value=>Buffer.from(value))}));
   if(!sealed||!clean(sealed.snapshot_id,256)||!clean(sealed.sealed_contract,4096))fail('OUTGOING_HOST_SEAL_REQUIRED');
   return snapshotView({snapshot_id:sealed.snapshot_id,sealed_contract:sealed.sealed_contract,payload:complete,payload_digest:digest,mime_digest:complete.mime.digest,envelope},bytes,body,fileBytes,htmlBytes);
  },
  async bind(snapshot,operation){
   if(!exact(operation,['operation_id','expected_digest'])||!clean(operation.operation_id,256)||!/^[a-f0-9]{64}$/u.test(operation.expected_digest))fail('OUTGOING_OPERATION_INVALID');
   // Capture all caller-owned metadata before the first host await. A caller can
   // pass a mutable clone, but it cannot switch identity after verification.
   let captured;try{captured=frozen({snapshot_id:snapshot?.snapshot_id,sealed_contract:snapshot?.sealed_contract,payload:structuredClone(snapshot?.payload),
    payload_digest:snapshot?.payload_digest,mime_digest:snapshot?.mime_digest,envelope:structuredClone(snapshot?.envelope),operation_id:operation.operation_id,expected_digest:operation.expected_digest});}catch{fail('OUTGOING_SNAPSHOT_CHANGED');}
   const {snapshot_id,sealed_contract,payload,payload_digest,mime_digest,envelope,operation_id,expected_digest}=captured;
   if(!clean(snapshot_id,256)||!clean(sealed_contract,4096)||!payload||hash(canonical(payload))!==payload_digest
     ||payload_digest!==expected_digest||mime_digest!==payload.mime?.digest||canonical(envelope)!==canonical(payload.envelope)||!payload.limits||!payload.body||!Array.isArray(payload.files))fail('OUTGOING_SNAPSHOT_CHANGED');
   const mime=copyBytes(snapshot.mime_bytes,payload.limits.max_mime_bytes),body=copyBytes(snapshot.body_bytes,payload.limits.max_body_bytes),files=snapshot.file_bytes;
   if(hash(mime)!==mime_digest||mime.byteLength!==payload.mime.byte_count||hash(body)!==payload.body.digest||body.byteLength!==payload.body.byte_count
     ||!Array.isArray(files)||files.length!==payload.files.length||files.some((bytes,index)=>!(bytes instanceof Uint8Array)||bytes.byteLength!==payload.files[index].byte_count||hash(bytes)!==payload.files[index].digest))fail('OUTGOING_SNAPSHOT_BYTES_CHANGED');
   if(payload.body.format==='safe_html'){
    const html=copyBytes(snapshot.body_html_bytes,payload.limits.max_body_bytes);
    if(!exact(payload.body.html,['byte_count','digest'])||hash(html)!==payload.body.html.digest||html.byteLength!==payload.body.html.byte_count)fail('OUTGOING_SNAPSHOT_BYTES_CHANGED');
    try{validateComposeBody(new TextDecoder('utf-8',{fatal:true}).decode(html),new TextDecoder('utf-8',{fatal:true}).decode(body),profile,payload.files,files,payload.draft_id);}
    catch{fail('OUTGOING_SNAPSHOT_BYTES_CHANGED');}
   }else if(payload.body.format!=='plain'||payload.body.html!==undefined||snapshot.body_html_bytes!==undefined)fail('OUTGOING_SNAPSHOT_CHANGED');
   if(await verify(Object.freeze({snapshot_id,sealed_contract,payload,payload_digest,mime_digest}))!==true)fail('OUTGOING_HOST_AUTHORITY_DENIED');
   const thread=payload.provider==='gmail'&&['reply','reply_all'].includes(payload.mode)?id(payload.reply_parent?.thread_id):null;
   const identity=frozen({operation_id,snapshot_id,snapshot_digest:payload_digest,mime_digest,
    scope:{...payload.scope},account_id:payload.account_id,authority_epoch:payload.authority_epoch,draft_id:payload.draft_id,draft_revision:payload.draft_revision});
   let state;try{state=await reserve(identity);}catch{fail('OUTGOING_OPERATION_UNCERTAIN_NO_RESEND');}
   if(state==='replay')return frozen({...identity,replay:true});
   if(state!=='reserved')fail('OUTGOING_OPERATION_UNCERTAIN_NO_RESEND');
   const transport={...identity,from_address:payload.verified_from.address,transport_kind:payload.transport_kind,envelope,...(thread?{thread_id:thread}:{})};
   return Object.freeze({...transport,get mime_bytes(){return Buffer.from(mime);}});
  },
 });
}
