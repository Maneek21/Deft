import {canonicalCapabilityJson} from '@deft/shared';
import {NativeEmailSentCopyRequestSchema,NativeEmailSentCopyResultSchema,EmailSentCopySettingsSchema,type NativeEmailSentCopyRequest} from './email-sent-copy-contract.js';
import type {NativeEmailConnectionContext} from './email-native-adapter-contract.js';
import type {NativeEmailConnectionResolver} from './email-mailbox-provider.js';
import type {EmailScope,EmailCapability} from './email-mailbox-service.js';
export class RegisteredEmailSentCopyProvider{
 constructor(private readonly resolve:NativeEmailConnectionResolver,private readonly now=Date.now){}
 async settings(scope:EmailScope,cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal){
  signal?.throwIfAborted();if(canonicalCapabilityJson(cap.scope)!==canonicalCapabilityJson(scope)||cap.expires_at<=this.now())throw Error('EMAIL_ACCESS_DENIED');
  const {adapter,context}=await this.resolve(scope,cap,recheck,signal,'sent_copy_settings');if(!adapter.nativeEmailSentCopySettings||context.org_id!==scope.org_id||context.owner_user_id!==scope.owner_user_id||context.account_id!==scope.account_id
   ||context.resource_binding_id!==cap.resource_binding_id||context.authority_version!==cap.authority_version||context.expires_at>cap.expires_at||context.expires_at<=this.now()||context.signal!==signal)throw Error('EMAIL_ACCESS_DENIED');
  await recheck();const value=EmailSentCopySettingsSchema.parse(await adapter.nativeEmailSentCopySettings(context));await recheck();signal?.throwIfAborted();if(value.account_id!==scope.account_id)throw Error('EMAIL_ACCESS_DENIED');return value;
 }
 async copy(raw:NativeEmailSentCopyRequest,host:{scope:EmailScope;capability:EmailCapability;recheck:()=>Promise<void>;signal?:AbortSignal;
  sent_copy_before_append:NonNullable<NativeEmailConnectionContext['sent_copy_before_append']>}){
  const input=NativeEmailSentCopyRequestSchema.parse(raw),cap=host.capability;host.signal?.throwIfAborted();
  if(canonicalCapabilityJson(cap.scope)!==canonicalCapabilityJson(host.scope)||cap.expires_at<=this.now())throw Error('EMAIL_ACCESS_DENIED');
  const {adapter,context}=await this.resolve(host.scope,cap,host.recheck,host.signal,'sent_copy');
  if(!adapter.nativeEmailSentCopy||context.org_id!==host.scope.org_id||context.owner_user_id!==host.scope.owner_user_id||context.account_id!==host.scope.account_id
   ||context.resource_binding_id!==cap.resource_binding_id||context.authority_version!==cap.authority_version||context.expires_at>cap.expires_at||context.expires_at<=this.now()
   ||context.signal!==host.signal||typeof context.recheck!=='function'||!context.sent_copy_journal)throw Error('EMAIL_ACCESS_DENIED');
  await host.recheck();const result=NativeEmailSentCopyResultSchema.parse(await adapter.nativeEmailSentCopy(input,{...context,sent_copy_before_append:host.sent_copy_before_append}));
  await host.recheck();host.signal?.throwIfAborted();if(result.account_id!==host.scope.account_id||result.operation_id!==input.operation_id||result.mime_digest!==input.mime_digest||context.expires_at<=this.now())throw Error('EMAIL_ACCESS_DENIED');return result;
 }
}
