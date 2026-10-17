import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {PostgresEmailMailboxAuthority,type EmailServiceLease} from './email-mailbox-authority.js';
import {inspectEmailMailboxConnection} from './email-mailbox-connected-authority.js';
import {getEmailMailboxComponents} from './email-mailbox-runtime.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailDraftStore} from './email-draft-store.js';
import {EmailAttachmentStore} from './email-attachment-store.js';
import {EmailAttachmentCrypto} from './email-attachment-crypto.js';
import {EmailProviderDraftMirrorStore} from './email-provider-draft-mirror-store.js';
import {EmailProviderDraftMirrorService} from './email-provider-draft-mirror-service.js';
import {RegisteredEmailNativeDraftProvider} from './email-native-draft-provider.js';
import {createEmailProviderDraftMimeBuilder} from './email-provider-draft-mime.js';
import {createEmailNativeReplyResolver} from './email-native-reply.js';
import {EmailMailboxError,type EmailScope,type EmailCapability} from './email-mailbox-service.js';
import {NativeEmailSendIdentitySchema} from './email-native-adapter-contract.js';

/** Native background draft sync is authorized by its actual queue lease and
 * explicit account opt-in. No human bearer token or artificial session exists. */
export async function runEmailProviderDraftSync(scope:EmailScope,draftId:string,revision:number,lease:EmailServiceLease,signal?:AbortSignal){
 if(lease.job_name!=='native-email-draft-sync'||lease.draft_id!==draftId||lease.revision!==revision)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
 const base=await getEmailMailboxAuthority(db),sql=(account:EmailScope,tx?:unknown,abort?:AbortSignal)=>base.currentService(account,lease,tx,abort);
 const [{store,provider,resolve},{keys}]=await Promise.all([getEmailMailboxComponents(sql),getAppRunRuntime()]);
 const current=async(account:EmailScope,delivery:EmailServiceLease,tx?:unknown,abort?:AbortSignal)=>{
  if(delivery.job_id!==lease.job_id||delivery.lock_token!==lease.lock_token||delivery.job_name!=='native-email-draft-sync'
   ||delivery.draft_id!==draftId||delivery.revision!==revision||delivery.mode!==lease.mode||delivery.generation!==lease.generation)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  const inspected=await inspectEmailMailboxConnection(account,()=>sql(account,tx,abort),provider,abort);
  if(!inspected.account.capabilities.includes('modify'))throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return inspected.capability;
 };
 const cipher=new EmailMailboxCrypto(keys),files=new EmailAttachmentStore(db,cipher,new EmailAttachmentCrypto(keys));
 const guard=(cap:EmailCapability,tx?:unknown,abort?:AbortSignal)=>current(scope,lease,tx,abort).then(value=>{
  if(value.authority_version!==cap.authority_version||value.resource_binding_id!==cap.resource_binding_id)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
 });
 const prepareDesired=createEmailProviderDraftMimeBuilder({
  resolve:async input=>{
   const account=await provider.assertConnected(input.scope,input.capability,input.recheck,input.signal);
   const selected=await resolve(input.scope,input.capability,input.recheck,input.signal,'draft_sync');await input.recheck();
   if(!selected.adapter.nativeEmailDraftMime)throw Error('EMAIL_DRAFT_SYNC_UNAVAILABLE');
   let verified_sender_identities:readonly string[]|undefined;
   if(selected.adapter.nativeEmailSendIdentity){
    try{
     const identity=NativeEmailSendIdentitySchema.parse(await selected.adapter.nativeEmailSendIdentity(selected.context));
     if(identity.account_id!==account.account_id||identity.org_id!==input.scope.org_id||identity.owner_user_id!==input.scope.owner_user_id
       ||identity.installation_id!==selected.context.installation_id||identity.provider!==account.provider||identity.resource_binding_id!==account.resource_binding_id
       ||identity.authority_epoch!==account.authority_epoch||identity.connection_revision!==account.connection_revision
       ||identity.principal_digest!==account.principal_digest||identity.primary_address!==account.primary_address
       ||identity.health!=='connected'||!identity.verified_sender_identities.includes(account.primary_address))throw Error();
     await input.recheck();
     const after=await provider.assertConnected(input.scope,input.capability,input.recheck,input.signal);
     if(after.provider!==account.provider||after.account_id!==account.account_id||after.resource_binding_id!==account.resource_binding_id
       ||after.authority_epoch!==account.authority_epoch||after.connection_revision!==account.connection_revision||after.principal_digest!==account.principal_digest)throw Error();
     verified_sender_identities=identity.verified_sender_identities;
    }catch(error){if(input.signal?.aborted)throw input.signal.reason;}
   }
   return {account,verified_sender_identities,installation_id:selected.context.installation_id,serialize:selected.adapter.nativeEmailDraftMime};
  },
  readFile:(input,file)=>files.read(input.scope,input.draft.draft_id,file.file_id,file,tx=>guard(input.capability,tx,input.signal),input.signal),
  readReply:async(input,logicalId)=>{
   const replies=createEmailNativeReplyResolver<undefined>(store,{readPresentation:async(_principal,account,id,abort)=>{
    const message=await store.readMessage(account,id,abort);if(!message)throw Error('EMAIL_DRAFT_SYNC_REPLY_UNAVAILABLE');
    return provider.readPresentation(account,{source:message.provider_source},input.capability,input.recheck,abort);
   }});
   return replies(undefined,input.scope,logicalId,input.recheck,input.signal);
  },
 });
 const service=new EmailProviderDraftMirrorService(current,new EmailDraftStore(db,cipher),new EmailProviderDraftMirrorStore(db,cipher),
  {prepareDesired},new RegisteredEmailNativeDraftProvider(resolve));
 return lease.mode==='reconcile'?service.reconcileUnknown(scope,draftId,revision,lease,signal):service.sync(scope,draftId,revision,lease,signal);
}
