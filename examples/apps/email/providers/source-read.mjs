import {createHash} from 'node:crypto';
import {validateEmailAccount} from '../account-registry.mjs';
import {PROVIDER_LIMITS,fail,pathId,MailProviderError} from './contract.mjs';

const cancel=target=>{try{Promise.resolve(target?.cancel()).catch(()=>{});}catch{}};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// This port accepts private locators only. Its caller must resolve them from the
// exact current owner/account index, never from browser-provided provider IDs.
function sourceAdapter({account:input,fetch:fetchImpl=globalThis.fetch,getAccessToken,assertAuthority,now=Date.now,sourceOperation='read',sourceMimeLimit=PROVIDER_LIMITS.mime_bytes},provider) {
 const account=validateEmailAccount(input);
 if(account.provider!==provider||typeof fetchImpl!=='function'||typeof getAccessToken!=='function'||typeof assertAuthority!=='function'||!['read','modify'].includes(sourceOperation)||!Number.isSafeInteger(sourceMimeLimit)||sourceMimeLimit<1||sourceMimeLimit>35*1024*1024)fail('EMAIL_SOURCE_AUTHORITY_REQUIRED');
 async function authority(){
  if(account.health!=='connected'||!account.capabilities.includes(sourceOperation))fail('EMAIL_ACCOUNT_CAPABILITY_DENIED');
  let allowed=false;try{allowed=await assertAuthority({account_id:account.account_id,operation:sourceOperation,authority_epoch:account.authority_epoch});}catch{}
  if(allowed!==true)fail('EMAIL_ACCOUNT_AUTHORITY_DENIED');
 }
 return Object.freeze({provider,async readSource(locator,{signal,deadline=now()+PROVIDER_LIMITS.timeout_ms,expected_thread_id}={}){
  if(!Number.isSafeInteger(deadline)||deadline<=now()||signal!==undefined&&!(signal instanceof AbortSignal))fail('EMAIL_SOURCE_DEADLINE_INVALID');
  if(expected_thread_id!==undefined&&(provider!=='gmail'||typeof expected_thread_id!=='string'||!expected_thread_id||expected_thread_id.length>2048||/[\r\n\0]/u.test(expected_thread_id)))fail('EMAIL_PROVIDER_LOCATOR_INVALID');
  if(signal?.aborted)fail('EMAIL_SOURCE_ABORTED',{retryable:true});
  const timeout=Math.min(PROVIDER_LIMITS.timeout_ms,deadline-now()),controller=new AbortController();
  let reader,response,timer,abortListener;const owned=[];
  const aborted=new Promise((_,reject)=>{abortListener=()=>{reject(new MailProviderError('EMAIL_SOURCE_ABORTED',{retryable:true}));cancel(reader??response?.body);};controller.signal.addEventListener('abort',abortListener,{once:true});});
  const forward=()=>controller.abort();
  signal?.addEventListener('abort',forward,{once:true});
  timer=setTimeout(forward,timeout);
  const bounded=async promise=>{const result=await Promise.race([Promise.resolve(promise),aborted]);if(controller.signal.aborted)fail('EMAIL_SOURCE_ABORTED',{retryable:true});return result;};
  try{
   let url,headers={};
   if(provider==='gmail'){
    if(locator?.kind!=='gmail')fail('EMAIL_PROVIDER_LOCATOR_INVALID');
    url=new URL(`https://www.googleapis.com/gmail/v1/users/me/messages/${pathId(locator.message_id)}`);url.searchParams.set('format','raw');
   }else{
    if(locator?.kind!=='microsoft'||locator.id_type!=='immutable')fail('EMAIL_PROVIDER_LOCATOR_INVALID');
    url=new URL(`https://graph.microsoft.com/v1.0/me/messages/${pathId(locator.message_id)}/$value`);headers={Prefer:'IdType="ImmutableId"'};
   }
   await bounded(authority());
   let token;try{token=await bounded(getAccessToken({account_id:account.account_id,operation:sourceOperation,authority_epoch:account.authority_epoch}));}catch(error){if(error instanceof MailProviderError)throw error;fail('EMAIL_PROVIDER_REAUTH_REQUIRED');}
   if(typeof token!=='string'||!token||token.length>16384||/[\r\n\0]/u.test(token))fail('EMAIL_PROVIDER_REAUTH_REQUIRED');
   await bounded(authority());
   // Late noncooperative fetch responses are canceled even after this request
   // has returned an abort. No read/write authority is inferred from tokens.
   const pending=Promise.resolve(fetchImpl(url.href,{method:'GET',headers:{...headers,Authorization:`Bearer ${token}`},redirect:'error',signal:controller.signal})).then(value=>{if(controller.signal.aborted)cancel(value.body);return value;});
   response=await bounded(pending);
   if(!response.ok){cancel(response.body);fail(response.status===401?'EMAIL_PROVIDER_REAUTH_REQUIRED':response.status===403?'EMAIL_PROVIDER_PERMISSION_DENIED':response.status===404?'EMAIL_PROVIDER_NOT_FOUND':response.status===429?'EMAIL_PROVIDER_RATE_LIMITED':'EMAIL_PROVIDER_REQUEST_FAILED',{status:response.status,retryable:response.status===429||response.status>=500});}
   const maxBytes=provider==='gmail'?Math.ceil(sourceMimeLimit*4/3)+4096:sourceMimeLimit;
   const contentType=response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
   if(provider==='microsoft'&&!['text/plain','message/rfc822'].includes(contentType))fail('EMAIL_SOURCE_RESPONSE_INVALID');
   const length=response.headers?.get('content-length');
   if(length!==null&&length!==undefined&&(!/^\d+$/u.test(length)||Number(length)>maxBytes))fail('EMAIL_PROVIDER_RESPONSE_LIMIT');
   reader=response.body?.getReader();if(!reader)fail('EMAIL_SOURCE_RESPONSE_INVALID');
   let size=0;const chunks=[];
   for(;;){const row=await bounded(reader.read());if(row.done)break;if(!(row.value instanceof Uint8Array))fail('EMAIL_SOURCE_RESPONSE_INVALID');size+=row.value.byteLength;if(size>maxBytes)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');const chunk=Buffer.from(row.value);chunks.push(chunk);owned.push(chunk);}
   let bytes=Buffer.concat(chunks,size);owned.push(bytes);
   if(provider==='gmail'){
    let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('EMAIL_SOURCE_RESPONSE_INVALID');}
    if(!data||data.id!==locator.message_id||expected_thread_id!==undefined&&data.threadId!==expected_thread_id||typeof data.raw!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/u.test(data.raw))fail('EMAIL_SOURCE_RESPONSE_INVALID');
    bytes=Buffer.from(data.raw,'base64url');owned.push(bytes);if(bytes.toString('base64url')!==data.raw.replace(/=+$/u,''))fail('EMAIL_SOURCE_RESPONSE_INVALID');
   }
   if(bytes.byteLength<1||bytes.byteLength>sourceMimeLimit)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');
   await bounded(authority());
   return {schema_version:'deft.email_source.v1',account_id:account.account_id,provider,source_kind:'provider_original',media_type:'message/rfc822',byte_length:bytes.byteLength,digest:hash(bytes),mime_bytes:new Uint8Array(bytes)};
  }catch(error){cancel(reader??response?.body);if(error instanceof MailProviderError)throw error;fail('EMAIL_PROVIDER_NETWORK_UNAVAILABLE',{retryable:true});}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',forward);controller.signal.removeEventListener('abort',abortListener);try{reader?.releaseLock();}catch{}for(const bytes of owned)bytes.fill(0);}
 }});
}
export const createGmailSourceAdapter=options=>sourceAdapter(options,'gmail');
export const createMicrosoftSourceAdapter=options=>sourceAdapter(options,'microsoft');
