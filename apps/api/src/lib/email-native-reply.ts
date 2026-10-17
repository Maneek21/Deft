import {createHash} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import type {EmailActor,EmailScope,EmailMessageRecord} from './email-mailbox-service.js';
import type {EmailMessageContentStore} from './email-message-content.js';
import type {NativeEmailPresentation} from './email-native-adapter-contract.js';
const fingerprint=(record:EmailMessageRecord)=>createHash('sha256').update(canonicalCapabilityJson([record.account_id,record.logical_message_id,record.revision,record.provider_source])).digest('hex');
const messageId=(value:string)=>/^<[^<>\s@]+@[^<>\s@]+>$/u.test(value)&&value.length<=200;
/** Private reply context never sends a raw provider locator to the browser. The
 * content service checks custody and MIME; this fence couples it to the cached
 * provider thread identity used only for the outgoing transport. */
export function createEmailNativeReplyResolver<Principal=EmailActor>(store:EmailMessageContentStore,content:{readPresentation(principal:Principal,scope:EmailScope,logicalId:string,signal?:AbortSignal):Promise<NativeEmailPresentation>}){
 return async(actor:Principal,scope:EmailScope,logicalId:string,recheck:()=>Promise<void>,signal?:AbortSignal)=>{
  await recheck();signal?.throwIfAborted();const before=await store.readMessage(scope,logicalId,signal);
  if(!before||before.account_id!==scope.account_id||before.logical_message_id!==logicalId)throw Error('EMAIL_SEND_REPLY_UNAVAILABLE');
  const source=await content.readPresentation(actor,scope,logicalId,signal);await recheck();
  const after=await store.readMessage(scope,logicalId,signal);await recheck();signal?.throwIfAborted();
  if(!after||fingerprint(before)!==fingerprint(after)||source.account_id!==scope.account_id||source.logical_message_id!==logicalId||source.provider!==before.provider_source.provider)throw Error('EMAIL_SEND_REPLY_UNAVAILABLE');
  const metadata=source.presentation.metadata,id=metadata.message_id.trim(),references=metadata.references.trim()?metadata.references.trim().split(/\s+/u):[];
  if(!messageId(id)||references.length>32||references.some(ref=>!messageId(ref))||references.join(' ').length>1000)throw Error('EMAIL_SEND_REPLY_UNAVAILABLE');
  let thread_id:string|undefined;
  if(source.provider==='gmail'){
   const locator=before.provider_source.locator;
   if(!locator||typeof locator!=='object'||Array.isArray(locator)||typeof locator.thread_id!=='string'||!locator.thread_id||locator.thread_id.length>256||/[\u0000-\u001f\u007f]/u.test(locator.thread_id))throw Error('EMAIL_SEND_REPLY_UNAVAILABLE');
   thread_id=locator.thread_id;
  }
  return {account_id:scope.account_id,provider:source.provider,logical_message_id:logicalId,message_id:id,references,
   from:metadata.reply_from,to:metadata.reply_to_list,cc:metadata.reply_cc,reply_to:metadata.reply_to,
   ...(source.reply_seed_unavailable?{reply_seed_unavailable:[...source.reply_seed_unavailable]}:{}),...(thread_id?{thread_id}:{})};
 };
}
