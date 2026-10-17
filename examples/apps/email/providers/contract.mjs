const TOKEN_PROBE_CODES=new Set(['EMAIL_OAUTH_ACCOUNT_BINDING_DENIED', 'EMAIL_OAUTH_ACCOUNT_IDENTITY_CHANGED', 'EMAIL_OAUTH_ACCOUNT_INVALID', 'EMAIL_OAUTH_AUTHORITY_DENIED', 'EMAIL_OAUTH_BINDING_INVALID', 'EMAIL_OAUTH_BROWSER_BINDING_REQUIRED', 'EMAIL_OAUTH_CLIENT_CHANGED', 'EMAIL_OAUTH_CLIENT_CONFIG_INVALID', 'EMAIL_OAUTH_CUSTODY_BINDING_DENIED', 'EMAIL_OAUTH_CUSTODY_CONFIG_INVALID', 'EMAIL_OAUTH_CUSTODY_CONFLICT', 'EMAIL_OAUTH_CUSTODY_INVALID', 'EMAIL_OAUTH_CUSTODY_KEY_UNAVAILABLE', 'EMAIL_OAUTH_CUSTODY_LIMIT', 'EMAIL_OAUTH_CUSTODY_STORE_INVALID', 'EMAIL_OAUTH_CUSTODY_UNAVAILABLE', 'EMAIL_OAUTH_FILE_STORE_CONFIG_INVALID', 'EMAIL_OAUTH_FILE_STORE_FENCE_LOST', 'EMAIL_OAUTH_FILE_STORE_FILESYSTEM_UNSUPPORTED', 'EMAIL_OAUTH_FILE_STORE_FILE_INVALID', 'EMAIL_OAUTH_FILE_STORE_KEY_INVALID', 'EMAIL_OAUTH_FILE_STORE_LOCK_BUSY', 'EMAIL_OAUTH_FILE_STORE_PATH_INVALID', 'EMAIL_OAUTH_FILE_STORE_PAYLOAD_INVALID', 'EMAIL_OAUTH_FILE_STORE_PAYLOAD_LIMIT', 'EMAIL_OAUTH_FILE_STORE_PLATFORM_UNSUPPORTED', 'EMAIL_OAUTH_FILE_STORE_ROOT_NOT_PRIVATE', 'EMAIL_OAUTH_FILE_STORE_STALE_LOCK', 'EMAIL_OAUTH_FILE_STORE_UNAVAILABLE', 'EMAIL_OAUTH_HOST_PORT_REQUIRED', 'EMAIL_OAUTH_IDENTITY_SCOPE_REQUIRED', 'EMAIL_OAUTH_INPUT_INVALID', 'EMAIL_OAUTH_MAILBOX_READ_REQUIRED', 'EMAIL_OAUTH_MAIL_SCOPE_REQUIRED', 'EMAIL_OAUTH_PROVIDER_IDENTITY_DENIED', 'EMAIL_OAUTH_PROVIDER_IDENTITY_INVALID', 'EMAIL_OAUTH_PROVIDER_NOT_CONFIGURED', 'EMAIL_OAUTH_PROVIDER_REQUEST_FAILED', 'EMAIL_OAUTH_PROVIDER_RESPONSE', 'EMAIL_OAUTH_PROVIDER_RESPONSE_INVALID', 'EMAIL_OAUTH_PROVIDER_RESPONSE_LIMIT', 'EMAIL_OAUTH_PROVIDER_SCOPE_DENIED', 'EMAIL_OAUTH_PROVIDER_UNAVAILABLE', 'EMAIL_OAUTH_REAUTH_REQUIRED', 'EMAIL_OAUTH_RECONNECT_IDENTITY_CHANGED', 'EMAIL_OAUTH_REFRESH_TOKEN_REQUIRED', 'EMAIL_OAUTH_SCOPE_DENIED', 'EMAIL_OAUTH_SCOPE_REDUCED', 'EMAIL_OAUTH_SETUP_LIMIT', 'EMAIL_OAUTH_SETUP_SUPERSEDED', 'EMAIL_OAUTH_STATE_AUTHORITY_CHANGED', 'EMAIL_OAUTH_STATE_CONFLICT', 'EMAIL_OAUTH_STATE_DENIED', 'EMAIL_OAUTH_STATE_EXPIRED', 'EMAIL_OAUTH_STATE_INVALID', 'EMAIL_OAUTH_STATE_REPLAY', 'EMAIL_OAUTH_TOKEN_RESPONSE_INVALID']);const tokenProbe=(stage,error,details={})=>{try{console.info(JSON.stringify({event:'email_token_probe',stage,code:TOKEN_PROBE_CODES.has(error?.code)?error.code:'OPAQUE_LOCAL_ERROR',...details}));}catch{}};
import {createHash} from 'node:crypto';
import {EmailOAuthError} from './oauth-contract.mjs';
const LOCAL_TOKEN_FAILURES=new Set(['EMAIL_CONNECTION_AUTHORITY_DENIED','EMAIL_OAUTH_AUTHORITY_DENIED','EMAIL_OAUTH_ACCOUNT_BINDING_DENIED','EMAIL_OAUTH_CUSTODY_BINDING_DENIED','EMAIL_OAUTH_CUSTODY_INVALID','EMAIL_OAUTH_CLIENT_CHANGED','EMAIL_OAUTH_SCOPE_REDUCED','EMAIL_OAUTH_ACCOUNT_IDENTITY_CHANGED','EMAIL_OAUTH_FILE_STORE_LOCK_BUSY','EMAIL_OAUTH_FILE_STORE_STALE_LOCK','EMAIL_OAUTH_FILE_STORE_FENCE_LOST']);
import {simpleParser} from 'mailparser';
import {singleAddress} from '../account-config.mjs';
import {validateEmailAccount} from '../account-registry.mjs';
import {LOGICAL_MAIL_LIMITS} from '../logical-mail-index.mjs';

export const PROVIDER_LIMITS=Object.freeze({page_items:100,metadata_bytes:2097152,detail_bytes:12582912,mime_bytes:8388608,cursor_bytes:LOGICAL_MAIL_LIMITS.cursor_bytes,timeout_ms:15000});
// Explicit native incoming profile; legacy and outgoing defaults stay separate.
export const NATIVE_INCOMING_LIMITS=Object.freeze({source_bytes:35*1024*1024,inventory_bytes:35*1024*1024,file_bytes:25*1024*1024});
export class MailProviderError extends Error {
 constructor(code,{status=null,outcome='no_effect',retryable=false}={}){super(code);this.name='MailProviderError';this.code=code;this.status=status;this.outcome=outcome;this.retryable=retryable;}
}
export const fail=(code,options)=>{throw new MailProviderError(code,options);};
export function text(value,max=2048){if(typeof value!=='string'||!value||value.length>max||/[\r\n\0]/.test(value))fail('EMAIL_PROVIDER_INPUT_INVALID');return value;}
export function pathId(value){text(value);if(value==='.'||value==='..')fail('EMAIL_PROVIDER_INPUT_INVALID');return encodeURIComponent(value);}
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function pageLimit(limit=25){if(!Number.isInteger(limit)||limit<1||limit>PROVIDER_LIMITS.page_items)fail('EMAIL_PROVIDER_PAGE_LIMIT');return limit;}
export const display=value=>String(value??'').replace(/[\r\n\0]/g,' ').slice(0,1000);
export function date(value){if(value===undefined||value===null)return null;const parsed=new Date(value);return Number.isNaN(parsed.getTime())?null:parsed.toISOString();}
export function encodeCursor(binding,value){const cursor=Buffer.from(JSON.stringify({v:1,binding,value})).toString('base64url');if(cursor.length>PROVIDER_LIMITS.cursor_bytes)fail('EMAIL_PROVIDER_CURSOR_LIMIT');return cursor;}
export function decodeCursor(cursor,binding){
 if(cursor===null||cursor===undefined)return null;
 let parsed;try{if(typeof cursor!=='string'||cursor.length>PROVIDER_LIMITS.cursor_bytes||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}
 if(parsed.v!==1||parsed.binding!==binding||Object.keys(parsed).sort().join(',')!=='binding,v,value')fail('EMAIL_PROVIDER_CURSOR_INVALID');return parsed.value;
}
// Preserve the active host-admitted increasing page size cursor semantics.
export function increasingPageLimitBinding(retained,limit,bindingForLimit){
 pageLimit(limit);for(let previous=limit;previous>=1;previous--){const binding=bindingForLimit(previous);if(retained===binding)return binding;}
 fail('EMAIL_PROVIDER_CURSOR_INVALID');
}
export function decodePageLimitCursor(cursor,limit,bindingForLimit){
 pageLimit(limit);if(cursor===null||cursor===undefined)return {binding:bindingForLimit(limit),value:null};
 let retained;try{if(typeof cursor!=='string'||cursor.length>PROVIDER_LIMITS.cursor_bytes)throw Error();retained=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')).binding;}catch{fail('EMAIL_PROVIDER_CURSOR_INVALID');}
 const binding=increasingPageLimitBinding(retained,limit,bindingForLimit);return {binding,value:decodeCursor(cursor,binding)};
}
async function boundedJson(response,maxBytes,budget){
 if(Number(response.headers?.get('content-length'))>maxBytes)fail('EMAIL_PROVIDER_RESPONSE_LIMIT');
 const reader=response.body?.getReader();if(!reader)fail('EMAIL_PROVIDER_RESPONSE_INVALID');let size=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(budget)budget.remaining-=value.byteLength;if(size>maxBytes||budget&&budget.remaining<0){await reader.cancel();fail('EMAIL_PROVIDER_RESPONSE_LIMIT');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!result||typeof result!=='object'||Array.isArray(result))throw Error();return result;}catch{fail('EMAIL_PROVIDER_RESPONSE_INVALID');}
}
export function createApiTransport({account:input,fetch:fetchImpl,getAccessToken,assertAuthority,reserveSend,outgoingMimeLimit=PROVIDER_LIMITS.mime_bytes},origin){
 const account=validateEmailAccount(input);
 if(!Number.isSafeInteger(outgoingMimeLimit)||outgoingMimeLimit<1||outgoingMimeLimit>36*1024*1024)fail('EMAIL_PROVIDER_OUTGOING_INVALID');
 if(typeof fetchImpl!=='function'||typeof getAccessToken!=='function'||typeof assertAuthority!=='function')fail('EMAIL_PROVIDER_AUTHORITY_REQUIRED');
 let tokenQueue=Promise.resolve();const pendingTokens=new Map();
 const authority=async operation=>{if(!account.capabilities.includes(operation))fail('EMAIL_ACCOUNT_CAPABILITY_DENIED');let allowed=false;try{allowed=await assertAuthority({account_id:account.account_id,operation,authority_epoch:account.authority_epoch});}catch{}if(allowed!==true||account.health!=='connected')fail('EMAIL_ACCOUNT_REVOKED');};
 async function request(url,{operation='read',method='GET',body,headers={},maxBytes=PROVIDER_LIMITS.metadata_bytes,acceptedStatus,budget}={}){
  const parsed=new URL(url);if(parsed.origin!==origin||parsed.username||parsed.password||parsed.hash)fail('EMAIL_PROVIDER_URL_INVALID');
  await authority(operation);let token;try{let work=pendingTokens.get(operation);if(!work){const acquisition=tokenQueue.then(async()=>{await authority(operation);return getAccessToken({account_id:account.account_id,operation,authority_epoch:account.authority_epoch});});tokenQueue=acquisition.then(()=>undefined,()=>undefined);work=acquisition.finally(()=>{if(pendingTokens.get(operation)===work)pendingTokens.delete(operation);});pendingTokens.set(operation,work);}token=await work;}catch(error){tokenProbe('token_acquisition',error);if(error instanceof EmailOAuthError&&LOCAL_TOKEN_FAILURES.has(error.code))fail(error.code);fail('EMAIL_PROVIDER_REAUTH_REQUIRED');}
  if(typeof token!=='string'||!token||token.length>16384||/[\r\n\0]/.test(token))fail('EMAIL_PROVIDER_REAUTH_REQUIRED');
  await authority(operation);let response;const timeout=budget?.deadline===undefined?PROVIDER_LIMITS.timeout_ms:Math.min(PROVIDER_LIMITS.timeout_ms,budget.deadline-Date.now());if(timeout<=0)fail('EMAIL_PROVIDER_SCAN_DEADLINE');
  try{response=await fetchImpl(parsed.href,{method,body,headers:{...headers,Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(timeout)});}catch{fail('EMAIL_PROVIDER_NETWORK_UNAVAILABLE',{outcome:method==='POST'?'uncertain':'no_effect',retryable:method==='GET'});}
  if(!response.ok){const status=response.status;tokenProbe('provider_http',null,{status});await response.body?.cancel();fail(status===401?'EMAIL_PROVIDER_REAUTH_REQUIRED':status===403?'EMAIL_PROVIDER_PERMISSION_DENIED':status===410?'EMAIL_PROVIDER_CURSOR_EXPIRED':status===404?'EMAIL_PROVIDER_NOT_FOUND':status===429?'EMAIL_PROVIDER_RATE_LIMITED':'EMAIL_PROVIDER_REQUEST_FAILED',{status,outcome:method==='POST'&&(status>=500||status===408)?'uncertain':'no_effect',retryable:method==='GET'&&(status===429||status>=500)});}
  if(acceptedStatus!==undefined){if(response.status!==acceptedStatus)fail('EMAIL_PROVIDER_RESPONSE_INVALID',{outcome:'uncertain'});await response.body?.cancel();return null;}
  let data;try{data=await boundedJson(response,maxBytes,budget);}catch(error){if(method==='POST')fail('EMAIL_PROVIDER_SEND_RESULT_UNKNOWN',{outcome:'uncertain'});if(error instanceof MailProviderError)throw error;fail('EMAIL_PROVIDER_NETWORK_UNAVAILABLE',{retryable:true});}
  if(method==='GET')await authority(operation);return data;
 }
 async function outgoing(input){
  if(input?.account_id!==undefined&&input.account_id!==account.account_id||input?.transport_kind!==undefined&&input.transport_kind!==(account.provider==='gmail'?'gmail_raw':'graph_raw'))fail('EMAIL_PROVIDER_ACCOUNT_MISMATCH');
  if(!(input?.mime_bytes instanceof Uint8Array)||input.mime_bytes.byteLength<1||input.mime_bytes.byteLength>outgoingMimeLimit||!singleAddress(input.from_address)||!account.verified_sender_identities.some(address=>address.toLowerCase()===input.from_address.toLowerCase())||!/^[a-f0-9]{64}$/.test(input.mime_digest??''))fail('EMAIL_PROVIDER_OUTGOING_INVALID');
  text(input.operation_id,256);const bytes=Buffer.from(input.mime_bytes);try{if(createHash('sha256').update(bytes).digest('hex')!==input.mime_digest)fail('EMAIL_PROVIDER_MIME_CHANGED');
  let parsed;try{parsed=await simpleParser(bytes,{skipHtmlToText:true,skipTextToHtml:true});}catch{fail('EMAIL_PROVIDER_OUTGOING_INVALID');}
  if(parsed.headerLines?.filter(header=>header.key==='from').length!==1||parsed.from?.value?.length!==1||parsed.from.value[0].address?.toLowerCase()!==input.from_address.toLowerCase()||parsed.sender&&parsed.sender.value?.some(sender=>sender.address?.toLowerCase()!==input.from_address.toLowerCase()))fail('EMAIL_PROVIDER_SENDER_DENIED');
  const recipients=[parsed.to,parsed.cc,parsed.bcc].flatMap(field=>field?.value??[]);if(recipients.length<1||recipients.length>500||recipients.some(recipient=>!singleAddress(recipient.address)))fail('EMAIL_PROVIDER_OUTGOING_INVALID');
  await authority('send');if(typeof reserveSend!=='function')fail('EMAIL_PROVIDER_SEND_RESERVATION_REQUIRED');let reserved=false;
  try{reserved=await reserveSend({account_id:account.account_id,authority_epoch:account.authority_epoch,operation_id:input.operation_id,mime_digest:input.mime_digest});}catch{}
  if(reserved!==true)fail('EMAIL_PROVIDER_SEND_ALREADY_RESERVED');return bytes;
  }catch(error){bytes.fill(0);throw error;}
 }
 return {account,authority,request,outgoing};
}
export function resultPage(account,messages,failures,cursor,{complete=true,coverage='mailbox',providerCap=null}={}){
 return {account_id:account.account_id,messages,failures,next_cursor:cursor,has_more:cursor!==null,complete:complete&&cursor===null&&failures.length===0,coverage,observed_at:new Date().toISOString(),count:{returned:messages.length,exact_total:null,provider_result_cap:providerCap}};
}
