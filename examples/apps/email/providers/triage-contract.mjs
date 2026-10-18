import {createHash} from 'node:crypto';
import {validateEmailScope,validateEmailAccount,sameEmailScope} from '../account-registry.mjs';
import {validateProviderLocator} from '../logical-mail-index.mjs';
import {fail,text} from './contract.mjs';

export const TRIAGE_OPERATIONS=Object.freeze(['mark_read','mark_unread','flag','unflag','archive','trash','restore','spam','not_spam','labels','move','permanent_delete']);
export const TRIAGE_LIMITS=Object.freeze({items:25,plan_bytes:24576,journal_bytes:65536,timeout_ms:15000,response_bytes:65536,ttl_ms:900000});
export const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const triageJson=value=>JSON.stringify(canonical(value));
export const triageDigest=value=>createHash('sha256').update(triageJson(value)).digest('hex');
export const sameTriageState=(a,b)=>triageJson(a)===triageJson(b);
export function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('EMAIL_TRIAGE_INPUT_INVALID');}
export function validateTriageOperation(input){
 exact(input,['kind','add_labels','remove_labels','destination']);if(!TRIAGE_OPERATIONS.includes(input.kind))fail('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');
 const result={kind:input.kind};
 if(input.kind==='labels'){
  for(const key of ['add_labels','remove_labels']){const rows=input[key]??[];if(!Array.isArray(rows)||rows.length>16||new Set(rows).size!==rows.length)fail('EMAIL_TRIAGE_INPUT_INVALID');result[key]=rows.map(value=>text(value,256)).sort();}
  if(!result.add_labels.length&&!result.remove_labels.length||result.add_labels.some(value=>result.remove_labels.includes(value)))fail('EMAIL_TRIAGE_INPUT_INVALID');
 }else if(input.add_labels!==undefined||input.remove_labels!==undefined)fail('EMAIL_TRIAGE_INPUT_INVALID');
 if(input.kind==='move'||input.kind==='restore'||input.kind==='not_spam'){if(input.destination!==undefined)result.destination=text(input.destination,256);if(input.kind==='move'&&!result.destination)fail('EMAIL_TRIAGE_INPUT_INVALID');}
 else if(input.destination!==undefined)fail('EMAIL_TRIAGE_INPUT_INVALID');
 return result;
}
/** This separate reviewed operation ceiling is never inferred from read/Send. */
export function validateTriageBinding(input){
 exact(input,['scope','account','action_binding_id','operations']);const scope=validateEmailScope(input.scope),account=validateEmailAccount(input.account);
 text(input.action_binding_id,256);if(!Array.isArray(input.operations)||!input.operations.length||input.operations.some(op=>!TRIAGE_OPERATIONS.includes(op))||new Set(input.operations).size!==input.operations.length)fail('EMAIL_TRIAGE_CAPABILITY_DENIED');
 return {scope,account,action_binding_id:input.action_binding_id,operations:[...input.operations].sort()};
}
export function assertTriageBinding(expected,current,operation){
 current=validateTriageBinding(current);
 if(!sameEmailScope(expected.scope,current.scope)||!sameTriageState(expected,current)||!current.operations.includes(operation)||current.account.health!=='connected')fail('EMAIL_TRIAGE_AUTHORITY_STALE');
 return current;
}
export function triageLocator(input,provider){const value=validateProviderLocator(input);if(value.kind!==provider)fail('EMAIL_TRIAGE_ACCOUNT_MISMATCH');return value;}
export function operationScopePermitted(provider,operation,scopes){
 if(!Array.isArray(scopes)||scopes.length>64||scopes.some(value=>typeof value!=='string'||value.length>512))return false;
 if(provider==='gmail')return scopes.includes('https://mail.google.com/')||operation!=='permanent_delete'&&scopes.includes('https://www.googleapis.com/auth/gmail.modify');
 if(provider==='microsoft')return scopes.some(scope=>scope==='Mail.ReadWrite'||scope==='https://graph.microsoft.com/Mail.ReadWrite');
 return false;
}

/** Credential custody returns ACTUALLY granted scopes with each current token.
 * HTTP write ambiguity is never converted to no-effect or automatically retried. */
export function createTriageApiTransport({binding:raw,fetch:fetchImpl=globalThis.fetch,getAccessToken,assertAuthority,now=Date.now}){
 const binding=validateTriageBinding(raw),origin=binding.account.provider==='gmail'?'https://gmail.googleapis.com':'https://graph.microsoft.com';
 if(!['gmail','microsoft'].includes(binding.account.provider)||typeof getAccessToken!=='function'||typeof assertAuthority!=='function')fail('EMAIL_TRIAGE_AUTHORITY_REQUIRED');
 const authority=async operation=>{if(!binding.operations.includes(operation)||binding.account.health!=='connected'||await assertAuthority({binding:structuredClone(binding),operation})!==true)fail('EMAIL_TRIAGE_AUTHORITY_STALE');};
 async function request(url,{operation,method='GET',body,headers={},guard=async()=>{},reserve,status=200}={}){
  const target=new URL(url);if(target.origin!==origin||target.username||target.password||target.hash||!target.pathname.startsWith(binding.account.provider==='gmail'?'/gmail/v1/users/me/':'/v1.0/me/'))fail('EMAIL_TRIAGE_PROVIDER_URL_DENIED');
  await authority(operation);const credential=await getAccessToken({binding:structuredClone(binding),operation});
  if(!credential||typeof credential.token!=='string'||!credential.token||credential.token.length>16384||/[\r\n\0]/.test(credential.token)||!operationScopePermitted(binding.account.provider,operation,credential.granted_scopes))fail('EMAIL_TRIAGE_PROVIDER_SCOPE_DENIED');
  await authority(operation);await guard();if(method!=='GET'){if(typeof reserve!=='function')fail('EMAIL_TRIAGE_RESERVATION_REQUIRED');await reserve();await authority(operation);await guard();}const deadline=now()+TRIAGE_LIMITS.timeout_ms;let response;
  try{response=await fetchImpl(target.href,{method,headers:{...headers,Authorization:`Bearer ${credential.token}`},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(TRIAGE_LIMITS.timeout_ms)});}catch{fail('EMAIL_TRIAGE_NETWORK_UNAVAILABLE',{outcome:method==='GET'?'no_effect':'uncertain'});}
  if(response.status!==status){await response.body?.cancel();fail(response.status===412?'EMAIL_TRIAGE_CONFLICT':response.status===404?'EMAIL_TRIAGE_NOT_FOUND':'EMAIL_TRIAGE_PROVIDER_REJECTED',{status:response.status,outcome:method!=='GET'&&(response.status>=500||response.status===408)?'uncertain':'no_effect'});}
  let data=null;
  try{if(status!==204){const reader=response.body?.getReader();if(!reader)throw Error();const chunks=[];let length=0;try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>TRIAGE_LIMITS.response_bytes||now()>=deadline){await reader.cancel();throw Error();}chunks.push(Buffer.from(item.value));}}finally{reader.releaseLock();}data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();}else await response.body?.cancel();
   await authority(operation);await guard();if(now()>=deadline)throw Error();
  }catch{fail('EMAIL_TRIAGE_RESPONSE_UNKNOWN',{outcome:method==='GET'?'no_effect':'uncertain'});}
  return data;
 }
 return {binding,authority,request};
}
