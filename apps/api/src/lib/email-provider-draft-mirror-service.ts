import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {NativeEmailDraftSyncResultSchema, type NativeEmailDraftSyncEffect} from './email-native-adapter-contract.js';
import type { EmailServiceLease } from './email-mailbox-authority.js';
import type { EmailActor,EmailAuthority,EmailCapability, EmailScope } from './email-mailbox-service.js';
import { EmailDraftStore, type EmailDraftGuard, type EmailDraftRow } from './email-draft-store.js';
import { EmailProviderDraftMirrorStore, type ClaimedEmailProviderDraftMirror,type EmailProviderDraftMirrorStatus } from './email-provider-draft-mirror-store.js';
import type { RegisteredEmailNativeDraftProvider } from './email-native-draft-provider.js';

const Scope=z.strictObject({org_id:z.string().min(1).max(256),owner_user_id:z.string().min(1).max(256),account_id:z.string().min(1).max(256)});
const DraftId=z.string().uuid();
const revision=z.number().int().min(1).max(2147483647);
const Previous=z.strictObject({schema_version:z.literal('deft.email_provider_draft_state.v1'),account_id:z.string().min(1).max(256),
  provider:z.enum(['gmail','microsoft']),provider_draft_ref:z.string().min(1).max(256),baseline_digest:z.string().regex(/^[a-f0-9]{64}$/u),
  provider_version:z.string().min(1).max(256),recovery:z.strictObject({operation_id:z.string().uuid(),desired_revision:revision,
    desired_digest:z.string().regex(/^[a-f0-9]{64}$/u),provider_draft_ref:z.string().min(1).max(256),baseline_digest:z.string().regex(/^[a-f0-9]{64}$/u),
    provider_version:z.string().min(1).max(256)}).optional()}).superRefine((value,ctx)=>{
      if(value.recovery&&(value.provider!=='microsoft'||value.recovery.provider_draft_ref!==value.provider_draft_ref
        ||value.recovery.baseline_digest!==value.baseline_digest||value.recovery.provider_version!==value.provider_version))ctx.addIssue({code:'custom',message:'Invalid recovery baseline'});
    });
export type EmailProviderDraftMirrorPrivateState=z.infer<typeof Previous>;
export type PreparedEmailProviderDraftMime=Readonly<{provider:'gmail'|'microsoft';authority_epoch:number;mime_bytes:Uint8Array;mime_digest:string}>;
export interface EmailProviderDraftMimeBuilder {
  prepareDesired(input:Readonly<{scope:EmailScope;draft:EmailDraftRow;capability:EmailCapability;recheck:()=>Promise<void>;signal?:AbortSignal}>):Promise<PreparedEmailProviderDraftMime>;
}
export type EmailProviderDraftCurrent=(scope:EmailScope,lease:EmailServiceLease,transaction?:unknown,signal?:AbortSignal)=>Promise<EmailCapability>;
export type EmailProviderDraftSyncOutcome=Readonly<{state:'synced'|'queued'|'conflict'|'unknown'|'unsupported'|'paused'|'skipped';revision:number}>;
export class EmailProviderDraftMirrorError extends Error {
  constructor(readonly code:'EMAIL_DRAFT_SYNC_ACCESS_DENIED'|'EMAIL_DRAFT_SYNC_RETRY'|'EMAIL_DRAFT_SYNC_INVALID'|'EMAIL_DRAFT_SYNC_UNAVAILABLE') { super(code); this.name='EmailProviderDraftMirrorError'; }
}
const denied=()=>new EmailProviderDraftMirrorError('EMAIL_DRAFT_SYNC_ACCESS_DENIED');
const retry=()=>new EmailProviderDraftMirrorError('EMAIL_DRAFT_SYNC_RETRY');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;
const sameCapability=(a:EmailCapability,b:EmailCapability)=>sameScope(a.scope,b.scope)&&a.resource_binding_id===b.resource_binding_id&&a.authority_version===b.authority_version;
const digestSchema=z.string().regex(/^[a-f0-9]{64}$/u);
const providerState=(scope:EmailScope,value:unknown)=>Previous.parse(value).account_id===scope.account_id?Previous.parse(value):(()=>{throw retry();})();
const stateFromResult=(scope:EmailScope,result:ReturnType<typeof NativeEmailDraftSyncResultSchema.parse>):EmailProviderDraftMirrorPrivateState=>{
  if(!result.provider_draft_ref||!result.baseline_digest||!result.provider_version||result.account_id!==scope.account_id)throw retry();
  return Previous.parse({schema_version:'deft.email_provider_draft_state.v1',account_id:result.account_id,provider:result.provider,
    provider_draft_ref:result.provider_draft_ref,baseline_digest:result.baseline_digest,provider_version:result.provider_version});
};
const knownStateFromResult=(scope:EmailScope,result:ReturnType<typeof NativeEmailDraftSyncResultSchema.parse>)=>
  result.provider_draft_ref&&result.baseline_digest&&result.provider_version?stateFromResult(scope,result):undefined;

/** One leased, account-scoped mirror attempt. MIME preparation is injected from
 * the registered adapter's bundled native serializer and private file reader.
 * Provider preflight and update are not atomic compare-and-swap operations. */
export class EmailProviderDraftMirrorService {
  constructor(private readonly currentService:EmailProviderDraftCurrent,private readonly drafts:EmailDraftStore,
    private readonly mirrors:EmailProviderDraftMirrorStore,private readonly mime:EmailProviderDraftMimeBuilder,
    private readonly provider:Pick<RegisteredEmailNativeDraftProvider,'sync'>,private readonly now=Date.now) {
    if(typeof currentService!=='function'||!drafts||!mirrors||typeof mime?.prepareDesired!=='function'||typeof provider?.sync!=='function')throw retry();
  }

  private async current(scope:EmailScope,lease:EmailServiceLease,expected?:EmailCapability,tx?:unknown,signal?:AbortSignal):Promise<EmailCapability>{
    signal?.throwIfAborted();let capability:EmailCapability;
    try{capability=await this.currentService(scope,lease,tx,signal);}catch(error){if(signal?.aborted)throw error;throw denied();}
    if(!sameScope(scope,capability.scope)||!Number.isFinite(capability.expires_at)||capability.expires_at<=this.now()
      ||!capability.resource_binding_id||!capability.authority_version||expected&&!sameCapability(expected,capability))throw denied();
    signal?.throwIfAborted();return capability;
  }

  async sync(scopeRaw:EmailScope,draftIdRaw:string,revisionRaw:number,lease:EmailServiceLease,signal?:AbortSignal):Promise<EmailProviderDraftSyncOutcome>{
    return this.syncMode(scopeRaw,draftIdRaw,revisionRaw,lease,signal,false);
  }

  /** Explicit recovery entry point for an operator/job designed to reconcile a
   * durable provider journal. It never retries an unknown create. */
  async reconcileUnknown(scopeRaw:EmailScope,draftIdRaw:string,revisionRaw:number,lease:EmailServiceLease,signal?:AbortSignal):Promise<EmailProviderDraftSyncOutcome>{
    if(lease.job_name!=='native-email-draft-sync'||lease.mode!=='reconcile'||!Number.isSafeInteger(lease.generation)||(lease.generation??0)<1)throw denied();
    return this.syncMode(scopeRaw,draftIdRaw,revisionRaw,lease,signal,true);
  }

  private async syncMode(scopeRaw:EmailScope,draftIdRaw:string,revisionRaw:number,lease:EmailServiceLease,signal:AbortSignal|undefined,reconcile:boolean):Promise<EmailProviderDraftSyncOutcome>{
    let scope:EmailScope,draftId:string,desiredRevision:number;
    try{scope=Object.freeze(Scope.parse(scopeRaw));draftId=DraftId.parse(draftIdRaw);desiredRevision=revision.parse(revisionRaw);}catch{throw new EmailProviderDraftMirrorError('EMAIL_DRAFT_SYNC_INVALID');}
    if(lease.job_name!=='native-email-draft-sync'||lease.draft_id!==draftId||lease.revision!==desiredRevision
      ||reconcile!==(lease.mode==='reconcile')||!reconcile&&lease.mode==='reconcile'
      ||lease.job_id.length<1||lease.lock_token.length<16)throw denied();
    const capability=await this.current(scope,lease,undefined,undefined,signal);
    const guard:EmailDraftGuard=async tx=>{await this.current(scope,lease,capability,tx,signal);};
    const claim=reconcile?await this.mirrors.claimRecovery(scope,draftId,lease.generation??0,lease.lock_token,guard,signal)
      :await this.mirrors.claim(scope,draftId,desiredRevision,lease.lock_token,guard,signal);
    if(!claim)return Object.freeze({state:'skipped',revision:desiredRevision});

    let prepared:PreparedEmailProviderDraftMime|undefined;
    const readbacks:Uint8Array[]=[];
    let effectAuthorized=false;
    let finalizationLost=false;
    let recoveryState:EmailProviderDraftMirrorPrivateState|undefined;
    let requestEffect:Readonly<{operation:'create'|'update';provider_draft_ref:string|null;baseline_digest:string|null;desired_digest:string}>|undefined;
    const recheck=async()=>{await this.current(scope,lease,capability,undefined,signal);};
    const effect=async(raw:NativeEmailDraftSyncEffect):Promise<boolean>=>{
      const item=raw;
      if(!requestEffect||item.operation_id!==claim.operation_id||item.account_id!==scope.account_id
        ||item.authority_epoch!==prepared?.authority_epoch||item.operation!==requestEffect.operation
        ||item.provider_draft_ref!==requestEffect.provider_draft_ref||item.baseline_digest!==requestEffect.baseline_digest
        ||item.desired_digest!==requestEffect.desired_digest)return false;
      await recheck();
      const valid=await this.mirrors.verifyClaim(scope,draftId,claim,lease.lock_token,guard,signal);
      if(valid)effectAuthorized=true;
      return valid;
    };
    const host={scope,capability,recheck,signal,draft_sync_before_effect:effect};
    const invoke=async(request:import('./email-native-adapter-contract.js').NativeEmailDraftSyncRequest)=>{
      const result=NativeEmailDraftSyncResultSchema.parse(await this.provider.sync(request,host));
      if(result.mime_bytes)readbacks.push(result.mime_bytes);
      return result;
    };
    const finish=async(state:'synced'|'conflict'|'unknown'|'unsupported'|'paused',provider_state?:EmailProviderDraftMirrorPrivateState,error_code?:string):Promise<'queued'|'synced'|'conflict'|'unknown'|'unsupported'|'paused'>=>{
      const committed=await this.mirrors.finish(scope,draftId,claim,lease.lock_token,{state,...(provider_state?{provider_state}:{}),error_code:error_code??null},guard,signal);
      if(!committed){finalizationLost=true;throw denied();}
      if(committed==='queued'||committed==='synced'||committed==='conflict'||committed==='unknown'||committed==='unsupported'||committed==='paused')return committed;
      throw retry();
    };

    try{
      const draft=await this.drafts.read(scope,draftId,guard,signal);
      if(!draft||draft.status!=='draft'||draft.revision!==claim.desired_revision||draft.content_revision!==claim.desired_revision){
        if(reconcile){await finish('unknown',claim.provider_state?providerState(scope,claim.provider_state):undefined,'EMAIL_DRAFT_SYNC_REVISION_CHANGED');
          return Object.freeze({state:'unknown',revision:claim.desired_revision});}
        await finish('paused',undefined,'EMAIL_DRAFT_NOT_CURRENT');
        return Object.freeze({state:'paused',revision:desiredRevision});
      }
      prepared=await this.mime.prepareDesired({scope,draft,capability,recheck,signal});
      if(!prepared||!['gmail','microsoft'].includes(prepared.provider)||!Number.isSafeInteger(prepared.authority_epoch)||prepared.authority_epoch<1
        ||!(prepared.mime_bytes instanceof Uint8Array)||prepared.mime_bytes.byteLength<1
        ||prepared.mime_bytes.byteLength>(prepared.provider==='gmail'?35*1024*1024:3*1024*1024)
        ||!digestSchema.safeParse(prepared.mime_digest).success||hash(prepared.mime_bytes)!==prepared.mime_digest)throw retry();
      let previous:EmailProviderDraftMirrorPrivateState|null=claim.provider_state?providerState(scope,claim.provider_state):null;
      if(previous&&previous.provider!==prepared.provider){await finish('conflict',previous,'EMAIL_DRAFT_PROVIDER_CHANGED');return Object.freeze({state:'conflict',revision:desiredRevision});}
      if(reconcile){
        const recovery=previous?.recovery;
        if(!previous||!recovery||previous.provider!=='microsoft'||recovery.desired_revision!==claim.desired_revision
          ||recovery.desired_digest!==prepared.mime_digest||recovery.provider_draft_ref!==previous.provider_draft_ref
          ||recovery.baseline_digest!==previous.baseline_digest||recovery.provider_version!==previous.provider_version){
          await finish('unknown',previous??undefined,'EMAIL_DRAFT_SYNC_RECONSTRUCTION_MISMATCH');
          return Object.freeze({state:'unknown',revision:claim.desired_revision});
        }
        requestEffect={operation:'update',provider_draft_ref:recovery.provider_draft_ref,baseline_digest:recovery.baseline_digest,desired_digest:recovery.desired_digest};
        recoveryState=previous;
        const updated=await invoke({operation:'update',operation_id:recovery.operation_id,provider_draft_ref:recovery.provider_draft_ref,
          baseline_digest:recovery.baseline_digest,provider_version:recovery.provider_version,
          desired:{mime_bytes:prepared.mime_bytes,mime_digest:recovery.desired_digest}});
        if(updated.outcome==='updated'){
          const state=await finish('synced',stateFromResult(scope,updated));return Object.freeze({state,revision:claim.desired_revision});
        }
        if(updated.outcome==='unknown'){
          await finish('unknown',previous,'EMAIL_DRAFT_SYNC_UNKNOWN');return Object.freeze({state:'unknown',revision:claim.desired_revision});
        }
        await finish(updated.outcome==='unsupported'?'unsupported':'conflict',previous,'EMAIL_DRAFT_SYNC_CONFLICT');
        return Object.freeze({state:updated.outcome==='unsupported'?'unsupported':'conflict',revision:claim.desired_revision});
      }
      if(!previous){
        requestEffect={operation:'create',provider_draft_ref:null,baseline_digest:null,desired_digest:prepared.mime_digest};
        const result=await invoke({operation:'create',operation_id:claim.operation_id,desired:{mime_bytes:prepared.mime_bytes,mime_digest:prepared.mime_digest}});
        if(result.outcome==='created'){
          const saved=stateFromResult(scope,result),state=await finish('synced',saved);
          return Object.freeze({state,revision:desiredRevision});
        }
        const state=result.outcome==='unknown'?'unknown':result.outcome==='unsupported'?'unsupported':'conflict';
        await finish(state,knownStateFromResult(scope,result),state==='unknown'?'EMAIL_DRAFT_SYNC_UNKNOWN':state==='unsupported'?'EMAIL_DRAFT_SYNC_UNSUPPORTED':'EMAIL_DRAFT_SYNC_CONFLICT');
        return Object.freeze({state,revision:desiredRevision});
      }

      const inspected=await invoke({operation:'inspect',operation_id:randomUUID(),provider_draft_ref:previous.provider_draft_ref});
      if(inspected.outcome!=='present'){
        const state=inspected.outcome==='unknown'?'unknown':inspected.outcome==='unsupported'?'unsupported':'conflict';
        await finish(state,previous,state==='unknown'?'EMAIL_DRAFT_SYNC_UNKNOWN':state==='unsupported'?'EMAIL_DRAFT_SYNC_UNSUPPORTED':'EMAIL_DRAFT_SYNC_CONFLICT');
        return Object.freeze({state,revision:desiredRevision});
      }
      if(inspected.provider_draft_ref!==previous.provider_draft_ref||inspected.baseline_digest!==previous.baseline_digest){
        await finish('conflict',previous,'EMAIL_DRAFT_REMOTE_CHANGED');return Object.freeze({state:'conflict',revision:desiredRevision});
      }
      const observed=stateFromResult(scope,inspected);
      if(inspected.baseline_digest===prepared.mime_digest){
        const state=await finish('synced',observed);return Object.freeze({state,revision:desiredRevision});
      }
      requestEffect={operation:'update',provider_draft_ref:previous.provider_draft_ref,baseline_digest:inspected.baseline_digest,desired_digest:prepared.mime_digest};
      if(prepared.provider==='microsoft'){
        recoveryState=Previous.parse({...previous,recovery:{operation_id:claim.operation_id,desired_revision:claim.desired_revision,
          desired_digest:prepared.mime_digest,provider_draft_ref:previous.provider_draft_ref,baseline_digest:inspected.baseline_digest,provider_version:inspected.provider_version}});
        if(!await this.mirrors.pinRecovery(scope,draftId,claim,lease.lock_token,recoveryState.recovery!,guard,signal)){finalizationLost=true;throw denied();}
      }
      const updated=await invoke({operation:'update',operation_id:claim.operation_id,provider_draft_ref:previous.provider_draft_ref,
        baseline_digest:inspected.baseline_digest,provider_version:inspected.provider_version,
        desired:{mime_bytes:prepared.mime_bytes,mime_digest:prepared.mime_digest}});
      if(updated.outcome==='updated'){
        const state=await finish('synced',stateFromResult(scope,updated));return Object.freeze({state,revision:desiredRevision});
      }
      const state=updated.outcome==='unknown'?'unknown':updated.outcome==='unsupported'?'unsupported':'conflict';
      await finish(state,state==='unknown'?(recoveryState??previous):previous,state==='unknown'?'EMAIL_DRAFT_SYNC_UNKNOWN':state==='unsupported'?'EMAIL_DRAFT_SYNC_UNSUPPORTED':'EMAIL_DRAFT_SYNC_CONFLICT');
      return Object.freeze({state,revision:desiredRevision});
    }catch(error){
      if(signal?.aborted)throw signal.reason;
      if(finalizationLost)throw denied();
      if(effectAuthorized){await finish('unknown',recoveryState,'EMAIL_DRAFT_SYNC_UNKNOWN');throw new EmailProviderDraftMirrorError('EMAIL_DRAFT_SYNC_UNAVAILABLE');}
      if(recoveryState){await finish('unknown',recoveryState,'EMAIL_DRAFT_SYNC_UNCERTAIN');throw retry();}
      await this.mirrors.releaseBeforeEffect(scope,draftId,claim,lease.lock_token,guard,signal);
      if(error instanceof EmailProviderDraftMirrorError)throw error;
      throw retry();
    }finally{prepared?.mime_bytes.fill(0);for(const bytes of readbacks)bytes.fill(0);}
  }
}

/** Human-owner metadata view for the settings UI. Provider locators, operation
 * IDs, claim tokens, digests, and diagnostic strings never leave this boundary. */
export class EmailProviderDraftMirrorStatusService {
  constructor(private readonly authority:EmailAuthority,private readonly mirrors:EmailProviderDraftMirrorStore,private readonly now=Date.now){}
  async read(actorRaw:EmailActor,orgId:string,accountId:string,draftIdRaw:string,signal?:AbortSignal):Promise<EmailProviderDraftMirrorStatus>{
    let actor:EmailActor,scope:EmailScope,draftId:string;
    try{
      actor=Object.freeze(z.strictObject({user_id:z.string().min(1).max(256),web_session_id:z.string().min(1).max(256),access_expires_at:z.number().finite()}).parse(actorRaw));
      scope=Object.freeze(Scope.parse({org_id:orgId,owner_user_id:actor.user_id,account_id:accountId}));draftId=DraftId.parse(draftIdRaw);
    }catch{throw denied();}
    const check=async(expected?:EmailCapability,transaction?:unknown)=>{
      signal?.throwIfAborted();if(actor.access_expires_at<=this.now())throw denied();
      let cap:EmailCapability;try{cap=await this.authority.current(actor,scope,'human_draft',transaction,signal);}catch(error){if(signal?.aborted)throw error;throw denied();}
      if(!sameScope(scope,cap.scope)||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now()||!cap.resource_binding_id||!cap.authority_version
        ||expected&&!sameCapability(expected,cap))throw denied();
      signal?.throwIfAborted();return cap;
    };
    const initial=await check(),guard:EmailDraftGuard=async transaction=>{await check(initial,transaction);};
    return this.mirrors.readStatus(scope,draftId,guard,signal);
  }
}
