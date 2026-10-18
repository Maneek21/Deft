import {createApiTransport,PROVIDER_LIMITS,fail,text,pathId,pageLimit,display,date,digest,encodeCursor,decodeCursor,decodePageLimitCursor,resultPage} from './contract.mjs';
import {randomUUID} from 'node:crypto';

const base='https://gmail.googleapis.com/gmail/v1/users/me';
const headers=['From','To','Cc','Subject','Date','Message-ID','References','In-Reply-To'];
export function gmailMetadataSummary(account,value){
 const id=text(value.id),thread=text(value.threadId),labels=value.labelIds??[];
 if(!Array.isArray(labels)||labels.length>100||labels.some(label=>typeof label!=='string'||label.length>256))fail('EMAIL_PROVIDER_RESPONSE_INVALID');
 const entries=value.payload?.headers??[];if(!Array.isArray(entries)||entries.length>200)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
 const header=name=>display(entries.find(row=>row.name?.toLowerCase()===name.toLowerCase())?.value);
 return {account_id:account.account_id,provider:'gmail',locator:{kind:'gmail',message_id:id,thread_id:thread,label_ids:labels},sender:header('From'),recipients:header('To'),cc:header('Cc'),subject:header('Subject'),date:date(Number(value.internalDate)),folders:[...labels],flags:{seen:!labels.includes('UNREAD'),flagged:labels.includes('STARRED')},message_id:header('Message-ID'),references:header('References'),in_reply_to:header('In-Reply-To'),body_status:'lazy',files_status:'unknown'};
}
const summary=gmailMetadataSummary;
export function createGmailAdapter(options){
 const api=createApiTransport(options,'https://gmail.googleapis.com'),{account}=api;if(account.provider!=='gmail')fail('EMAIL_PROVIDER_ACCOUNT_MISMATCH');
 const metadataUrl=id=>{const url=new URL(`${base}/messages/${pathId(id)}`);url.searchParams.set('format','metadata');for(const name of headers)url.searchParams.append('metadataHeaders',name);return url.href;};
 async function listMessages({limit=25,cursor=null,query='',label_ids=[],include_spam_trash=false}={},operation='read'){
  limit=pageLimit(limit);if(query!=='')text(query,2048);if(!Array.isArray(label_ids)||label_ids.length>20||label_ids.some(label=>typeof label!=='string'||!label||label.length>256)||typeof include_spam_trash!=='boolean')fail('EMAIL_PROVIDER_INPUT_INVALID');
  const {binding,value:token}=decodePageLimitCursor(cursor,limit,size=>digest({account_id:account.account_id,epoch:account.authority_epoch,operation,query,label_ids,include_spam_trash,limit:size})),url=new URL(`${base}/messages`);
  if(token!==null)url.searchParams.set('pageToken',text(token,4096));url.searchParams.set('maxResults',String(limit));if(query)url.searchParams.set('q',query);for(const label of label_ids)url.searchParams.append('labelIds',label);url.searchParams.set('includeSpamTrash',String(include_spam_trash));
  const budget={remaining:PROVIDER_LIMITS.metadata_bytes,deadline:Date.now()+60000},page=await api.request(url.href,{operation,budget}),rows=page.messages??[];if(!Array.isArray(rows)||rows.length>limit)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
  const messages=[],failures=[];
  // Metadata GETs are independent. Ten at a time avoid a page's serial
  // round trips without changing its shared deadline/byte budget or guards.
  // Drain every started read before propagating a fatal error; start no more.
  for(let offset=0;offset<rows.length;offset+=10){
   const results=await Promise.allSettled(rows.slice(offset,offset+10).map(async row=>{
    const id=text(row.id);try{const data=await api.request(metadataUrl(id),{operation,budget});if(data.id!==id)fail('EMAIL_PROVIDER_RESPONSE_INVALID');return {message:summary(account,data)};}
    catch(error){if(!['EMAIL_PROVIDER_NOT_FOUND','EMAIL_PROVIDER_RESPONSE_INVALID','EMAIL_PROVIDER_INPUT_INVALID'].includes(error.code))throw error;return {failure:{provider_message_id:id,code:error.code}};}
   }));
   const fatal=results.find(result=>result.status==='rejected');if(fatal)throw fatal.reason;
   for(const {value}of results){if(value.message)messages.push(value.message);else failures.push(value.failure);}
  }
  const next=page.nextPageToken===undefined?null:encodeCursor(binding,text(page.nextPageToken,4096));if(next!==null&&next===cursor)fail('EMAIL_PROVIDER_PAGINATION_STALLED');await api.authority(operation);return resultPage(account,messages,failures,next,{coverage:query?'query':label_ids.length?'labels':'mailbox'});
 }
 async function readMessage(locator){if(locator?.kind!=='gmail')fail('EMAIL_PROVIDER_LOCATOR_INVALID');const data=await api.request(`${base}/messages/${pathId(locator.message_id)}?format=full`,{maxBytes:PROVIDER_LIMITS.detail_bytes});if(data.id!==locator.message_id)fail('EMAIL_PROVIDER_RESPONSE_INVALID');return {message:summary(account,data),body:{format:'gmail_mime',payload:data.payload,untrusted:true}};}
 async function readConversation({thread_id,limit=25,cursor=null,anchor_message_id},operation='thread'){
  if(!['read','thread'].includes(operation))fail('EMAIL_PROVIDER_INPUT_INVALID');
  limit=pageLimit(limit);text(thread_id);const binding=digest({account_id:account.account_id,epoch:account.authority_epoch,thread_id,limit}),state=decodeCursor(cursor,binding),offset=state?.offset??0;if(state!==null&&(!Number.isSafeInteger(state.offset)||state.offset<0||typeof state.revision!=='string'))fail('EMAIL_PROVIDER_CURSOR_INVALID');
  await api.authority(operation);const thread=await api.request(`${base}/threads/${pathId(thread_id)}?format=metadata`,{});if(thread.id!==thread_id||!Array.isArray(thread.messages)||thread.messages.length>10000)fail('EMAIL_PROVIDER_RESPONSE_INVALID');
  if(anchor_message_id!==undefined&&(!text(anchor_message_id,256)||!thread.messages.some(message=>message.id===anchor_message_id&&message.threadId===thread_id)))fail('EMAIL_NATIVE_CONVERSATION_SOURCE_STALE');
  // Offset pagination is bound to the returned thread revision; changed threads
  // require a fresh read instead of silently dropping/duplicating messages.
  const revision=digest(thread.messages.map(message=>[message.id,message.historyId,message.labelIds]));
  if(state!==null&&state.revision!==revision)fail('EMAIL_PROVIDER_CURSOR_EXPIRED');
  const all=[],failures=[];for(const row of thread.messages){try{if(row?.threadId!==thread_id)fail('EMAIL_PROVIDER_RESPONSE_INVALID');all.push(summary(account,row));}catch(error){failures.push({provider_message_id:display(row?.id),code:error.code??'EMAIL_PROVIDER_RESPONSE_INVALID'});}}all.sort((a,b)=>(a.date??'').localeCompare(b.date??'')||a.locator.message_id.localeCompare(b.locator.message_id));
  const messages=all.slice(offset,offset+limit),next=offset+limit<all.length?encodeCursor(binding,{offset:offset+limit,revision}):null;return {...resultPage(account,messages,failures,next,{coverage:'conversation'}),provider_conversation_id:thread_id,revision};
 }
 async function send(input){
  if(input?.thread_id!==undefined)text(input.thread_id);const bytes=await api.outgoing(input);let uploadBody;
  try{
   let url=`${base}/messages/send`,headers={'Content-Type':'application/json'},body;
   if(options.nativeMimeUpload===true){
    url='https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send';
    if(input.thread_id){const boundary='deft-native-'+randomUUID();headers={'Content-Type':`multipart/related; boundary="${boundary}"`};
     uploadBody=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({threadId:input.thread_id})}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);body=uploadBody;url+='?uploadType=multipart';
    }else{headers={'Content-Type':'message/rfc822'};body=bytes;url+='?uploadType=media';}
   }else body=JSON.stringify({raw:bytes.toString('base64url'),...(input.thread_id?{threadId:input.thread_id}:{})});
   const data=await api.request(url,{operation:'send',method:'POST',headers,body});try{text(data.id);}catch{fail('EMAIL_PROVIDER_SEND_RESULT_UNKNOWN',{outcome:'uncertain'});}
   return {account_id:account.account_id,operation_id:input.operation_id,provider_message_id:data.id,transport_outcome:'provider_accepted',sent_copy_outcome:'pending',delivery_status:'unknown'};
  }finally{bytes.fill(0);uploadBody?.fill(0);}
 }
 return Object.freeze({provider:'gmail',listMessages,searchMessages:request=>listMessages({...request,query:text(request?.query,2048)},'search'),readMessage,readConversation,send});
}
