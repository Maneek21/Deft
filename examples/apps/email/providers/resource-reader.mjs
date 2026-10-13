import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {simpleParser} from 'mailparser';
import addressParser from 'nodemailer/lib/addressparser/index.js';
import {LogicalMailIndex,LOGICAL_MAIL_LIMITS} from '../logical-mail-index.mjs';
import {singleAddress} from '../account-config.mjs';
import {oauthFail} from './oauth-contract.mjs';
import {normalizeEmailMessageDetail,boundedEmailContent} from '../message-reader.mjs';
const HEADER_METADATA_FIELDS=Object.freeze({account_id:200,primary_address:256,verified_sender_identities:8192,reply_from:2048,reply_to:2048,reply_to_list:2048,reply_cc:2048,subject:200,message_id:200,references:1000});
export const EMAIL_CONVERSATION_METADATA_FIELDS=Object.freeze({conversation_id:96,conversation_coverage_state:16,conversation_indexed_count:5,conversation_exact_count:5,conversation_observed_at:24,conversation_drained:5,mailbox_reset_required:5});
export const EMAIL_DOCUMENT_METADATA_FIELDS=Object.freeze({...HEADER_METADATA_FIELDS,...EMAIL_CONVERSATION_METADATA_FIELDS});
const fail=()=>oauthFail('EMAIL_CONNECTION_RESOURCE_DENIED');
const clean=(v,max,empty=true)=>typeof v==='string'&&(empty||v.length>0)&&v.length<=max&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(v);
const validId=v=>clean(v,200,false)&&/^<[^<>\s@]+@[^<>\s@]+>$/u.test(v);
export function parsedMailboxes(value){
 if(!clean(value,2048))fail();if(!value)return [];
 const rows=addressParser(value);if(rows.length>32||rows.some(row=>row.group||!singleAddress(row.address)||!clean(row.name??'',128)))fail();
 return rows.map(row=>({address:row.address,display_name:row.name??''}));
}
/** Native input uses the same explicit 200 / 16 KiB UTF-8 profile as app-kit.
 * Legacy parsedMailboxes and document metadata admission stay unchanged. */
export function parsedNativeMailboxes(value){
 const controls=/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
 const formed=text=>{for(let i=0;i<text.length;i++){const unit=text.charCodeAt(i);if(unit>=0xd800&&unit<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(unit>=0xdc00&&unit<=0xdfff)return false;}return true;};
 if(typeof value!=='string'||!formed(value)||controls.test(value)||Buffer.byteLength(value,'utf8')>16384)fail();
 if(!value.trim())return [];
 const tokens=[];let token='',quoted=false,bracket=false,escaped=false;
 for(const char of value){
  if(escaped){token+=char;escaped=false;continue;}if(quoted&&char==='\\'){token+=char;escaped=true;continue;}
  if(char==='"')quoted=!quoted;
  if(!quoted&&char==='<'){if(bracket)fail();bracket=true;}if(!quoted&&char==='>'){if(!bracket)fail();bracket=false;}
  if(!quoted&&!bracket&&/[,;]/u.test(char)){if(token.trim())tokens.push(token);token='';}else token+=char;
  if(tokens.length>200)fail();
 }
 if(quoted||bracket||escaped)fail();if(token.trim())tokens.push(token);if(!tokens.length||tokens.length>200)fail();
 return tokens.map(token=>{
  const text=token.trim(),open=text.indexOf('<');let address=text,name='';
  if(open>=0){if(!text.endsWith('>')||text.indexOf('<',open+1)>=0||text.indexOf('>')!==text.length-1)fail();address=text.slice(open+1,-1);name=text.slice(0,open).trim();
   if(name.startsWith('"')||name.endsWith('"')){if(!/^"(?:[^"\\]|\\["\\])*"$/u.test(name))fail();name=name.slice(1,-1).replace(/\\(["\\])/gu,'$1');}else if(name.includes('"'))fail();}
  address=address.trim();name=name.trim().normalize('NFC');const at=address.lastIndexOf('@'),local=address.slice(0,at),domain=address.slice(at+1).toLowerCase();
  if(address.length>200||at<1||at>64||!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(address)
   ||local.startsWith('.')||local.endsWith('.')||local.includes('..')||!domain.includes('.')
   ||domain.split('.').some(label=>!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
   ||name.length>128||controls.test(name)||/[<>]/u.test(name)||!formed(name))fail();
  return {address:`${local}@${domain}`,display_name:name};
 });
}
export async function loadPrivateMailIndex(path){
 if(typeof path!=='string'||!isAbsolute(path))fail();
 const moduleRoot=resolve(fileURLToPath(new URL('..',import.meta.url))),resolved=await realpath(path);
 if(resolved===moduleRoot||resolved.startsWith(moduleRoot+sep)||resolved!==resolve(path))fail();
 const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>LOGICAL_MAIL_LIMITS.state_bytes||process.platform!=='win32'&&(stat.mode&0o077)!==0)fail();const bytes=await handle.readFile();if(bytes.length>LOGICAL_MAIL_LIMITS.state_bytes)fail();return JSON.parse(bytes.toString('utf8'));}finally{await handle.close();}
}
export function resolvePrivateRecord({scope,account,state,record}){
 if(!record||typeof record.record_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.record_id)||!clean(record.revision,200,false)
  ||record.data?.account_id!==account.account_id||record.data?.provider!==account.provider||!/^mail_[a-f0-9]{64}$/.test(record.data?.logical_message_id??''))fail();
 const index=new LogicalMailIndex(scope,{state}),parent=index.get(scope,account.account_id,record.data.logical_message_id);
 if(parent.deletion||parent.summary.provider!==account.provider||parent.locator.kind!==account.provider)fail();return parent;
}
function headerMap(rows){
 if(!Array.isArray(rows)||rows.length>200)fail();const map=new Map();
 for(const row of rows){if(!row||typeof row.name!=='string'||typeof row.value!=='string')fail();const key=row.name.toLowerCase();if(!['from','reply-to','to','cc','subject','message-id','references'].includes(key))continue;if(map.has(key))fail();const value=row.value.replace(/\r\n[ \t]+/g,' ');if(!clean(value,8192))fail();map.set(key,value);}
 return key=>map.get(key)??'';
}
async function gmailPlain(payload){
 let count=0,total=0;const plain=[],html=[];
 const visit=part=>{if(++count>64||!part||typeof part.mimeType!=='string')fail();if(part.parts!==undefined){if(!Array.isArray(part.parts)||part.parts.length>64)fail();part.parts.forEach(visit);return;}if(part.filename||!['text/plain','text/html'].includes(part.mimeType))return;
  headerMap(part.headers??[]); // duplicate critical headers still fail
  const contentTypes=(part.headers??[]).filter(row=>row.name?.toLowerCase()==='content-type');if(contentTypes.length>1)fail();const charset=/charset\s*=\s*"?([^;"\s]+)/i.exec(contentTypes[0]?.value??'')?.[1]?.toLowerCase();if(charset&&!['utf-8','us-ascii'].includes(charset))fail();
  const encoded=part.body?.data;if(typeof encoded!=='string'||encoded.length>2796204||!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded))fail();const bytes=Buffer.from(encoded,'base64url'),canonical=bytes.toString('base64url');
  // Gmail may return canonical base64url with its exact trailing padding.
  if(canonical!==encoded.replace(/=+$/,'')||encoded.includes('=')&&encoded!==canonical+'='.repeat((4-canonical.length%4)%4)||part.body.size!==bytes.length||(total+=bytes.length)>2097152)fail();let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail();}(part.mimeType==='text/plain'?plain:html).push(text);
 };visit(payload);if(plain.length>1||!plain.length&&html.length!==1)fail();return plain.length?plain[0]:htmlPlain(html[0]);
}
async function htmlPlain(html){
 const parsed=await simpleParser(Buffer.from('MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+Buffer.from(html).toString('base64')),{skipTextToHtml:true});
 if(typeof parsed.text!=='string')fail();return parsed.text;
}
export async function projectProviderDocument({account,logical_message_id,detail,max_characters,formats=['plain']}){
 if(!Number.isSafeInteger(max_characters)||max_characters<1||max_characters>16384||detail.message.account_id!==account.account_id||detail.message.provider!==account.provider)fail();
 let h,content;if(account.provider==='gmail'){h=headerMap(detail.body.payload?.headers);content=await gmailPlain(detail.body.payload);}else if(account.provider==='microsoft'){h=headerMap(detail.headers);content=detail.body.format==='text'?detail.body.content:await htmlPlain(detail.body.content);}else fail();
 if(typeof content!=='string'||content.length>2097152||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content))fail();
 const metadata={account_id:account.account_id,primary_address:account.primary_address,verified_sender_identities:JSON.stringify(account.verified_sender_identities),reply_from:h('from'),reply_to:h('reply-to'),reply_to_list:h('to'),reply_cc:h('cc'),subject:h('subject'),message_id:h('message-id'),references:h('references')};
 if(account.verified_sender_identities.length>32||Object.entries(HEADER_METADATA_FIELDS).some(([key,max])=>!clean(metadata[key],max)))fail();
 for(const key of ['reply_from','reply_to','reply_to_list','reply_cc'])parsedMailboxes(metadata[key]);
 // Missing/invalid threading headers do not prevent reading; they disable reply.
 const referenceValues=metadata.references.trim()?metadata.references.trim().split(/\s+/):[];
 const reply=validId(metadata.message_id)&&referenceValues.length<=32&&referenceValues.every(validId)&&[...new Set([...referenceValues,metadata.message_id])].join(' ').length<=1000?{logical_message_id,message_id:metadata.message_id,references:referenceValues,from:parsedMailboxes(metadata.reply_from),reply_to:parsedMailboxes(metadata.reply_to),to:parsedMailboxes(metadata.reply_to_list),cc:parsedMailboxes(metadata.reply_cc)}:null;
 if(reply&&account.provider==='gmail'){const locator=detail.message.locator;if(locator?.kind!=='gmail'||!clean(locator.thread_id,256,false))fail();reply.thread_id=locator.thread_id;}
 if(!reply)metadata.message_id='';
 if(!Array.isArray(formats)||!formats.length||formats.length>2||new Set(formats).size!==formats.length||formats.some(format=>!['plain','html'].includes(format)))fail();
 const plain=boundedEmailContent(content,max_characters);
 if(formats.includes('html')){
  const normalized=normalizeEmailMessageDetail(detail,{account_id:account.account_id,logical_message_id});
  if(normalized.body.format==='html'){const html=boundedEmailContent(normalized.body.content,max_characters);return {document:{format:'html',content:html.content,plain_text:plain.content,truncated:html.truncated||normalized.body.truncated||plain.truncated,metadata},reply};}
 }
 if(!formats.includes('plain'))fail();
 return {document:{format:'plain',content:plain.content,truncated:plain.truncated,metadata},reply};
}


/** Historical as-of evidence only. No read-time timestamp or age-based promise.
 * Legacy rows without the exact current epoch/binding are never certified. */
export function projectConversationCoverage({scope,account,state,record,detail,now=Date.now()}){
 const index=new LogicalMailIndex(scope,{state}),parent=index.get(scope,account.account_id,record.logical_message_id);
 if(parent.deletion||parent.conversation_id!==record.conversation_id)fail();
 const page=index.conversationPage(scope,{account_id:account.account_id,conversation_id:parent.conversation_id,limit:1}),coverage=page.coverage,reset=index.hasDeletionGap(scope,account.account_id);
 const observed=coverage.observed_at,validTime=typeof observed==='string'&&observed.length===24&&Number.isFinite(Date.parse(observed))&&new Date(observed).toISOString()===observed&&Date.parse(observed)<=now;
 const bound=Number.isSafeInteger(coverage.authority_epoch)&&typeof coverage.resource_binding_id==='string',current=bound&&coverage.authority_epoch===account.authority_epoch&&coverage.resource_binding_id===account.resource_binding_id;
 const pending=(state.conversation_scans??[]).some(scan=>scan.account_id===account.account_id&&scan.conversation_id===parent.conversation_id);
 const native=detail.message.locator,matched=detail.message.account_id===account.account_id&&detail.message.provider===account.provider&&native.kind===parent.locator.kind&&native.message_id===parent.locator.message_id&&(native.kind==='gmail'?native.thread_id===parent.locator.thread_id:native.conversation_id===parent.locator.conversation_id);
 const drained=current&&validTime&&matched&&!pending&&coverage.complete===true;
 const stateName=bound&&!current||!matched?'stale':!validTime||!bound?(reset?'reset_required':'unknown'):drained?'complete':'partial';
 const result={conversation_id:parent.conversation_id,conversation_coverage_state:stateName,conversation_indexed_count:String(page.count.indexed),conversation_exact_count:drained?String(page.count.indexed):'',conversation_observed_at:validTime?observed:'',conversation_drained:String(drained),mailbox_reset_required:String(reset)};
 if(Object.entries(EMAIL_CONVERSATION_METADATA_FIELDS).some(([key,max])=>!clean(result[key],max)))fail();return result;
}
