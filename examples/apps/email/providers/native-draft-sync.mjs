import {createHash} from 'node:crypto';
import {createApiTransport,fail,pathId,text} from './contract.mjs';
import {createMicrosoftSourceAdapter} from './source-read.mjs';
import {oauthObject} from './oauth-contract.mjs';
import {readDraftContent as content} from './native-draft-content.mjs';
import {updateNativeGraphDraft} from './native-graph-draft-update.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const limits={gmail:36700160,microsoft:3*1024*1024};
const uuid=value=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value))fail('EMAIL_DRAFT_SYNC_INVALID');};
const limitations=provider=>['compare_before_effect_is_not_atomic_cas',...(provider==='microsoft'?['mime_create_limit_3MiB','mime_update_with_attachment_parity_pending']:[])];
/** Host-owned exact MIME, refs and durable reservation only. No provider write
 * is retried here. Provider compare-before-effect has an explicit race window. */
export function createNativeEmailDraftSyncBridge({runtime,now=Date.now}){
 return Object.freeze({async nativeEmailDraftSync(input,context){
  oauthObject(input,['operation','operation_id','provider_draft_ref','baseline_digest','provider_version','desired'],'EMAIL_DRAFT_SYNC_INVALID');uuid(input.operation_id);
  if(!['inspect','create','update','delete'].includes(input.operation))fail('EMAIL_DRAFT_SYNC_INVALID');
  const mutation=['update','delete'].includes(input.operation),hasMime=['create','update'].includes(input.operation);
  if((input.operation!=='create')!==Object.hasOwn(input,'provider_draft_ref')||mutation!==Object.hasOwn(input,'baseline_digest')||mutation!==Object.hasOwn(input,'provider_version')||hasMime!==Object.hasOwn(input,'desired'))fail('EMAIL_DRAFT_SYNC_INVALID');
  if(input.provider_draft_ref!==undefined)text(input.provider_draft_ref,256);
  if(mutation&&(!/^[a-f0-9]{64}$/u.test(input.baseline_digest??'')||!text(input.provider_version,256)))fail('EMAIL_DRAFT_SYNC_INVALID');
  if(input.operation!=='inspect'&&typeof context?.draft_sync_before_effect!=='function')fail('EMAIL_DRAFT_SYNC_RESERVATION_REQUIRED');
  const value=await runtime(context);await value.check();const {account}=value,provider=account.provider,identity={schema_version:'deft.email_draft_sync_result.v1',account_id:account.account_id,provider,operation_id:input.operation_id,limitations:limitations(provider)};
  if(!Object.hasOwn(limits,provider))fail('EMAIL_DRAFT_SYNC_UNSUPPORTED');
  const result=(outcome,extra={})=>({...identity,outcome,...extra}),api=createApiTransport(value.adapterOptions,provider==='gmail'?'https://gmail.googleapis.com':'https://graph.microsoft.com');
  let desired,desiredContent,retained;
  try{
   if(hasMime){oauthObject(input.desired,['mime_bytes','mime_digest'],'EMAIL_DRAFT_SYNC_INVALID');if(!(input.desired.mime_bytes instanceof Uint8Array)||input.desired.mime_bytes.length<1||input.desired.mime_bytes.length>limits[provider]||!/^[a-f0-9]{64}$/u.test(input.desired.mime_digest??''))fail('EMAIL_DRAFT_SYNC_SIZE_UNSUPPORTED');
    desired=Buffer.from(input.desired.mime_bytes);if(hash(desired)!==input.desired.mime_digest)fail('EMAIL_DRAFT_SYNC_INVALID');desiredContent=await content(desired);
    if(desiredContent.from_header_count!==1||desiredContent.from.length!==1||desiredContent.sender.some(address=>address!==desiredContent.from[0])||![account.primary_address,...account.verified_sender_identities].some(address=>address.toLowerCase()===desiredContent.from[0]))fail('EMAIL_DRAFT_SYNC_SENDER_DENIED');
   }
   const inspect=async ref=>{
    if(provider==='gmail'){
     let row;try{row=await api.request(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${pathId(ref)}?format=raw`,{operation:'modify',maxBytes:Math.ceil(limits.gmail*4/3)+16384});}catch(error){if(error.code==='EMAIL_PROVIDER_NOT_FOUND')return result('missing',{provider_draft_ref:ref});throw error;}
     const message=row.message;if(row.id!==ref||!message||!text(message.id,256)||!Array.isArray(message.labelIds)||!message.labelIds.includes('DRAFT'))return result('conflict',{provider_draft_ref:ref});
     if(typeof message.raw!=='string'||message.raw.length>Math.ceil(limits.gmail*4/3)+4||!/^[A-Za-z0-9_-]+={0,2}$/u.test(message.raw))fail('EMAIL_DRAFT_SYNC_RESPONSE_INVALID');
     const bytes=Buffer.from(message.raw,'base64url');try{if(bytes.length<1||bytes.length>limits.gmail||bytes.toString('base64url')!==message.raw.replace(/=+$/u,''))fail('EMAIL_DRAFT_SYNC_RESPONSE_INVALID');await value.check();
      return result('present',{provider_draft_ref:ref,baseline_digest:hash(bytes),provider_version:hash(JSON.stringify([message.id,message.historyId??null])),mime_bytes:new Uint8Array(bytes)});
     }finally{bytes.fill(0);}
    }
    const metadata=async()=>{try{return await api.request(`https://graph.microsoft.com/v1.0/me/messages/${pathId(ref)}?$select=id,isDraft,changeKey`,{operation:'modify',headers:{Prefer:'IdType="ImmutableId"'}});}catch(error){if(error.code==='EMAIL_PROVIDER_NOT_FOUND')return null;throw error;}};
    const before=await metadata();if(!before)return result('missing',{provider_draft_ref:ref});if(before.id!==ref||before.isDraft!==true)return result('conflict',{provider_draft_ref:ref});text(before.changeKey,2048);
    const source=await createMicrosoftSourceAdapter({...value.adapterOptions,now,sourceOperation:'modify',sourceMimeLimit:limits.microsoft}).readSource({kind:'microsoft',id_type:'immutable',message_id:ref},{signal:context.signal,deadline:context.expires_at});
    try{const after=await metadata();await value.check();if(!after)return result('missing',{provider_draft_ref:ref});if(after.id!==ref||after.isDraft!==true||after.changeKey!==before.changeKey)return result('conflict',{provider_draft_ref:ref});
     return result('present',{provider_draft_ref:ref,baseline_digest:source.digest,provider_version:hash(JSON.stringify([before.changeKey])),mime_bytes:new Uint8Array(source.mime_bytes)});
    }finally{source.mime_bytes.fill(0);}
   };
   if(input.operation==='inspect'){retained=await inspect(input.provider_draft_ref);await value.check();return retained;}
   if(provider==='microsoft'&&input.operation==='update')return await updateNativeGraphDraft({input,context,value,api,inspect,result,desired,now});
   if(mutation){const observed=await inspect(input.provider_draft_ref);try{if(observed.outcome!=='present')return observed;
    if(observed.baseline_digest!==input.baseline_digest||observed.provider_version!==input.provider_version)return result('conflict',{provider_draft_ref:input.provider_draft_ref,baseline_digest:observed.baseline_digest,provider_version:observed.provider_version});
   }finally{observed.mime_bytes?.fill(0);}}
   await value.check();const nomination=Object.freeze({operation_id:input.operation_id,operation:input.operation,account_id:account.account_id,authority_epoch:account.authority_epoch,provider_draft_ref:input.provider_draft_ref??null,baseline_digest:input.baseline_digest??null,desired_digest:input.desired?.mime_digest??null});
   if(await context.draft_sync_before_effect(nomination)!==true)fail('EMAIL_DRAFT_SYNC_RESERVATION_DENIED');await value.check();
   let ref=input.provider_draft_ref;
   try{
    if(input.operation==='delete'){await api.request(provider==='gmail'?`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${pathId(ref)}`:`https://graph.microsoft.com/v1.0/me/messages/${pathId(ref)}`,{operation:'modify',method:'DELETE',acceptedStatus:204,...(provider==='microsoft'?{headers:{Prefer:'IdType="ImmutableId"'}}:{})});await value.check();return result('deleted',{provider_draft_ref:ref});}
    const row=await api.request(provider==='gmail'?`https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts${input.operation==='update'?'/'+pathId(ref):''}?uploadType=media`:'https://graph.microsoft.com/v1.0/me/messages',
     {operation:'modify',method:input.operation==='update'?'PUT':'POST',body:provider==='gmail'?desired:desired.toString('base64'),headers:provider==='gmail'?{'Content-Type':'message/rfc822'}:{'Content-Type':'text/plain',Prefer:'IdType="ImmutableId"'}});
    if(!row||!text(row.id,256)||input.operation==='update'&&row.id!==ref||provider==='microsoft'&&row.isDraft!==true)fail('EMAIL_DRAFT_SYNC_RESPONSE_INVALID');ref=row.id;await value.check();
    retained=await inspect(ref);if(retained.outcome!=='present')return result(retained.outcome==='conflict'?'conflict':'unknown',{provider_draft_ref:ref});
    const parity=await content(retained.mime_bytes);await value.check();
    if(parity.digest!==desiredContent.digest){retained.mime_bytes.fill(0);return result('conflict',{provider_draft_ref:ref,baseline_digest:retained.baseline_digest,provider_version:retained.provider_version,limitations:[...identity.limitations,'provider_readback_content_mismatch']});}
    return {...retained,outcome:input.operation==='create'?'created':'updated'};
   }catch(error){retained?.mime_bytes?.fill(0);await value.check();return result('unknown',ref?{provider_draft_ref:ref}:{});}
  }catch(error){retained?.mime_bytes?.fill(0);throw error;}finally{desired?.fill(0);}
 }});
}
