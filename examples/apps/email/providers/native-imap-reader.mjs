import {createHash} from 'node:crypto';
import {resolveNativeImapSource} from './native-imap-alias.mjs';
import {inspectEmailSourceFiles} from './incoming-source-files.mjs';
import {fetchPublicMessageImage} from './remote-image-proxy.mjs';
import {fail,PROVIDER_LIMITS,NATIVE_INCOMING_LIMITS} from './contract.mjs';
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('EMAIL_NATIVE_SOURCE_INVALID');};
const nativeView=account=>{const {org_id,owner_user_id,installation_id,connection_target,action_binding_id,verified_sender_identities,...view}=account;return view;};
const hash=value=>createHash('sha256').update(value).digest('hex');

/** IMAP BODY.PEEK source download uses the exact server-owned UID tuple. The
 * existing MIME inspector owns presentation/parts; HTML stays untrusted JSON.
 * The host owns encrypted credentials, TLS, pinned DNS and connection cleanup. */
export function createNativeImapReaderBridge({runtime,host,now=Date.now,imageDependencies}){
 async function source(input,context,value){
  exact(input,['source']);if(!Object.hasOwn(input,'source'))fail('EMAIL_NATIVE_SOURCE_INVALID');value??=await runtime(context);await value.check();
  const parent=await resolveNativeImapSource({scope:value.scope,account:value.account,source:input.source,aliases:context.imap_aliases,check:value.check}),locator=parent.locator;if(locator.kind!=='imap_smtp')fail('EMAIL_NATIVE_SOURCE_INVALID');let result;
  try{
   result=await host.withAuthorizedClient(context,Object.freeze(nativeView(value.account)),async client=>{
    if(!client?.authenticated||client.secureConnection!==true)fail('EMAIL_NATIVE_IMAP_TLS_REQUIRED');let lock,stream,timer,onAbort,joined;const chunks=[];
    const interrupted=new Promise((_,reject)=>{
     const stop=code=>{try{stream?.destroy?.();}catch{}try{client.close?.();}catch{}try{fail(code);}catch(error){reject(error);}};
     onAbort=()=>stop('EMAIL_SOURCE_ABORTED');context.signal?.addEventListener('abort',onAbort,{once:true});
     timer=setTimeout(()=>stop('EMAIL_SOURCE_ABORTED'),Math.max(1,Math.min(PROVIDER_LIMITS.timeout_ms,context.expires_at-now())));
    });void interrupted.catch(()=>{});
    const bounded=async promise=>{context.signal?.throwIfAborted();const row=await Promise.race([Promise.resolve(promise),interrupted]);context.signal?.throwIfAborted();return row;};
    const check=async()=>{await bounded(value.check());if(context.expires_at<=now())fail('EMAIL_SOURCE_ABORTED');};
    try{
     await check();lock=await bounded(client.getMailboxLock(locator.mailbox,{readOnly:true}));await check();
     if(client.mailbox?.readOnly!==true||String(client.mailbox.uidValidity)!==locator.uidvalidity||client.mailbox.path!==locator.mailbox)fail('EMAIL_NATIVE_SOURCE_STALE');
     const row=await bounded(client.fetchOne(locator.uid,{uid:true,size:true},{uid:true}));await check();
     if(!row||row.uid!==locator.uid||!Number.isSafeInteger(row.size)||row.size<1)fail('EMAIL_NATIVE_SOURCE_STALE');if(row.size>NATIVE_INCOMING_LIMITS.source_bytes)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');
     const download=await bounded(client.download(locator.uid,undefined,{uid:true,maxBytes:NATIVE_INCOMING_LIMITS.source_bytes+1,chunkSize:65536}));stream=download?.content;await check();
     if(download?.meta?.expectedSize!==row.size||typeof stream?.[Symbol.asyncIterator]!=='function'||typeof stream.destroy!=='function')fail('EMAIL_SOURCE_RESPONSE_INVALID');
     let size=0;const iterator=stream[Symbol.asyncIterator]();for(;;){await check();const next=await bounded(iterator.next());await check();if(next.done)break;
      if(!(next.value instanceof Uint8Array))fail('EMAIL_SOURCE_RESPONSE_INVALID');size+=next.value.byteLength;if(size>NATIVE_INCOMING_LIMITS.source_bytes||size>row.size)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');chunks.push(Buffer.from(next.value));
     }
     if(size!==row.size||String(client.mailbox.uidValidity)!==locator.uidvalidity)fail('EMAIL_NATIVE_SOURCE_STALE');joined=Buffer.concat(chunks,size);await check();
     result={schema_version:'deft.email_source.v1',account_id:value.account.account_id,provider:'imap_smtp',source_kind:'provider_original',media_type:'message/rfc822',byte_length:size,digest:hash(joined),mime_bytes:new Uint8Array(joined)};return result;
    }finally{clearTimeout(timer);context.signal?.removeEventListener('abort',onAbort);try{stream?.destroy?.();}catch{}try{lock?.release();}finally{joined?.fill(0);for(const chunk of chunks)chunk.fill(0);}}
   });await value.check();return result;
  }catch(error){result?.mime_bytes?.fill(0);throw error;}
 }
 async function inspect(input,context,kind){
  const ref=kind==='file'?'file_ref':'image_ref',whole=kind==='presentation'||kind==='calendar';exact(input,whole?['source']:['source','source_digest',ref]);
  if(!whole&&(!/^[a-f0-9]{64}$/u.test(input.source_digest??'')||!/^[a-f0-9]{64}$/u.test(input[ref]??'')))fail('EMAIL_NATIVE_SOURCE_INVALID');
  const value=await runtime(context);await value.check();const parent=await resolveNativeImapSource({scope:value.scope,account:value.account,source:input.source,aliases:context.imap_aliases,check:value.check});let original,result;
  try{
   original=await source({source:input.source},context,value);if(!whole&&original.digest!==input.source_digest)fail('EMAIL_NATIVE_SOURCE_STALE');
   result=await inspectEmailSourceFiles(original.mime_bytes,{profile:'native',presentation:kind==='presentation',calendar_parts:kind==='calendar',...(whole?{}:{[ref]:input[ref]}),
    account:{...value.account,verified_sender_identities:value.account.verified_sender_identities??[]},conversation_id:parent.conversation_id,check:value.check,
    fetchRemote:async({url})=>{await value.check();const image=await fetchPublicMessageImage(url,{signal:context.signal,recheck:async()=>{await value.check();return true;}},imageDependencies);try{await value.check();return image;}catch(error){image.bytes?.fill(0);throw error;}}});
   await value.check();const identity={account_id:value.account.account_id,provider:'imap_smtp',logical_message_id:parent.logical_message_id,source_digest:original.digest};
   if(kind==='calendar')return {schema_version:'deft.email_calendar_parts.v1',...identity,receiving_identity:{primary_address:value.account.primary_address,display_label:value.account.display_label},...result.calendar_parts};
   if(kind==='presentation')return {schema_version:'deft.email_presentation.v1',...identity,content_trust:'unsanitized',files:result.files,...(result.omitted_file_count?{omitted_file_count:result.omitted_file_count}:{}),...(result.reply_seed_unavailable?{reply_seed_unavailable:result.reply_seed_unavailable}:{}),presentation:result.presentation};
   if(kind==='file'){const file=result.files.find(file=>file.file_ref===input.file_ref);if(!file)fail('EMAIL_NATIVE_SOURCE_INVALID');return {schema_version:'deft.email_file.v1',...identity,file_ref:input.file_ref,filename:file.filename,media_type:file.media_type,byte_length:result.bytes.byteLength,bytes:result.bytes};}
   return {schema_version:'deft.email_image.v1',...identity,image_ref:input.image_ref,media_type:result.media_type,byte_length:result.bytes.byteLength,bytes:result.bytes};
  }catch(error){result?.bytes?.fill(0);throw error;}finally{original?.mime_bytes?.fill(0);}
 }
 return Object.freeze({nativeEmailSource:(input,context)=>source(input,context),nativeEmailCalendarParts:(input,context)=>inspect(input,context,'calendar'),nativeEmailPresentation:(input,context)=>inspect(input,context,'presentation'),nativeEmailFile:(input,context)=>inspect(input,context,'file'),nativeEmailImage:(input,context)=>inspect(input,context,'image')});
}
