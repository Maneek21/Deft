import {createHash,randomBytes} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {singleAddress} from '../account-config.mjs';
import {createGmailAdapter} from './gmail.mjs';
import {createApiTransport,pathId,MailProviderError} from './contract.mjs';

export const RECIPIENT_VERIFICATION_LIMITS=Object.freeze({candidates:3,parts:64,attachments:8,body_bytes:65536,attachment_bytes:5242880,total_bytes:8388608,timeout_ms:30000});
const base='https://gmail.googleapis.com/gmail/v1/users/me',marker='Deft probe nonce: ';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const productionMessageId=value=>{const match=typeof value==='string'&&/^<([A-Za-z0-9_-]{43})@deft\.invalid>$/.exec(value);return Boolean(match&&Buffer.from(match[1],'base64url').length===32&&Buffer.from(match[1],'base64url').toString('base64url')===match[1]);};
const plain=value=>typeof value==='string'&&value.length>0&&!/[\r\n\0]/.test(value);
const addressMatches=(value,expected)=>typeof value==='string'&&singleAddress(value)&&value.toLowerCase()===expected;
const canonical=value=>value.replace(/\r\n/g,'\n');
const canonicalJson=value=>Array.isArray(value)?`[${value.map(canonicalJson).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`:JSON.stringify(value);
const invalid=()=>{throw new MailProviderError('EMAIL_RECIPIENT_PROBE_INVALID');};
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
class Mismatch extends Error {}
const mismatch=reason=>{throw new Mismatch(reason);};

/** Creates expectation data only. Submit its exact recipient, subject, body and files
 * through Deft, then bind the host's retained Message-ID before verifying receipt. */
export function createRecipientVerificationProbe({recipient,expected_sender,subject,body_text,attachments=[]}){
 if(!singleAddress(recipient)||!singleAddress(expected_sender)||typeof body_text!=='string'||body_text.includes('\0')||body_text.includes(marker)||/\r(?!\n)/.test(body_text)||!Array.isArray(attachments)||attachments.length>RECIPIENT_VERIFICATION_LIMITS.attachments)invalid();
 const nonce=randomBytes(32).toString('base64url'),message_id=`<deft-probe.${nonce}@probe.deft.invalid>`;
 subject??=`Deft controlled recipient probe ${nonce.slice(0,12)}`;
 if(!plain(subject)||subject.length>200)invalid();
 const body=canonical(body_text).replace(/\n*$/,'')+`\n\n${marker}${nonce}\n`;
 if(Buffer.byteLength(body)>RECIPIENT_VERIFICATION_LIMITS.body_bytes)invalid();
 let total=Buffer.byteLength(body);
 const files=attachments.map(file=>{
  if(!exactKeys(file,['filename','media_type','bytes'])||!plain(file.filename)||file.filename.length>255||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/.test(file.media_type)||!(file.bytes instanceof Uint8Array)||file.bytes.byteLength>RECIPIENT_VERIFICATION_LIMITS.attachment_bytes)invalid();
  const bytes=Buffer.from(file.bytes);total+=bytes.byteLength;
  return Object.freeze({filename:file.filename,media_type:file.media_type,size_bytes:bytes.byteLength,sha256:sha(bytes)});
 });
 if(total>RECIPIENT_VERIFICATION_LIMITS.total_bytes||new Set(files.map(file=>file.filename)).size!==files.length)invalid();
 return Object.freeze({schema_version:'deft.email_recipient_probe.v1',nonce,message_id,recipient:recipient.toLowerCase(),expected_sender:expected_sender.toLowerCase(),subject,body_text:body,body_sha256:sha(Buffer.from(body)),attachments:Object.freeze(files)});
}

function expectation(input){
 const value=structuredClone(input);
 const bound=value?.schema_version==='deft.email_recipient_probe.v2';
 if(!exactKeys(value,['schema_version','nonce','message_id','recipient','expected_sender','subject','body_text','body_sha256','attachments',...(bound?['payload_digest']:[])])||!['deft.email_recipient_probe.v1','deft.email_recipient_probe.v2'].includes(value.schema_version)||!/^[A-Za-z0-9_-]{43}$/.test(value.nonce)||Buffer.from(value.nonce,'base64url').toString('base64url')!==value.nonce||(bound?!productionMessageId(value.message_id)||!/^[a-f0-9]{64}$/.test(value.payload_digest):value.message_id!==`<deft-probe.${value.nonce}@probe.deft.invalid>`)||!singleAddress(value.recipient)||!singleAddress(value.expected_sender)||value.recipient!==value.recipient.toLowerCase()||value.expected_sender!==value.expected_sender.toLowerCase()||!plain(value.subject)||value.subject.length>200||typeof value.body_text!=='string'||value.body_text.includes('\r')||value.body_text.includes('\0')||!value.body_text.endsWith(`\n\n${marker}${value.nonce}\n`)||value.body_text.split(marker).length!==2||Buffer.byteLength(value.body_text)>RECIPIENT_VERIFICATION_LIMITS.body_bytes||value.body_sha256!==sha(Buffer.from(value.body_text))||!Array.isArray(value.attachments)||value.attachments.length>RECIPIENT_VERIFICATION_LIMITS.attachments)invalid();
 let total=Buffer.byteLength(value.body_text);
 for(const file of value.attachments){
  if(!exactKeys(file,['filename','media_type','size_bytes','sha256'])||!plain(file.filename)||file.filename.length>255||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/.test(file.media_type)||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||file.size_bytes>RECIPIENT_VERIFICATION_LIMITS.attachment_bytes||!/^([a-f0-9]{64})$/.test(file.sha256))invalid();
  total+=file.size_bytes;
 }
 if(total>RECIPIENT_VERIFICATION_LIMITS.total_bytes||new Set(value.attachments.map(file=>file.filename)).size!==value.attachments.length)invalid();
 return value;
}

/** Bind read-only receipt expectations to metadata obtained through the authenticated
 * host payload channel. This neither authenticates its source nor authorizes Send;
 * the caller must obtain retained metadata from that channel, never from email content.
 * Content stays fixed; only the host-generated Message-ID and payload digest are added. */
export function bindRecipientProbeToPayload(input,metadata){
 const probe=expectation(input);if(probe.schema_version!=='deft.email_recipient_probe.v1')invalid();
 let captured,encoded;
 try{captured=structuredClone(metadata);encoded=canonicalJson(captured?.payload);}catch{invalid();}
 const payload=captured?.payload;
 if(captured?.schema_version!=='deft.email_action_payload.v1'||typeof encoded!=='string'||Buffer.byteLength(encoded)>131072
   ||!payload||typeof payload!=='object'||Array.isArray(payload)||sha(encoded)!==captured.payload_digest||payload.schema_version!=='deft.email_outgoing_snapshot.v1'||payload.mode!=='compose'
   ||!['gmail','microsoft'].includes(payload.provider)||!productionMessageId(payload.message_id)
   ||!addressMatches(payload.verified_from?.address,probe.expected_sender)||!Array.isArray(payload.to)||payload.to.length!==1||!addressMatches(payload.to[0]?.address,probe.recipient)
   ||!Array.isArray(payload.cc)||payload.cc.length||!Array.isArray(payload.bcc)||payload.bcc.length||payload.subject!==probe.subject
   ||captured.body_text!==probe.body_text||payload.body?.format!=='plain'||payload.body.byte_count!==Buffer.byteLength(probe.body_text)||payload.body.digest!==probe.body_sha256
   ||!addressMatches(payload.envelope?.from,probe.expected_sender)||!Array.isArray(payload.envelope?.to)||payload.envelope.to.length!==1||!addressMatches(payload.envelope.to[0],probe.recipient)
   ||!Array.isArray(payload.files)||payload.files.length!==probe.attachments.length||payload.files.some(file=>!file||typeof file!=='object')||new Set(payload.files.map(file=>file.filename)).size!==payload.files.length)invalid();
 for(const expected of probe.attachments){
  const file=payload.files.find(value=>value.filename===expected.filename);
  if(!file||file.media_type!==expected.media_type||file.byte_count!==expected.size_bytes||file.digest!==expected.sha256)invalid();
 }
 return Object.freeze({...probe,schema_version:'deft.email_recipient_probe.v2',message_id:payload.message_id,payload_digest:captured.payload_digest,
  attachments:Object.freeze(probe.attachments.map(file=>Object.freeze(file)))});
}

async function addresses(value){
 const parsed=await simpleParser(Buffer.from(`From: ${value}\r\n\r\n`),{skipHtmlToText:true,skipTextToHtml:true});
 return parsed.from?.value?.map(row=>row.address?.toLowerCase())??[];
}
async function summaryMatches(message,probe){
 return message?.provider==='gmail'&&message.message_id===probe.message_id&&message.subject===probe.subject&&JSON.stringify(await addresses(message.sender))===JSON.stringify([probe.expected_sender])&&JSON.stringify(await addresses(message.recipients))===JSON.stringify([probe.recipient])&&!message.cc;
}
function headerMap(headers){
 if(!Array.isArray(headers)||headers.length>200)mismatch('headers');
 const map=new Map();let size=0;
 for(const row of headers){
  if(!row||!plain(row.name)||row.name.length>100||typeof row.value!=='string'||row.value.length>8192||/[\r\n\0]/.test(row.value))mismatch('headers');
  size+=row.name.length+row.value.length;if(size>32768)mismatch('headers');
  const name=row.name.toLowerCase(),values=map.get(name)??[];values.push(row.value);map.set(name,values);
 }
 return map;
}
function one(map,name,required=false){const values=map.get(name)??[];if(values.length>1||required&&values.length!==1)mismatch('headers');return values[0]??'';}
function decode(data,size,max){
 if(typeof data!=='string'||data.length>Math.ceil(max/3)*4+4||!/^[A-Za-z0-9_-]*={0,2}$/.test(data)||data.includes('=')&&data.length%4!==0)mismatch('bytes');
 const raw=data.replace(/=+$/,''),bytes=Buffer.from(raw,'base64url');
 if(bytes.toString('base64url')!==raw||!Number.isSafeInteger(size)||size!==bytes.byteLength||bytes.byteLength>max)mismatch('bytes');
 return bytes;
}

/** Read-only recipient evidence; acceptance acknowledgements cannot satisfy this interface.
 * Gmail search/full MIME/attachment representations: developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
 * Body hashes cover decoded UTF-8 plain text with CRLF normalized to LF; files cover exact bytes.
 */
export async function verifyGmailRecipientProbe({provider_options,probe:input}){
 const probe=expectation(input),options={...provider_options,account:structuredClone(provider_options?.account),fetch:provider_options?.fetch??globalThis.fetch};
 const api=createApiTransport(options,'https://gmail.googleapis.com'),adapter=createGmailAdapter(options);
 if(api.account.provider!=='gmail'||api.account.primary_address.toLowerCase()!==probe.recipient)invalid();
 const budget={remaining:RECIPIENT_VERIFICATION_LIMITS.total_bytes*2,deadline:Date.now()+RECIPIENT_VERIFICATION_LIMITS.timeout_ms};
 const active=()=>{if(Date.now()>=budget.deadline)throw new MailProviderError('EMAIL_RECIPIENT_VERIFICATION_DEADLINE');};
 const result=(status,extra={})=>({schema_version:'deft.email_recipient_verification.v1',status,message_id:probe.message_id,recipient:probe.recipient,exact_receipts:[],mismatches:[],...extra});
 async function partBytes(part,max,messageId){
  active();const body=part.body;
  if(!body||!Number.isSafeInteger(body.size)||body.size<0||body.size>max)mismatch('bytes');
  if(body.attachmentId!==undefined){
   if(body.data!==undefined||!plain(body.attachmentId)||body.attachmentId.length>256)mismatch('bytes');
   const value=await api.request(`${base}/messages/${pathId(messageId)}/attachments/${pathId(body.attachmentId)}`,{maxBytes:Math.ceil(max/3)*4+2048,budget});active();
   if(value.size!==body.size)mismatch('bytes');return decode(value.data,value.size,max);
  }
  return decode(body.data??(body.size===0?'':undefined),body.size,max);
 }
 async function inspect(message){
  active();const detail=await adapter.readMessage(message.locator);active();
  if(detail.message.account_id!==api.account.account_id||!await summaryMatches(detail.message,probe)||detail.body?.format!=='gmail_mime'||detail.body.untrusted!==true)mismatch('identity');
  const root=detail.body.payload,headers=headerMap(root?.headers);
  if(one(headers,'message-id',true)!==probe.message_id||one(headers,'subject',true)!==probe.subject||JSON.stringify(await addresses(one(headers,'from',true)))!==JSON.stringify([probe.expected_sender])||JSON.stringify(await addresses(one(headers,'to',true)))!==JSON.stringify([probe.recipient])||one(headers,'cc')||one(headers,'bcc'))mismatch('headers');
  const delivered=one(headers,'delivered-to');if(delivered&&delivered.toLowerCase()!==probe.recipient)mismatch('headers');
  const leaves=[];let parts=0;
  function visit(part,depth=0){
   if(!part||typeof part!=='object'||++parts>RECIPIENT_VERIFICATION_LIMITS.parts||depth>8||typeof part.mimeType!=='string')mismatch('mime_structure');
   if(part.mimeType.startsWith('multipart/')){
    if(!['multipart/mixed','multipart/alternative'].includes(part.mimeType)||!Array.isArray(part.parts)||part.parts.length<1)mismatch('mime_structure');
    for(const child of part.parts)visit(child,depth+1);
   }else{if(part.parts!==undefined&&(!Array.isArray(part.parts)||part.parts.length))mismatch('mime_structure');leaves.push(part);}
  }
  visit(root);
  const bodyParts=leaves.filter(part=>part.mimeType==='text/plain'&&!part.filename),files=leaves.filter(part=>part.filename);
  if(bodyParts.length!==1||leaves.length!==bodyParts.length+files.length||files.length!==probe.attachments.length)mismatch('mime_structure');
  const contentType=one(headerMap(bodyParts[0].headers??[]),'content-type'),charset=/charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]?.toLowerCase()??'us-ascii';
  if(!['utf-8','utf8','us-ascii'].includes(charset))mismatch('body');
  const bodyBytes=await partBytes(bodyParts[0],RECIPIENT_VERIFICATION_LIMITS.body_bytes,message.locator.message_id);
  if(charset==='us-ascii'&&bodyBytes.some(byte=>byte>127))mismatch('body');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bodyBytes);}catch{mismatch('body');}
  text=canonical(text);if(text!==probe.body_text||sha(Buffer.from(text))!==probe.body_sha256||text.split(marker).length!==2)mismatch('body');
  if(new Set(files.map(file=>file.filename)).size!==files.length)mismatch('attachments');
  for(const expected of probe.attachments){
   const part=files.find(file=>file.filename===expected.filename);
   if(!part||part.mimeType!==expected.media_type||part.body?.size!==expected.size_bytes)mismatch('attachments');
  }
  for(const expected of probe.attachments){
   const part=files.find(file=>file.filename===expected.filename),bytes=await partBytes(part,expected.size_bytes,message.locator.message_id);
   if(sha(bytes)!==expected.sha256)mismatch('attachments');
  }
  await api.authority('read');active();
  return {provider_message_id:message.locator.message_id,provider_thread_id:message.locator.thread_id,body_sha256:probe.body_sha256,attachments:probe.attachments.map(file=>({...file}))};
 }
 try{
  const profile=await api.request(`${base}/profile`,{maxBytes:4096,budget});active();
  if(profile.emailAddress?.toLowerCase()!==probe.recipient)return result('unavailable',{reason_code:'EMAIL_RECIPIENT_MAILBOX_MISMATCH'});
  const query=`rfc822msgid:${probe.message_id} to:${probe.recipient} from:${probe.expected_sender}`;
  const page=await adapter.searchMessages({query,limit:RECIPIENT_VERIFICATION_LIMITS.candidates,cursor:null,include_spam_trash:true});active();
  if(page.account_id!==api.account.account_id||!Array.isArray(page.messages)||page.messages.length>RECIPIENT_VERIFICATION_LIMITS.candidates||page.next_cursor!==null||page.has_more||page.complete!==true||page.failures.length)return result('ambiguous',{reason_code:'EMAIL_RECIPIENT_QUERY_INCOMPLETE'});
  if(new Set(page.messages.map(message=>message.locator.message_id)).size!==page.messages.length)return result('ambiguous',{reason_code:'EMAIL_RECIPIENT_QUERY_DUPLICATE_ID'});
  if(!page.messages.length)return result('not_observed');
  const exact_receipts=[],mismatches=[];
  for(const message of page.messages){
   if(!await summaryMatches(message,probe)){mismatches.push({provider_message_id:message.locator.message_id,reason:'identity'});continue;}
   try{exact_receipts.push(await inspect(message));}catch(error){if(!(error instanceof Mismatch))throw error;mismatches.push({provider_message_id:message.locator.message_id,reason:error.message});}
  }
  await api.authority('read');active();
  return result(mismatches.length?(exact_receipts.length?'ambiguous':'mismatch'):exact_receipts.length===1?'receipt_observed':'duplicate_receipts',{exact_receipts,mismatches});
 }catch(error){
  if(error instanceof MailProviderError)return result('unavailable',{reason_code:error.code});
  throw error;
 }
}
