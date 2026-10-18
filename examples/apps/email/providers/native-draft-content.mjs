import {createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import {triageDigest} from './triage-contract.mjs';
import {fail} from './contract.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value??'').replace(/\r\n/gu,'\n').replace(/\n+$/u,'');
const cid=value=>String(value??'').replace(/^<|>$/gu,'').trim();
export const draftContentDigest=value=>triageDigest({...value,attachments:[...value.attachments].sort((a,b)=>{const left=JSON.stringify(a),right=JSON.stringify(b);return left<right?-1:left>right?1:0;})});
/** Existing MIME parser only; canonical supported content ignores MIME framing
 * and attachment order while preserving duplicate attachment multiplicity. */
export async function readDraftContent(bytes,{keepAttachmentBytes=false,includeEnvelopeHeaders=false,mimeLimit=35*1024*1024}={}){
 const raw=Buffer.from(bytes);let parsed;const owned=[];
 try{
  if(!Number.isSafeInteger(mimeLimit)||mimeLimit<1||mimeLimit>35*1024*1024||raw.length<1||raw.length>mimeLimit||(raw.toString('latin1').match(/^--[^\r\n]{1,200}\r?$/gmu)??[]).length>256)fail('EMAIL_DRAFT_SYNC_MIME_UNSUPPORTED');
  parsed=await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true,keepCidLinks:true});if(parsed.attachments.length>32)fail('EMAIL_DRAFT_SYNC_MIME_UNSUPPORTED');
  const addresses=field=>(field?.value??[]).map(row=>String(row.address??'').toLowerCase()),recipients=field=>(field?.value??[]).map(row=>({emailAddress:{address:row.address,...(row.name?{name:row.name}:{})}}));
  const parts=parsed.attachments.map(part=>{const descriptor={name:part.filename??'',content_type:part.contentType,disposition:part.contentDisposition==='inline'?'inline':'attachment',content_id:cid(part.contentId),content_digest:hash(part.content)};
   if(keepAttachmentBytes){const content=new Uint8Array(part.content);owned.push(content);return {...descriptor,bytes:content};}return descriptor;});
  const canonical={from:addresses(parsed.from),sender:addresses(parsed.sender),to:addresses(parsed.to),cc:addresses(parsed.cc),bcc:addresses(parsed.bcc),reply_to:addresses(parsed.replyTo),address_names:{from:recipients(parsed.from),to:recipients(parsed.to),cc:recipients(parsed.cc),bcc:recipients(parsed.bcc),reply_to:recipients(parsed.replyTo)},subject:parsed.subject??'',text:normalize(parsed.text),html:normalize(parsed.html||''),in_reply_to:parsed.inReplyTo??'',references:parsed.references??[],attachments:parts.map(({bytes,...metadata})=>metadata)};
  const patch={subject:parsed.subject??'',body:{contentType:parsed.html?'HTML':'Text',content:parsed.html||parsed.text||''},toRecipients:recipients(parsed.to),ccRecipients:recipients(parsed.cc),bccRecipients:recipients(parsed.bcc),replyTo:recipients(parsed.replyTo),...(parsed.from?.value?.length===1?{from:{emailAddress:{address:parsed.from.value[0].address,...(parsed.from.value[0].name?{name:parsed.from.value[0].name}:{})}}}:{})};
  return {from:canonical.from,sender:canonical.sender,from_header_count:parsed.headerLines.filter(row=>row.key==='from').length,canonical,digest:draftContentDigest(canonical),patch,parts,
   ...(includeEnvelopeHeaders?{message_id:parsed.messageId??'',sent_at:parsed.date?.toISOString()??'',operation_header:String(parsed.headers.get('x-deft-outbox-operation')??'')}: {})};
 }catch(error){for(const bytes of owned)bytes.fill(0);throw error;}finally{raw.fill(0);for(const part of parsed?.attachments??[])part.content?.fill(0);}
}
