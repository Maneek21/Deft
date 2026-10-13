import {createHash} from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import {readDraftContent,draftContentDigest} from './native-draft-content.mjs';
import {createMicrosoftSourceAdapter} from './source-read.mjs';
import {createApiTransport,fail,pathId,text} from './contract.mjs';
import {triageDigest,triageJson} from './triage-contract.mjs';
import {singleAddress} from '../account-config.mjs';
const origin='https://graph.microsoft.com',prefer={Prefer:'IdType="ImmutableId"'},CHUNK=10*320*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>triageJson(a)===triageJson(b);
const scoped=context=>({org_id:context.org_id,owner_user_id:context.owner_user_id,account_id:context.account_id});
const binding=(context,value)=>triageDigest([scoped(context),context.installation_id,context.resource_binding_id,value.principal_digest]);
const result=(input,value,state,limitations=[],attempt=1)=>({schema_version:'deft.email_prepare_send_result.v1',account_id:value.account.account_id,provider:'microsoft',operation_id:input.operation_id,mime_digest:input.mime_digest,state,limitations,...(state==='pending'?{retry_after_ms:Math.min(30000,1000*2**Math.min(attempt,5))}:{})});
const publicUrl=raw=>{let url;try{url=new URL(raw);}catch{fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');}if(url.origin!=='https://outlook.office.com'||url.username||url.password||url.hash||!/^\/api\//iu.test(url.pathname)||!/\/attachmentsessions\(/iu.test(decodeURIComponent(url.pathname))||url.href.length>8192)fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');return url.href;};
const nextOffset=(response,total)=>{const ranges=response.nextExpectedRanges??response.NextExpectedRanges;if(!Array.isArray(ranges)||ranges.length!==1||typeof ranges[0]!=='string'||!/^\d+-?$/u.test(ranges[0]))fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');const offset=Number(ranges[0].replace(/-$/u,''));if(!Number.isSafeInteger(offset)||offset<0||offset>total)fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');return offset;};
async function skeleton(wanted,input){
 if(!/^<[^<>\s]+@[^<>\s]+>$/u.test(wanted.message_id)||!Number.isFinite(Date.parse(wanted.sent_at)))fail('EMAIL_GRAPH_SEND_MIME_INVALID');
 const mailbox=row=>({address:row.emailAddress.address,name:row.emailAddress.name??''}),names=wanted.canonical.address_names;
 const compiled=new MailComposer({from:names.from.map(mailbox),to:names.to.map(mailbox),cc:names.cc.map(mailbox),bcc:names.bcc.map(mailbox),replyTo:names.reply_to.map(mailbox),
  subject:wanted.canonical.subject,text:wanted.canonical.text,...(wanted.canonical.html?{html:wanted.canonical.html}:{}),messageId:wanted.message_id,date:new Date(wanted.sent_at),
  ...(wanted.canonical.in_reply_to?{inReplyTo:wanted.canonical.in_reply_to}:{}),...(wanted.canonical.references.length?{references:wanted.canonical.references}:{}),
  headers:{'X-Deft-Outbox-Operation':input.operation_id},textEncoding:'base64',newline:'windows',baseBoundary:hash(Buffer.from(input.mime_digest+':graph-skeleton')),disableUrlAccess:true,disableFileAccess:true}).compile();
 compiled.keepBcc=true;const bytes=await new Promise((resolve,reject)=>compiled.build((error,bytes)=>error?reject(error):resolve(bytes)));
 if(bytes.length>3*1024*1024){bytes.fill(0);fail('EMAIL_GRAPH_SEND_BODY_LIMIT');}return bytes;
}
async function observe(ref,value,context,now){
 const api=createApiTransport(value.adapterOptions,origin),endpoint=origin+'/v1.0/me/messages/'+pathId(ref);
 const before=await api.request(endpoint+'?$select=id,isDraft,changeKey',{operation:'modify',headers:prefer});if(before.id!==ref||before.isDraft!==true)fail('EMAIL_GRAPH_SEND_DRAFT_CONFLICT');text(before.changeKey,2048);
 const source=await createMicrosoftSourceAdapter({...value.adapterOptions,now,sourceOperation:'modify',sourceMimeLimit:35*1024*1024}).readSource({kind:'microsoft',id_type:'immutable',message_id:ref},{signal:context.signal,deadline:context.expires_at});
 try{const after=await api.request(endpoint+'?$select=id,isDraft,changeKey',{operation:'modify',headers:prefer});await value.check();if(after.id!==ref||after.isDraft!==true||after.changeKey!==before.changeKey)fail('EMAIL_GRAPH_SEND_DRAFT_CONFLICT');return await readDraftContent(source.mime_bytes,{includeEnvelopeHeaders:true,mimeLimit:35*1024*1024});}
 finally{source.mime_bytes.fill(0);}
}
/** Upload URLs are provider-returned, encrypted journal state. No bearer is sent
 * to the preauthenticated endpoint, and redirects never carry its secret URL. */
async function sessionRequest(url,{method='GET',body,headers={}},value,context,now){
 const target=publicUrl(url);await value.check();context.signal?.throwIfAborted();const remaining=context.expires_at-now();if(remaining<1000)fail('EMAIL_GRAPH_SEND_PREPARATION_PENDING');
 let response;try{response=await value.adapterOptions.fetch(target,{method,body,headers,redirect:'error',signal:AbortSignal.timeout(Math.min(15000,remaining))});}catch{fail('EMAIL_GRAPH_SEND_UPLOAD_UNAVAILABLE');}
 if(![200,201].includes(response.status)){await response.body?.cancel();fail('EMAIL_GRAPH_SEND_UPLOAD_UNAVAILABLE');}
 let size=0;const buffers=[];const reader=response.body?.getReader();let joined;
 try{if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>16384){await reader.cancel();fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');}buffers.push(Buffer.from(chunk.value));}
  await value.check();if(response.status===201)return {complete:true,location:response.headers.get('location')};joined=Buffer.concat(buffers);const data=JSON.parse(joined.toString('utf8'));return {complete:false,data};}
 catch(error){if(error?.code)throw error;fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');}finally{reader?.releaseLock();joined?.fill(0);buffers.forEach(bytes=>bytes.fill(0));}
}
const expected=(wanted,files)=>draftContentDigest({...wanted.canonical,attachments:files.map(index=>wanted.canonical.attachments[index])});
export async function prepareNativeGraphSend({input,context,sendValue,modifyValue,now=Date.now}){
 const journal=context.send_upload_journal;if(!journal||['create','load','change'].some(key=>typeof journal[key]!=='function')||typeof context.send_prepare_before_effect!=='function')fail('EMAIL_GRAPH_SEND_JOURNAL_REQUIRED');
 const check=async()=>{await sendValue.check();await modifyValue.check();},api=createApiTransport(modifyValue.adapterOptions,origin),scope=scoped(context);let wanted,bare;
 try{
  await check();wanted=await readDraftContent(input.mime_bytes,{keepAttachmentBytes:true,includeEnvelopeHeaders:true,mimeLimit:35*1024*1024});
  if(wanted.from_header_count!==1||wanted.from.length!==1||wanted.from[0]!==input.from_address.toLowerCase()||wanted.sender.some(a=>a!==wanted.from[0])||wanted.parts.reduce((n,p)=>n+p.bytes.length,0)>25*1024*1024)fail('EMAIL_GRAPH_SEND_MIME_INVALID');
  const recipients=[...wanted.canonical.to,...wanted.canonical.cc,...wanted.canonical.bcc];if(recipients.length<1||recipients.length>200||recipients.some(address=>!singleAddress(address)))fail('EMAIL_GRAPH_SEND_MIME_INVALID');
  bare=await skeleton(wanted,input);const files=wanted.parts.map((p,index)=>({index,name:p.name,content_type:p.content_type,disposition:p.disposition,content_id:p.content_id,size:p.bytes.length,digest:p.content_digest}));
  const unsigned={schema_version:'deft.email_graph_send_plan.v1',operation_id:input.operation_id,scope,binding_digest:binding(context,sendValue),mime_digest:input.mime_digest,skeleton_digest:hash(bare),content_digest:wanted.digest,from_address:input.from_address,files};
  const plan={...unsigned,digest:triageDigest(unsigned)};await journal.create(plan);await check();
  return await journal.change(scope,input.operation_id,async(state,write)=>{
   if(!state||!same(state.plan,plan))fail('EMAIL_GRAPH_SEND_PLAN_CONFLICT');const save=async()=>{await write(state);await check();};
   const reply=(stateName,limitations=[])=>result(input,sendValue,stateName,limitations,state.prepare_attempts);
   if(state.prepare_attempts>=64)return reply('conflict',['preparation_retry_limit']);state.prepare_attempts++;await save();
   const proof=async()=>{await check();if(await context.send_prepare_before_effect({operation_id:input.operation_id,account_id:scope.account_id,authority_epoch:sendValue.account.authority_epoch,mime_digest:input.mime_digest})!==true)fail('EMAIL_GRAPH_SEND_PREPARATION_DENIED');await check();};
   if(['started','unknown','conflict'].includes(state.create.state))return reply(state.create.state==='conflict'?'conflict':'unknown',['draft_create_outcome_unknown_no_retry']);
   if(state.create.state==='prepared'){
    await proof();state.create={state:'started'};await save();try{const row=await api.request(origin+'/v1.0/me/messages?$select=id,isDraft',{operation:'modify',method:'POST',headers:{...prefer,'Content-Type':'text/plain'},body:bare.toString('base64')});text(row.id,256);if(row.isDraft!==true)fail('EMAIL_GRAPH_SEND_DRAFT_CONFLICT');await check();state.create={state:'applied',ref:row.id};await save();}
    catch(error){state.create={state:'unknown'};await save();return reply('unknown',['draft_create_outcome_unknown_no_retry']);}
   }
   if(state.send.state!=='prepared')return reply(state.send.state==='accepted'?'ready':'unknown',['final_send_is_not_replayable']);
   const ref=state.create.ref,endpoint=origin+'/v1.0/me/messages/'+pathId(ref);let effects=0;
   for(let index=0;index<files.length;index++){
    const file=state.files[index],part=wanted.parts[index],before=state.files.slice(0,index).filter(f=>f.state==='applied').map(f=>f.index);
    if(file.state==='applied')continue;if(file.state==='conflict')return reply('conflict');
    if(file.state==='unknown'||file.range){
     // Read-only exact MIME proves a lost completed attachment before any retry.
     try{const found=await observe(ref,modifyValue,context,now);await check();if(found.digest===expected(wanted,[...before,index])){file.state='applied';file.offset=part.bytes.length;delete file.range;await save();continue;}
      if(found.digest!==expected(wanted,before)){file.state='conflict';await save();return reply('conflict',['external_draft_edit']);}
     }catch(error){if(error.code==='EMAIL_GRAPH_SEND_DRAFT_CONFLICT'){file.state='conflict';await save();return reply('conflict');}return reply('pending',['attachment_readback_pending']);}
     if(!file.upload_url)return reply('unknown',['attachment_post_outcome_unknown_no_retry']);
    }
    if(effects>=4||context.expires_at-now()<3000)return reply('pending',['bounded_preparation_page']);
    if(part.bytes.length<3000000){
     await proof();file.state='unknown';await save();try{const row=await api.request(endpoint+'/attachments',{operation:'modify',method:'POST',headers:prefer,body:JSON.stringify({'@odata.type':'#microsoft.graph.fileAttachment',name:part.name,contentType:part.content_type,isInline:part.disposition==='inline',...(part.content_id?{contentId:part.content_id}:{}),contentBytes:Buffer.from(part.bytes).toString('base64')})});text(row.id,256);await check();file.state='applied';file.offset=part.bytes.length;file.attachment_id=row.id;await save();effects++;continue;}
     catch{return reply('pending',['attachment_post_needs_readback']);}
    }
    if(!file.upload_url){
     // A lost session response has uploaded no bytes and created no attachment;
     // a new temporary session is safe. Its orphan remains for expiry cleanup.
     await proof();file.state='session_started';await save();try{const session=await api.request(endpoint+'/attachments/createUploadSession',{operation:'modify',method:'POST',headers:prefer,body:JSON.stringify({AttachmentItem:{attachmentType:'file',name:part.name,size:part.bytes.length,contentType:part.content_type,isInline:part.disposition==='inline',...(part.content_id?{contentId:part.content_id}:{})}})});
      const expiry=new Date(session.expirationDateTime);if(!Number.isFinite(expiry.getTime())||expiry.getTime()<=now()||nextOffset(session,part.bytes.length)!==0)fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');file.upload_url=publicUrl(session.uploadUrl);file.expires_at=expiry.toISOString();file.state='uploading';await save();effects++;
     }catch(error){if(error.code==='EMAIL_GRAPH_SEND_UPLOAD_INVALID'){file.state='conflict';await save();return reply('conflict',['invalid_provider_upload_session']);}return reply('pending',['upload_session_response_pending']);}
    }
    if(Date.parse(file.expires_at)<=now())return reply('unknown',['upload_session_expired_requires_recovery']);
    if(file.range){
     try{const status=await sessionRequest(file.upload_url,{},modifyValue,context,now),offset=nextOffset(status.data,part.bytes.length);if(offset<file.offset||offset>file.range.end+1)fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');file.offset=offset;delete file.range;file.state='uploading';await save();}
     catch{return reply('pending',['upload_status_pending']);}
    }
    while(file.offset<part.bytes.length){
     if(effects>=4||context.expires_at-now()<3000)return reply('pending',['bounded_preparation_page']);const end=Math.min(file.offset+CHUNK,part.bytes.length)-1;
     await proof();file.range={start:file.offset,end};await save();let response;
     try{response=await sessionRequest(file.upload_url,{method:'PUT',body:part.bytes.subarray(file.offset,end+1),headers:{'Content-Length':String(end-file.offset+1),'Content-Range':`bytes ${file.offset}-${end}/${part.bytes.length}`,'Content-Type':'application/octet-stream'}},modifyValue,context,now);}
     catch{return reply('pending',['upload_range_needs_status']);}
     const next=response.complete?part.bytes.length:nextOffset(response.data,part.bytes.length);if(next!==end+1||response.complete&&end!==part.bytes.length-1||!response.complete&&next===part.bytes.length)fail('EMAIL_GRAPH_SEND_UPLOAD_INVALID');file.offset=next;delete file.range;if(response.complete)file.state='applied';await save();effects++;
    }
   }
   const final=await observe(ref,modifyValue,context,now);await check();if(final.digest!==wanted.digest||final.message_id!==wanted.message_id||final.operation_header!==input.operation_id){return reply('conflict',['final_draft_content_mismatch']);}
   return reply('ready',['provider_compare_is_not_atomic_cas']);
  });
 }finally{bare?.fill(0);for(const part of wanted?.parts??[])part.bytes?.fill(0);}
}
export async function sendPreparedNativeGraph({input,context,sendValue,modifyValue,now=Date.now}){
 const journal=context.send_upload_journal;if(!journal)fail('EMAIL_GRAPH_SEND_JOURNAL_REQUIRED');const scope=scoped(context),check=async()=>{await sendValue.check();await modifyValue.check();};
 return journal.change(scope,input.operation_id,async(state,write)=>{
  await check();if(!state||state.plan.mime_digest!==input.mime_digest||state.plan.from_address!==input.from_address||state.plan.binding_digest!==binding(context,sendValue)||state.create.state!=='applied'||!state.files.every(file=>file.state==='applied'))fail('EMAIL_GRAPH_SEND_NOT_PREPARED');
  const accepted=()=>({schema_version:'deft.email_send_result.v1',account_id:scope.account_id,provider:'microsoft',operation_id:input.operation_id,provider_message_id:null,transport_outcome:'provider_accepted',sent_copy_outcome:'pending',delivery_status:'unknown'});
  if(state.send.state==='accepted')return accepted();if(state.send.state!=='prepared')fail('EMAIL_NATIVE_SEND_RESULT_UNKNOWN',{outcome:'uncertain'});
  const observed=await observe(state.create.ref,modifyValue,context,now);await check();if(observed.digest!==state.plan.content_digest||observed.operation_header!==input.operation_id)fail('EMAIL_GRAPH_SEND_DRAFT_CONFLICT');
  if(await context.send_before_reserve({operation_id:input.operation_id,account_id:scope.account_id,authority_epoch:sendValue.account.authority_epoch,mime_digest:input.mime_digest})!==true)fail('EMAIL_NATIVE_SEND_AUTHORITY_DENIED');await check();
  state.send.state='started';await write(state);await check();try{await createApiTransport(sendValue.adapterOptions,origin).request(origin+'/v1.0/me/messages/'+pathId(state.create.ref)+'/send',{operation:'send',method:'POST',headers:prefer,acceptedStatus:202});await check();state.send.state='accepted';await write(state);return accepted();}
  catch(error){state.send.state='unknown';await write(state);throw error;}
 });
}
