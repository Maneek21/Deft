import {z} from 'zod';
import {NativeEmailSendIdentitySchema, NativeEmailSendResultSchema, NativeEmailPrepareSendResultSchema, type NativeEmailSendIdentity} from './email-native-adapter-contract.js';
import type {NativeEmailConnectionResolver} from './email-mailbox-provider.js';
import type {EmailNativeSendProvider} from './email-native-send-service.js';
import {EmailMailboxError,type EmailScope,type EmailCapability} from './email-mailbox-service.js';
const id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope=z.strictObject({org_id:id,owner_user_id:id,account_id:id});
const Input=z.strictObject({operation_id:z.string().uuid(),mime_bytes:z.custom<Uint8Array>(value=>value instanceof Uint8Array&&value.length>=1&&value.length<=35*1024*1024),
  mime_digest:z.string().regex(/^[a-f0-9]{64}$/u),from_address:z.string().email().max(320),transport_kind:z.enum(['gmail_raw','graph_raw','smtp_raw']),thread_id:id.optional(),
  envelope:z.strictObject({from:z.string().email().max(320),to:z.array(z.string().email().max(320)).min(1).max(500).refine(rows=>new Set(rows.map(row=>row.toLowerCase())).size===rows.length)}).optional()});
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;
const identity=(a:NativeEmailSendIdentity)=>JSON.stringify([a.account_id,a.provider,a.resource_binding_id,a.authority_epoch,a.connection_revision,a.principal_digest,a.action_binding_id,a.primary_address,a.verified_sender_identities,a.implementation_digest??null]);
const denied=()=>new EmailMailboxError('EMAIL_ACCESS_DENIED');
/** Server-only registered send identity and reserved immutable MIME adapter. */
export class RegisteredEmailNativeSendProvider implements EmailNativeSendProvider{
  constructor(private readonly resolve:NativeEmailConnectionResolver,private readonly now=Date.now){}
  private async selected(rawScope:EmailScope,cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal){
    const scope=Object.freeze(Scope.parse(rawScope));signal?.throwIfAborted();if(!cap?.scope||!sameScope(scope,cap.scope)||!id.safeParse(cap.resource_binding_id).success
      ||!id.safeParse(cap.authority_version).success||!Number.isFinite(this.now())||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now())throw denied();
    const {adapter,context}=await this.resolve(scope,cap,recheck,signal,'send');
    if(!adapter.nativeEmailSendIdentity||!sameScope(scope,context)||context.resource_binding_id!==cap.resource_binding_id||context.authority_version!==cap.authority_version
      ||context.signal!==signal||typeof context.recheck!=='function'||!Number.isFinite(context.expires_at)||context.expires_at<=this.now()||context.expires_at>cap.expires_at)throw denied();
    const {send_before_reserve:ignored,send_prepare_before_effect:ignoredPrepare,send_upload_journal:ignoredJournal,...identityContext}=context;
    const current=async()=>{signal?.throwIfAborted();await recheck();if(this.now()>=context.expires_at)throw denied();const account=NativeEmailSendIdentitySchema.parse(await adapter.nativeEmailSendIdentity!(identityContext));
      if(account.account_id!==scope.account_id||account.org_id!==scope.org_id||account.owner_user_id!==scope.owner_user_id||account.installation_id!==context.installation_id
        ||account.resource_binding_id!==cap.resource_binding_id)throw denied();signal?.throwIfAborted();return account;};
    return {scope,adapter,context,current};
  }
  async getSendIdentity(scope:EmailScope,capability:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal){const selected=await this.selected(scope,capability,recheck,signal),value=await selected.current();await recheck();return value;}
  async prepare(rawInput:Parameters<EmailNativeSendProvider['send']>[0],host:Omit<Parameters<EmailNativeSendProvider['send']>[1],'send_before_reserve'>&{send_prepare_before_effect:(input:{operation_id:string;account_id:string;authority_epoch:number;mime_digest:string})=>Promise<boolean>}){
   const input=Input.parse(rawInput),selected=await this.selected(host.scope,host.capability,host.recheck,host.signal),before=await selected.current();
   if(!selected.adapter.nativeEmailPrepareSend||before.provider!=='microsoft'||!before.capabilities.includes('modify')||input.transport_kind!=='graph_raw'||input.thread_id||input.envelope||!before.verified_sender_identities.includes(input.from_address)||typeof host.send_prepare_before_effect!=='function')throw denied();
   const {transport_kind:ignored,...request}=input,{send_before_reserve:ignoredSend,...context}=selected.context;
   const result=NativeEmailPrepareSendResultSchema.parse(await selected.adapter.nativeEmailPrepareSend(request,{...context,send_prepare_before_effect:host.send_prepare_before_effect}));
   const after=await selected.current();await host.recheck();if(identity(before)!==identity(after)||result.account_id!==host.scope.account_id||result.operation_id!==input.operation_id||result.mime_digest!==input.mime_digest)throw denied();return result;
  }
  async send(rawInput:Parameters<EmailNativeSendProvider['send']>[0],host:Parameters<EmailNativeSendProvider['send']>[1]){
    const input=Input.parse(rawInput),selected=await this.selected(host.scope,host.capability,host.recheck,host.signal),before=await selected.current();
    if(!selected.adapter.nativeEmailSend||typeof host.send_before_reserve!=='function'||input.transport_kind!==({gmail:'gmail_raw',microsoft:'graph_raw',imap_smtp:'smtp_raw'} as const)[before.provider]
      ||(before.provider==='imap_smtp'?input.envelope?.from!==input.from_address||input.envelope.to.length>200||input.thread_id!==undefined:input.envelope!==undefined)
      ||!before.verified_sender_identities.includes(input.from_address))throw denied();
    const {transport_kind:ignored,...request}=input,{send_prepare_before_effect:ignoredPrepare,...sendContext}=selected.context;
    const result=NativeEmailSendResultSchema.parse(await selected.adapter.nativeEmailSend(request,{...sendContext,send_before_reserve:host.send_before_reserve}));
    const after=await selected.current();await host.recheck();if(identity(before)!==identity(after)||result.account_id!==host.scope.account_id||result.provider!==before.provider||result.operation_id!==input.operation_id)throw denied();return result;
  }
}
