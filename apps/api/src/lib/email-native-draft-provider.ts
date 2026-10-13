import {createHash} from 'node:crypto';
import {NativeEmailDraftSyncRequestSchema,NativeEmailDraftSyncResultSchema,type NativeEmailDraftSyncRequest,type NativeEmailDraftSyncResult,type NativeEmailDraftSyncEffect,type NativeEmailAccount} from './app-connection-contract.js';
import type {NativeEmailConnectionResolver} from './email-mailbox-provider.js';
import {EmailMailboxError,type EmailScope,type EmailCapability} from './email-mailbox-service.js';
const denied=()=>new EmailMailboxError('EMAIL_ACCESS_DENIED');
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;
const fingerprint=(account:NativeEmailAccount)=>JSON.stringify([account.account_id,account.provider,account.resource_binding_id,account.principal_digest,account.connection_revision,account.authority_epoch,account.health,account.capabilities,account.primary_address]);
export type EmailNativeDraftSyncHost=Readonly<{scope:EmailScope;capability:EmailCapability;recheck:()=>Promise<void>;signal?:AbortSignal;draft_sync_before_effect?:(input:NativeEmailDraftSyncEffect)=>Promise<boolean>}>;
/** Server-only mapped draft mirror. Refs/versions/MIME never become a browser
 * contract, and this wrapper never retries an uncertain effect. */
export class RegisteredEmailNativeDraftProvider{
 constructor(private readonly resolve:NativeEmailConnectionResolver,private readonly now=Date.now){}
 async sync(rawInput:NativeEmailDraftSyncRequest,host:EmailNativeDraftSyncHost):Promise<NativeEmailDraftSyncResult>{
  const input=NativeEmailDraftSyncRequestSchema.parse(rawInput),scope=Object.freeze({...host.scope}),cap=host.capability;
  host.signal?.throwIfAborted();if(!cap?.scope||!sameScope(scope,cap.scope)||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now())throw denied();
  const {adapter,context}=await this.resolve(scope,cap,host.recheck,host.signal,'draft_sync');
  if(!adapter?.nativeEmailAccount||!adapter.nativeEmailDraftSync||!sameScope(scope,context)||context.resource_binding_id!==cap.resource_binding_id||context.authority_version!==cap.authority_version
   ||context.signal!==host.signal||typeof context.recheck!=='function'||!Number.isFinite(context.expires_at)||context.expires_at<=this.now()||context.expires_at>cap.expires_at)throw denied();
  const {draft_sync_before_effect:ignored,draft_sync_journal:journal,...statusContext}=context;
  const current=async()=>{host.signal?.throwIfAborted();await host.recheck();if(context.expires_at<=this.now()||cap.expires_at<=this.now())throw denied();
   const account=await adapter.nativeEmailAccount!(statusContext);if(account.account_id!==scope.account_id||account.resource_binding_id!==cap.resource_binding_id||!['gmail','microsoft'].includes(account.provider)
    ||account.health!=='connected'||!account.capabilities.includes('modify')||!account.capabilities.includes('read')||!/^[a-f0-9]{64}$/u.test(account.principal_digest??'')||!Number.isSafeInteger(account.connection_revision)||account.connection_revision<1)throw denied();host.signal?.throwIfAborted();return account;};
  const before=await current();if(input.operation!=='inspect'&&typeof host.draft_sync_before_effect!=='function')throw denied();let result:NativeEmailDraftSyncResult|undefined;
  try{result=await adapter.nativeEmailDraftSync(input,{...statusContext,...(journal?{draft_sync_journal:journal}:{}),...(host.draft_sync_before_effect?{draft_sync_before_effect:host.draft_sync_before_effect}:{})});
   const after=await current();await host.recheck();host.signal?.throwIfAborted();const parsed=NativeEmailDraftSyncResultSchema.parse(result);
   if(fingerprint(before)!==fingerprint(after)||parsed.account_id!==scope.account_id||parsed.provider!==before.provider||parsed.operation_id!==input.operation_id
    ||input.provider_draft_ref&&parsed.provider_draft_ref!==input.provider_draft_ref||parsed.mime_bytes&&createHash('sha256').update(parsed.mime_bytes).digest('hex')!==parsed.baseline_digest
    ||!({inspect:['present','missing','conflict'],create:['created','conflict','unknown'],update:['updated','missing','conflict','unsupported','unknown'],delete:['deleted','missing','conflict','unknown']} as const)[input.operation].some(outcome=>outcome===parsed.outcome))throw denied();
   return parsed;
  }catch(error){result?.mime_bytes?.fill(0);throw error;}
 }
}
