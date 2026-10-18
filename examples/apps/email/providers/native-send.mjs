import {createGmailAdapter} from './gmail.mjs';
import {createMicrosoftAdapter} from './microsoft.mjs';
import {oauthObject} from './oauth-contract.mjs';
import {fail,text} from './contract.mjs';
import {createHash} from 'node:crypto';
import {prepareNativeGraphSend,sendPreparedNativeGraph} from './native-graph-send.mjs';
export const NATIVE_SEND_LIMITS=Object.freeze({mime_bytes:35*1024*1024,gmail_upload_bytes:36700160,microsoft_single_mime_bytes:3*1024*1024});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
/** The host has already reserved the draft revision. The provider reservation
 * callback only verifies that exact durable row, immediately before effect. */
export function createNativeEmailSendBridge({runtime,now=Date.now}){
 return Object.freeze({
  async nativeEmailPrepareSend(input,context){
   oauthObject(input,['operation_id','mime_bytes','mime_digest','from_address'],'EMAIL_NATIVE_SEND_INPUT_INVALID');
   if(typeof input.operation_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(input.operation_id)||!(input.mime_bytes instanceof Uint8Array)||!input.mime_bytes.length||input.mime_bytes.length>35*1024*1024||!/^[a-f0-9]{64}$/u.test(input.mime_digest??''))fail('EMAIL_NATIVE_SEND_INPUT_INVALID');text(input.from_address,320);
   const bytes=Buffer.from(input.mime_bytes);try{if(hash(bytes)!==input.mime_digest)fail('EMAIL_PROVIDER_MIME_CHANGED');const sendValue=await runtime(context,'prepare_send');await sendValue.check();
    if(sendValue.account.provider!=='microsoft'||!sendValue.account.verified_sender_identities.includes(input.from_address))fail('EMAIL_NATIVE_SEND_SENDER_DENIED');
    const {send_upload_journal:_journal,send_prepare_before_effect:_proof,...core}=context,modifyValue=await runtime(core,'modify');await modifyValue.check();
    return await prepareNativeGraphSend({input:{...input,mime_bytes:bytes},context,sendValue,modifyValue,now});
   }finally{bytes.fill(0);}
  },
  async nativeEmailSendIdentity(context){const value=await runtime(context,'send');await value.check();const {account}=value;
   if(!account.action_binding_id||!account.verified_sender_identities.length)fail('EMAIL_NATIVE_SEND_AUTHORITY_DENIED');
   return {account_id:account.account_id,provider:account.provider,resource_binding_id:account.resource_binding_id,authority_epoch:account.authority_epoch,
    connection_revision:value.connection_revision,principal_digest:value.principal_digest,health:account.health,capabilities:[...account.capabilities],primary_address:account.primary_address,display_label:account.display_label,
    org_id:value.scope.org_id,owner_user_id:value.scope.owner_id,installation_id:value.scope.installation_id,connection_target:account.connection_target,
    action_binding_id:account.action_binding_id,verified_sender_identities:[...account.verified_sender_identities]};
  },
  async nativeEmailSend(input,context){
   if(input?.mime_bytes instanceof Uint8Array&&input.mime_bytes.length>NATIVE_SEND_LIMITS.mime_bytes)fail('EMAIL_NATIVE_SEND_PROVIDER_SIZE_UNSUPPORTED');
   oauthObject(input,['operation_id','mime_bytes','mime_digest','from_address','thread_id'],'EMAIL_NATIVE_SEND_INPUT_INVALID');
   if(typeof input.operation_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(input.operation_id)
     ||!(input.mime_bytes instanceof Uint8Array)||!input.mime_bytes.length||input.mime_bytes.length>NATIVE_SEND_LIMITS.mime_bytes
     ||typeof input.mime_digest!=='string'||!/^[a-f0-9]{64}$/u.test(input.mime_digest)||typeof context?.send_before_reserve!=='function')fail('EMAIL_NATIVE_SEND_INPUT_INVALID');
   text(input.from_address,320);if(input.thread_id!==undefined)text(input.thread_id,256);
   const bytes=Buffer.from(input.mime_bytes);try{
    if(hash(bytes)!==input.mime_digest)fail('EMAIL_PROVIDER_MIME_CHANGED');
    const value=await runtime(context,'send');await value.check();const {account}=value;
    if(!account.verified_sender_identities.includes(input.from_address))fail('EMAIL_NATIVE_SEND_SENDER_DENIED');
    if(account.provider!=='gmail'&&input.thread_id!==undefined)fail('EMAIL_NATIVE_SEND_REPLY_UNSUPPORTED');
    if(account.provider==='microsoft'&&bytes.length>NATIVE_SEND_LIMITS.microsoft_single_mime_bytes){
     if(!context.send_upload_journal)fail('EMAIL_NATIVE_SEND_PROVIDER_SIZE_UNSUPPORTED');
     const {send_upload_journal:_journal,send_before_reserve:_proof,...core}=context,modifyValue=await runtime(core,'modify');await modifyValue.check();
     return await sendPreparedNativeGraph({input:{...input,mime_bytes:bytes},context,sendValue:value,modifyValue,now});
    }
    const limit=account.provider==='gmail'?NATIVE_SEND_LIMITS.gmail_upload_bytes:NATIVE_SEND_LIMITS.microsoft_single_mime_bytes;
    if(bytes.length>limit)fail('EMAIL_NATIVE_SEND_PROVIDER_SIZE_UNSUPPORTED');
    if(account.provider!=='gmail'&&input.thread_id!==undefined)fail('EMAIL_NATIVE_SEND_REPLY_UNSUPPORTED');
    let reserved=false;
    const reserveSend=async nomination=>{
     if(reserved||nomination.account_id!==account.account_id||nomination.authority_epoch!==account.authority_epoch||nomination.operation_id!==input.operation_id||nomination.mime_digest!==input.mime_digest)return false;
     await value.check();const accepted=await context.send_before_reserve(Object.freeze({...nomination}));await value.check();if(accepted!==true)return false;reserved=true;return true;
    };
    const adapter=(account.provider==='gmail'?createGmailAdapter:createMicrosoftAdapter)({...value.adapterOptions,reserveSend,outgoingMimeLimit:NATIVE_SEND_LIMITS.mime_bytes,nativeMimeUpload:true});
    const result=await adapter.send({account_id:account.account_id,operation_id:input.operation_id,mime_bytes:bytes,mime_digest:input.mime_digest,from_address:input.from_address,
     transport_kind:account.provider==='gmail'?'gmail_raw':'graph_raw',...(input.thread_id?{thread_id:input.thread_id}:{})});
    await value.check();
    if(!reserved||result.account_id!==account.account_id||result.operation_id!==input.operation_id||result.transport_outcome!=='provider_accepted'
      ||result.sent_copy_outcome!=='pending'||result.delivery_status!=='unknown'||account.provider==='gmail'&&(typeof result.provider_message_id!=='string'||!result.provider_message_id)
      ||account.provider==='microsoft'&&result.provider_message_id!==null)fail('EMAIL_NATIVE_SEND_RESULT_UNKNOWN',{outcome:'uncertain'});
    return {schema_version:'deft.email_send_result.v1',...result,provider:account.provider};
   }finally{bytes.fill(0);}
  }
 });
}
