import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {NativeEmailDraftSyncResultSchema,type NativeEmailDraftSyncEffect,type NativeEmailDraftSyncRequest} from './app-connection-contract.js';
import type {EmailServiceLease} from './email-mailbox-authority.js';
import type {EmailCapability,EmailScope} from './email-mailbox-service.js';
import type {EmailDraftGuard} from './email-draft-store.js';
import {EmailProviderDraftMirrorStore,type ClaimedEmailProviderDraftMirror} from './email-provider-draft-mirror-store.js';
import type {EmailProviderDraftMirrorPrivateState,EmailProviderDraftCurrent} from './email-provider-draft-mirror-service.js';
import type {EmailSendStore} from './email-send-store.js';
import type {RegisteredEmailNativeDraftProvider} from './email-native-draft-provider.js';

const Scope=z.strictObject({org_id:z.string().min(1).max(256),owner_user_id:z.string().min(1).max(256),account_id:z.string().min(1).max(256)});
const Id=z.string().uuid(),Revision=z.number().int().min(1).max(2147483647),Digest=z.string().regex(/^[a-f0-9]{64}$/u);
const CleanupDescriptor=z.strictObject({operation_id:Id,send_operation_id:Id,draft_revision:Revision,desired_revision:Revision,
  provider:z.enum(['gmail','microsoft']),provider_draft_ref:z.string().min(1).max(256),baseline_digest:Digest,provider_version:z.string().min(1).max(256)});
type Descriptor=z.infer<typeof CleanupDescriptor>;
type ProviderState=EmailProviderDraftMirrorPrivateState&Readonly<{cleanup?:Descriptor}>;
type AcceptedInput=Readonly<{operation_id:string;draft_id:string;revision:number}>;
export type EmailProviderDraftCleanupOutcome=Readonly<{state:'deleted'|'delete_pending'|'conflict'|'unknown'|'unsupported'|'skipped';revision:number}>;
export type EmailProviderDraftCleanupCurrent=EmailProviderDraftCurrent;

const denied=()=>new Error('EMAIL_DRAFT_CLEANUP_ACCESS_DENIED');
const retry=()=>new Error('EMAIL_DRAFT_CLEANUP_RETRY');
const validState=(scope:EmailScope,value:unknown):ProviderState=>{
  const cleanupState=CleanupDescriptor.optional();
  const schema=z.strictObject({schema_version:z.literal('deft.email_provider_draft_state.v1'),account_id:z.string().min(1).max(256),
    provider:z.enum(['gmail','microsoft']),provider_draft_ref:z.string().min(1).max(256),baseline_digest:Digest,
    provider_version:z.string().min(1).max(256),recovery:z.unknown().optional(),cleanup:cleanupState});
  const parsed=schema.parse(value);if(parsed.account_id!==scope.account_id)throw retry();return parsed as ProviderState;
};
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;

/** Delete only the exact provider draft revision whose Deft send receipt is
 * already accepted. Unknown deletes retain an encrypted inspect-only plan. */
export class EmailProviderDraftCleanupService{
  constructor(private readonly currentService:EmailProviderDraftCleanupCurrent,private readonly mirrors:EmailProviderDraftMirrorStore,
    private readonly sends:EmailSendStore,private readonly provider:Pick<RegisteredEmailNativeDraftProvider,'sync'>,private readonly now=Date.now){
    if(typeof currentService!=='function'||!mirrors||!sends||typeof provider?.sync!=='function')throw retry();
  }

  private async current(scope:EmailScope,lease:EmailServiceLease,expected?:EmailCapability,tx?:unknown,signal?:AbortSignal):Promise<EmailCapability>{
    signal?.throwIfAborted();let cap:EmailCapability;try{cap=await this.currentService(scope,lease,tx,signal);}catch(error){if(signal?.aborted)throw error;throw denied();}
    if(!sameScope(scope,cap.scope)||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now()||!cap.resource_binding_id||!cap.authority_version
      ||expected&&(expected.resource_binding_id!==cap.resource_binding_id||expected.authority_version!==cap.authority_version))throw denied();
    signal?.throwIfAborted();return cap;
  }

  private async run(input:Readonly<{scope:EmailScope;draft_id:string;revision:number;operation_id:string;lease:EmailServiceLease;signal?:AbortSignal;reconcile:boolean}>):Promise<EmailProviderDraftCleanupOutcome>{
    const {scope,draft_id:draftId,revision,operation_id:sendOperationId,lease,signal,reconcile}=input;
    if(lease.job_name!=='native-email-draft-cleanup'||lease.draft_id!==draftId||lease.revision!==revision||lease.operation_id!==sendOperationId
      ||lease.mode!==(reconcile?'reconcile':'delete')||!Number.isSafeInteger(lease.generation)||lease.generation<1
      ||lease.job_id.length<1||lease.lock_token.length<16)throw denied();
    const accepted:AcceptedInput={operation_id:sendOperationId,draft_id:draftId,revision};
    const capability=await this.current(scope,lease,undefined,undefined,signal);
    const serviceGuard:EmailDraftGuard=async tx=>{await this.current(scope,lease,capability,tx,signal);};
    const acceptedInTransaction=async(tx:unknown)=>this.sends.verifyAccepted(scope,accepted,async()=>{},signal,tx);
    const guard:EmailDraftGuard=async tx=>{await serviceGuard(tx);if(!await acceptedInTransaction(tx))throw denied();};
    const claim=reconcile
      ?await this.mirrors.claimAcceptedCleanupRecovery(scope,draftId,revision,lease.generation,sendOperationId,lease.lock_token,guard,acceptedInTransaction,signal)
      :await this.mirrors.claimAcceptedCleanup(scope,draftId,revision,lease.generation,lease.lock_token,guard,acceptedInTransaction,signal);
    if(!claim)return Object.freeze({state:'skipped',revision});
    let state:ProviderState|undefined;
    let effectAuthorized=false;
    let finalizationLost=false;
    const readbacks:Uint8Array[]=[];
    const readState=()=>claim.provider_state?validState(scope,claim.provider_state):null;
    const baseState=(value:ProviderState):ProviderState=>{const {cleanup:_cleanup,...base}=value;return base as ProviderState;};
    const finish=async(next:'deleted'|'delete_pending'|'conflict'|'unknown'|'unsupported',providerState?:ProviderState,errorCode?:string)=>{
      const result=await this.mirrors.finish(scope,draftId,claim,lease.lock_token,{state:next,...(providerState?{provider_state:providerState}:{}),error_code:errorCode??null},guard,signal);
      if(!result){finalizationLost=true;throw denied();}return result;
    };
    const invoke=async(request:NativeEmailDraftSyncRequest)=>{
      const result=NativeEmailDraftSyncResultSchema.parse(await this.provider.sync(request,{scope,capability,
        recheck:async()=>{await this.current(scope,lease,capability,undefined,signal);},signal,
        draft_sync_before_effect:async(raw:NativeEmailDraftSyncEffect)=>{
          const target=state?.cleanup;
          if(!target||raw.operation!=='delete'||raw.operation_id!==target.operation_id||raw.account_id!==scope.account_id
            ||raw.authority_epoch<1||raw.provider_draft_ref!==target.provider_draft_ref||raw.baseline_digest!==target.baseline_digest||raw.desired_digest!==null)return false;
          await guardInNewTransaction();
          const valid=await this.mirrors.verifyClaim(scope,draftId,claim,lease.lock_token,guard,signal);
          if(valid)effectAuthorized=true;return valid;
        }}));
      const pinned=state;
      if(!pinned||result.account_id!==scope.account_id||result.provider!==pinned.provider||result.operation_id!==request.operation_id){
        result.mime_bytes?.fill(0);throw retry();
      }
      if(result.mime_bytes)readbacks.push(result.mime_bytes);return result;
    };
    const guardInNewTransaction=async()=>{await this.current(scope,lease,capability,undefined,signal);
      if(!await this.sends.verifyAccepted(scope,accepted,async tx=>{await this.current(scope,lease,capability,tx,signal);},signal))throw denied();};
    try{
      const previous=readState();if(!previous||previous.provider!== 'gmail'&&previous.provider!=='microsoft'||!reconcile&&previous.cleanup!==undefined)throw retry();
      state=previous;
      if(!reconcile){
        const descriptor:Descriptor={operation_id:claim.operation_id,send_operation_id:sendOperationId,draft_revision:revision,desired_revision:revision,
          provider:previous.provider,provider_draft_ref:previous.provider_draft_ref,baseline_digest:previous.baseline_digest,provider_version:previous.provider_version};
        state=Object.freeze({...previous,cleanup:descriptor});
        if(!await this.mirrors.pinCleanup(scope,draftId,claim,lease.lock_token,descriptor,guard,signal))throw denied();
        const observed=await invoke({operation:'inspect',operation_id:randomUUID(),provider_draft_ref:previous.provider_draft_ref});
        if(observed.outcome==='missing'){
          await finish('deleted',undefined,'EMAIL_DRAFT_PROVIDER_MISSING');return Object.freeze({state:'deleted',revision});
        }
        if(observed.outcome!=='present'){
          const next=observed.outcome==='unsupported'?'unsupported':observed.outcome==='unknown'?'unknown':'conflict';
          await finish(next,next==='unknown'?state:previous,'EMAIL_DRAFT_CLEANUP_PREFLIGHT');
          return Object.freeze({state:next,revision});
        }
        if(observed.provider_draft_ref!==previous.provider_draft_ref||observed.baseline_digest!==previous.baseline_digest
          ||observed.provider_version!==previous.provider_version){await finish('conflict',baseState(state),'EMAIL_DRAFT_PROVIDER_CHANGED');return Object.freeze({state:'conflict',revision});}
        const deleted=await invoke({operation:'delete',operation_id:descriptor.operation_id,provider_draft_ref:descriptor.provider_draft_ref,
          baseline_digest:descriptor.baseline_digest,provider_version:descriptor.provider_version});
        if(deleted.outcome==='deleted'||deleted.outcome==='missing'){
          await finish('deleted',undefined);return Object.freeze({state:'deleted',revision});
        }
        if(deleted.outcome==='unknown'){
          await finish('unknown',state,'EMAIL_DRAFT_CLEANUP_UNKNOWN');return Object.freeze({state:'unknown',revision});
        }
        const next=deleted.outcome==='unsupported'?'unsupported':'conflict';await finish(next,previous,'EMAIL_DRAFT_CLEANUP_CONFLICT');
        return Object.freeze({state:next,revision});
      }
      const pinned=CleanupDescriptor.parse(previous.cleanup);if(pinned.send_operation_id!==sendOperationId||pinned.draft_revision!==revision
        ||pinned.desired_revision!==revision||pinned.operation_id!==claim.operation_id){await finish('unknown',previous,'EMAIL_DRAFT_CLEANUP_BINDING_MISMATCH');return Object.freeze({state:'unknown',revision});}
      state=previous;
      const observed=await invoke({operation:'inspect',operation_id:randomUUID(),provider_draft_ref:pinned.provider_draft_ref});
      if(observed.outcome==='missing'){
        await finish('deleted',undefined);return Object.freeze({state:'deleted',revision});
      }
      if(observed.outcome==='present'&&observed.provider_draft_ref===pinned.provider_draft_ref
        &&observed.baseline_digest===pinned.baseline_digest&&observed.provider_version===pinned.provider_version){
        await finish('unknown',previous,'EMAIL_DRAFT_CLEANUP_DELETE_NOT_OBSERVED');return Object.freeze({state:'unknown',revision});
      }
      if(observed.outcome==='conflict'||observed.outcome==='present'){
        await finish('conflict',baseState(previous),'EMAIL_DRAFT_CLEANUP_PROVIDER_CHANGED');return Object.freeze({state:'conflict',revision});
      }
      const next=observed.outcome==='unsupported'?'unsupported':'unknown';await finish(next,previous,'EMAIL_DRAFT_CLEANUP_INSPECT_UNAVAILABLE');
      return Object.freeze({state:next,revision});
    }catch(error){
      if(signal?.aborted)throw signal.reason;if(finalizationLost)throw denied();
      if(effectAuthorized){await finish('unknown',state,'EMAIL_DRAFT_CLEANUP_UNKNOWN');throw retry();}
      if(!reconcile)await finish('delete_pending',state?baseState(state):undefined,'EMAIL_DRAFT_CLEANUP_RETRY');
      else await finish('unknown',state,'EMAIL_DRAFT_CLEANUP_RETRY');
      throw error instanceof Error&&error.message==='EMAIL_DRAFT_CLEANUP_ACCESS_DENIED'?error:retry();
    }finally{for(const bytes of readbacks)bytes.fill(0);}
  }

  deleteAccepted(scopeRaw:EmailScope,draftIdRaw:string,revisionRaw:number,sendOperationIdRaw:string,lease:EmailServiceLease,signal?:AbortSignal):Promise<EmailProviderDraftCleanupOutcome>{
    return this.run({scope:Object.freeze(Scope.parse(scopeRaw)),draft_id:Id.parse(draftIdRaw),revision:Revision.parse(revisionRaw),operation_id:Id.parse(sendOperationIdRaw),lease,signal,reconcile:false});
  }
  reconcileUnknown(scopeRaw:EmailScope,draftIdRaw:string,revisionRaw:number,sendOperationIdRaw:string,lease:EmailServiceLease,signal?:AbortSignal):Promise<EmailProviderDraftCleanupOutcome>{
    return this.run({scope:Object.freeze(Scope.parse(scopeRaw)),draft_id:Id.parse(draftIdRaw),revision:Revision.parse(revisionRaw),operation_id:Id.parse(sendOperationIdRaw),lease,signal,reconcile:true});
  }
}
