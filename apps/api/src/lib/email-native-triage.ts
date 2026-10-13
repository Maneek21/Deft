import { EmailOperationActorSchema } from './email-agent-actor.js';
import {createHash} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import {NativeEmailTriageResultSchema,NativeEmailDestinationSchema,type NativeEmailTriageOperation,type NativeEmailTriageRequest,type NativeEmailTriageResult,type NativeEmailTriageDestination,type NativeEmailAccount} from './app-connection-contract.js';
import type {NativeEmailConnectionResolver} from './email-mailbox-provider.js';
import type {EmailOperationActor,EmailAuthority,EmailCapability,EmailScope,EmailMessageRecord} from './email-mailbox-service.js';

const Id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id});
const Actor = EmailOperationActorSchema;
const LogicalId=z.string().regex(/^mail_[a-f0-9]{64}$/u),OperationId=z.string().uuid();
const Apply=z.strictObject({operation_id:OperationId,kind:z.enum(['mark_read','mark_unread','star','unstar','archive','trash','move','labels','spam','not_spam','restore']),
  logical_message_ids:z.array(LogicalId).min(1).max(25).refine(ids=>new Set(ids).size===ids.length),destination_id:z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  label_action:z.enum(['add','remove']).optional(),destination_ids:z.array(z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/u)).min(1).max(16).refine(ids=>new Set(ids).size===ids.length).optional()})
  .refine(value=>value.kind==='labels'?value.label_action!==undefined&&value.destination_ids!==undefined&&value.destination_id===undefined
    :value.label_action===undefined&&value.destination_ids===undefined&&(value.kind==='move'?value.destination_id!==undefined:value.destination_id===undefined));
const ApplyWithReview=Apply.extend({expected_source_digests:z.record(LogicalId,z.string().regex(/^[a-f0-9]{64}$/u)).optional()})
  .refine(value=>!value.expected_source_digests||Object.keys(value.expected_source_digests).length===value.logical_message_ids.length
    &&value.logical_message_ids.every(id=>Object.hasOwn(value.expected_source_digests!,id)));
export type EmailNativeTriageApply=Readonly<z.infer<typeof ApplyWithReview>>;
export class EmailNativeTriageError extends Error{constructor(readonly code:'EMAIL_ACCESS_DENIED'|'EMAIL_MESSAGE_NOT_FOUND'|'EMAIL_TRIAGE_UNAVAILABLE'|'EMAIL_TRIAGE_DESTINATION_UNAVAILABLE'|'EMAIL_TRIAGE_OPERATION_UNSUPPORTED'){super(code);this.name='EmailNativeTriageError';}}
const denied=()=>new EmailNativeTriageError('EMAIL_ACCESS_DENIED');
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;
const sameStatus=(a:NativeEmailAccount,b:NativeEmailAccount)=>a.account_id===b.account_id&&a.provider===b.provider&&a.resource_binding_id===b.resource_binding_id
  &&a.principal_digest===b.principal_digest&&a.connection_revision===b.connection_revision&&a.authority_epoch===b.authority_epoch;
export interface EmailNativeTriageProvider{
  invoke(scope:EmailScope,input:NativeEmailTriageRequest,capability:EmailCapability,recheck:()=>Promise<void>,beforeReserve:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailTriageResult>;
}
/** Registered adapter selection, retained journal and SQL-only native context
 * are trusted resolver output. Caller input never chooses provider/custody. */
export class RegisteredEmailNativeTriageProvider implements EmailNativeTriageProvider{
  constructor(private readonly resolve:NativeEmailConnectionResolver,private readonly now=Date.now){}
  async invoke(rawScope:EmailScope,input:NativeEmailTriageRequest,capability:EmailCapability,recheck:()=>Promise<void>,beforeReserve:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailTriageResult>{
    const scope=Object.freeze(Scope.parse(rawScope));
    if(!capability?.scope||!sameScope(scope,capability.scope)||!Number.isFinite(this.now())||!Number.isFinite(capability.expires_at)
      ||!Id.safeParse(capability.resource_binding_id).success||!Id.safeParse(capability.authority_version).success||capability.expires_at<=this.now())throw denied();signal?.throwIfAborted();
    const {adapter,context}=await this.resolve(scope,capability,recheck,signal,'triage');
    if(!adapter.nativeEmailTriage||!adapter.nativeEmailAccount||!sameScope(scope,context)||context.resource_binding_id!==capability.resource_binding_id
      ||context.authority_version!==capability.authority_version||context.expires_at>capability.expires_at||context.expires_at<=this.now()
      ||!context.triage_journal||context.signal!==signal||typeof context.recheck!=='function')throw denied();
    const {triage_journal:journal,triage_before_reserve:ignored,...statusContext}=context;
    const checkStatus=(account:NativeEmailAccount)=>{signal?.throwIfAborted();if(this.now()>=context.expires_at||this.now()>=capability.expires_at
      ||account.account_id!==scope.account_id||account.resource_binding_id!==capability.resource_binding_id||account.health!=='connected'
      ||!['gmail','microsoft','imap_smtp'].includes(account.provider)||!Array.isArray(account.capabilities)||!account.capabilities.includes('modify')||!Number.isSafeInteger(account.authority_epoch)
      ||account.authority_epoch<1||!Number.isSafeInteger(account.connection_revision)||account.connection_revision<1||!/^[a-f0-9]{64}$/u.test(account.principal_digest))throw denied();};
    await recheck();const before=await adapter.nativeEmailAccount(statusContext);checkStatus(before);
    if(input.mode==='apply'&&input.operation.kind==='labels'&&before.provider!=='gmail')throw denied();
    if(input.mode==='apply'&&['spam','not_spam','restore'].includes(input.operation.kind)&&!['gmail','microsoft'].includes(before.provider))throw new EmailNativeTriageError('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');
    const request=input.mode==='apply'?{...input,sources:input.sources.map(source=>{
      if(source.account_id!==scope.account_id||source.provider!==before.provider||source.schema_version!=='deft.email_provider_source.v1'
        ||!LogicalId.safeParse(source.logical_message_id).success)throw denied();return {...structuredClone(source),authority_epoch:before.authority_epoch};})}:input;
    let result:NativeEmailTriageResult;
    try{result=await adapter.nativeEmailTriage(request,{...context,triage_before_reserve:beforeReserve});}catch(error){
      await recheck();checkStatus(await adapter.nativeEmailAccount(statusContext));throw error;
    }
    await recheck();const after=await adapter.nativeEmailAccount(statusContext);checkStatus(after);
    const parsed=NativeEmailTriageResultSchema.parse(result),expectedOperationId=input.mode==='undo'?input.undo_operation_id:input.operation_id;
    if(!sameStatus(before,after)||parsed.account_id!==scope.account_id||parsed.operation_id!==expectedOperationId||before.provider!=='gmail'&&parsed.items.some(item=>item.confirmed_folders!==undefined)
      ||input.mode==='apply'&&(parsed.operation!==input.operation.kind||parsed.items.length!==input.sources.length
        ||parsed.items.some(item=>!input.sources.some(source=>source.logical_message_id===item.logical_message_id))))throw denied();
    if(before.provider==='imap_smtp'){
      if(!context.imap_aliases?.reconcile)throw denied();
      await context.imap_aliases.reconcile(expectedOperationId);await recheck();checkStatus(await adapter.nativeEmailAccount(statusContext));
    }
    return parsed;
  }
}
export type EmailNativeTriageStore=Readonly<{
  readMessage(scope:EmailScope,logicalId:string,signal?:AbortSignal):Promise<EmailMessageRecord|null>;
  readAcknowledgementRevision?(scope:EmailScope,guard:(transaction:unknown)=>Promise<void>,signal?:AbortSignal):Promise<number|null>;
  readAcknowledgementVersions?(scope:EmailScope,logicalIds:readonly string[],guard:(transaction:unknown)=>Promise<void>,signal?:AbortSignal):Promise<readonly Readonly<{logical_message_id:string;storage_revision:number}>[]>;
  acknowledgeFlags?(scope:EmailScope,updates:readonly Readonly<{logical_message_id:string;expected_revision:string;expected_source_digest:string;
    flags:Readonly<{seen:boolean|null;flagged:boolean|null;answered:boolean|null}>;folders?:readonly string[];expected_checkpoint_revision?:number;expected_storage_revision?:number}>[],guard:(transaction:unknown)=>Promise<void>,signal?:AbortSignal):Promise<{acknowledged:number;stale:number}>;
}>;
export type EmailNativeTriageDestinationResolver=(scope:EmailScope,handle:string,capability:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal)=>Promise<NativeEmailTriageDestination>;
export const emailNativeTriageSourceFingerprint=(record:EmailMessageRecord)=>createHash('sha256').update(canonicalCapabilityJson([record.account_id,record.logical_message_id,record.revision,record.provider_source])).digest('hex');
const fingerprint=emailNativeTriageSourceFingerprint;
// Human effects target the immutable message within its current account epoch.
// Mutable Gmail labels and Graph parent folders are account-wide query state;
// exact reviewed snapshots remain separate ACK/agent fences.
const effectIdentity=(record:EmailMessageRecord)=>{
  const source=structuredClone(record.provider_source),locator=source.locator;
  if(locator&&typeof locator==='object'&&!Array.isArray(locator)){
    if(source.provider==='gmail'&&locator.kind==='gmail')delete locator.label_ids;
    if(source.provider==='microsoft'&&locator.kind==='microsoft'&&locator.id_type==='immutable')delete locator.folder_id;
  }
  return createHash('sha256').update(canonicalCapabilityJson([record.account_id,record.logical_message_id,source])).digest('hex');
};

/** Deliberate owner mutation only. human_modify is rederived at each boundary;
 * read/draft/Send or an agent grant never substitutes for this authority. */
export class EmailNativeTriageService{
  constructor(private readonly authority:EmailAuthority,private readonly store:EmailNativeTriageStore,private readonly provider:EmailNativeTriageProvider,
    private readonly resolveDestination?:EmailNativeTriageDestinationResolver,private readonly now=Date.now){}
  private async current(actor:EmailOperationActor,scope:EmailScope,expected?:EmailCapability,signal?:AbortSignal){
    signal?.throwIfAborted();if(!Number.isFinite(this.now())||actor.access_expires_at<=this.now())throw denied();let cap:EmailCapability;
    try{cap=structuredClone(await this.authority.current(actor,scope,'human_modify',undefined,signal));}catch(error){if(signal?.aborted)throw error;throw denied();}
    signal?.throwIfAborted();if(!Scope.safeParse(cap.scope).success||!sameScope(scope,cap.scope)||!Id.safeParse(cap.resource_binding_id).success
      ||!Id.safeParse(cap.authority_version).success||!Number.isFinite(this.now())||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now()
      ||expected&&(cap.resource_binding_id!==expected.resource_binding_id||cap.authority_version!==expected.authority_version))throw denied();return Object.freeze(cap);
  }
  private identity(actor:EmailOperationActor,scope:EmailScope){const owner=Object.freeze(Actor.parse(actor)),account=Object.freeze(Scope.parse(scope));if(owner.user_id!==account.owner_user_id)throw denied();return {actor:owner,scope:account};}
  private async records(actor:EmailOperationActor,scope:EmailScope,ids:readonly string[],capability:EmailCapability,signal?:AbortSignal){
    const records:EmailMessageRecord[]=[];for(const id of ids){const record=await this.store.readMessage(scope,id,signal);await this.current(actor,scope,capability,signal);
      if(!record)throw new EmailNativeTriageError('EMAIL_MESSAGE_NOT_FOUND');
      if(record.account_id!==scope.account_id||record.logical_message_id!==id||record.provider_source.account_id!==scope.account_id
        ||record.provider_source.logical_message_id!==id||record.provider_source.schema_version!=='deft.email_provider_source.v1')throw denied();records.push(structuredClone(record));}
    return records;
  }
  private async acknowledgementPin(actor:EmailOperationActor,scope:EmailScope,capability:EmailCapability,ids:readonly string[],signal?:AbortSignal):Promise<{checkpointRevision?:number|null;versions?:ReadonlyMap<string,number>}>{
    const guard=async(transaction:unknown)=>{
      signal?.throwIfAborted();const live=await this.authority.current(actor,scope,'human_modify',transaction,signal);
      if(!sameScope(scope,live.scope)||live.authority_version!==capability.authority_version||live.resource_binding_id!==capability.resource_binding_id
        ||!Number.isFinite(live.expires_at)||live.expires_at<=this.now())throw denied();
    };
    if(this.store.readAcknowledgementVersions){
      const rows=z.array(z.strictObject({logical_message_id:LogicalId,storage_revision:z.number().int().min(1).max(2147483647)})).max(25)
        .parse(await this.store.readAcknowledgementVersions(scope,ids,guard,signal));
      if(new Set(rows.map(row=>row.logical_message_id)).size!==rows.length||rows.some(row=>!ids.includes(row.logical_message_id)))throw denied();
      await this.current(actor,scope,capability,signal);return {versions:new Map(rows.map(row=>[row.logical_message_id,row.storage_revision]))};
    }
    if(!this.store.readAcknowledgementRevision)return {};
    const revision=await this.store.readAcknowledgementRevision(scope,guard,signal);
    await this.current(actor,scope,capability,signal);return {checkpointRevision:revision===null?null:z.number().int().min(0).max(2147483647).parse(revision)};
  }
  private async execute(actor:EmailOperationActor,scope:EmailScope,request:NativeEmailTriageRequest,capability:EmailCapability,records:readonly EmailMessageRecord[],signal?:AbortSignal,pin:{checkpointRevision?:number|null;versions?:ReadonlyMap<string,number>}={},exactReview=false){
    const identity='agent_grant_id' in actor||exactReview?fingerprint:effectIdentity;
    const expected=new Map(records.map(record=>[record.logical_message_id,identity(record)])),recheck=async()=>{await this.current(actor,scope,capability,signal);};
    let ackRecords=records,ackPin=pin,reservationReviewed=false;
    const beforeReserve=async()=>{await recheck();
      // Pin before the existing fresh reads. Refresh once, before any effect;
      // re-pinning previously effected bulk rows could authorize stale receipts.
      const refreshed=!reservationReviewed?await this.acknowledgementPin(actor,scope,capability,[...expected.keys()],signal):undefined;
      const fresh=await this.records(actor,scope,[...expected.keys()],capability,signal);
      if(fresh.some(record=>identity(record)!==expected.get(record.logical_message_id)))throw denied();await recheck();
      if(!reservationReviewed){ackRecords=fresh;ackPin=refreshed!;reservationReviewed=true;}
    };
    const result=NativeEmailTriageResultSchema.parse(await this.provider.invoke(scope,request,capability,recheck,beforeReserve,signal));await recheck();
    const {checkpointRevision,versions}=ackPin;
    if(request.mode!=='status'&&ackRecords.length&&this.store.acknowledgeFlags&&checkpointRevision!==null){
      const byId=new Map(ackRecords.map(record=>[record.logical_message_id,record]));
      const updates=result.items.flatMap(item=>{
        const record=byId.get(item.logical_message_id),flags=item.state==='succeeded'?item.confirmed_flags:undefined,storageRevision=versions?.get(item.logical_message_id),folders=item.state==='succeeded'&&(checkpointRevision!==undefined||storageRevision!==undefined)?item.confirmed_folders:undefined;
        if(!record||versions&&storageRevision===undefined||!folders&&(!flags||flags.seen===null&&flags.flagged===null&&flags.answered===null))return [];
        if(folders&&record.provider_source.provider!=='gmail')throw denied();
        return [{logical_message_id:item.logical_message_id,expected_revision:record.revision,expected_source_digest:fingerprint(record),flags:flags??{seen:null,flagged:null,answered:null},...(folders?{folders}:{}),...(checkpointRevision===undefined?{}:{expected_checkpoint_revision:checkpointRevision}),...(storageRevision===undefined?{}:{expected_storage_revision:storageRevision})}];
      });
      if(updates.length)await this.store.acknowledgeFlags(scope,updates,async transaction=>{
        signal?.throwIfAborted();const live=structuredClone(await this.authority.current(actor,scope,'human_modify',transaction,signal));
        if(!sameScope(scope,live.scope)||live.authority_version!==capability.authority_version||live.resource_binding_id!==capability.resource_binding_id
          ||!Number.isFinite(live.expires_at)||live.expires_at<=this.now())throw denied();
      },signal);
      await recheck();
    }
    // Only this request's freshly reserved human effect may nominate folders.
    // Retained status/replay and agent receipts remain recovery-only evidence.
    const publicFolders=request.mode!=='status'&&reservationReviewed&&!('agent_grant_id' in actor);
    return {...result,items:result.items.map(({confirmed_flags:_confirmed,confirmed_folders:folders,...item})=>({...item,
      ...(publicFolders&&item.state==='succeeded'&&folders?{confirmed_folders:[...folders]}:{})}))};
  }
  async apply(rawActor:EmailOperationActor,rawScope:EmailScope,rawInput:EmailNativeTriageApply,signal?:AbortSignal){
    const {actor,scope}=this.identity(rawActor,rawScope),input=ApplyWithReview.parse(rawInput),cap=await this.current(actor,scope,undefined,signal);
    const pin=await this.acknowledgementPin(actor,scope,cap,input.logical_message_ids,signal);
    const records=await this.records(actor,scope,input.logical_message_ids,cap,signal);
    if(input.expected_source_digests&&records.some(record=>input.expected_source_digests?.[record.logical_message_id]!==fingerprint(record)))throw denied();
    if(['spam','not_spam','restore'].includes(input.kind)&&records.some(record=>record.provider_source.provider!=='gmail'&&record.provider_source.provider!=='microsoft'))throw new EmailNativeTriageError('EMAIL_TRIAGE_OPERATION_UNSUPPORTED');
    let operation:NativeEmailTriageOperation;
    if(input.kind==='labels'){
      if(records.some(record=>record.provider_source.provider!=='gmail'))throw denied();
      if(!this.resolveDestination)throw new EmailNativeTriageError('EMAIL_TRIAGE_DESTINATION_UNAVAILABLE');
      const destinations:NativeEmailTriageDestination[]=[],ids=new Set<string>();
      for(const token of input.destination_ids!){
        const destination=NativeEmailDestinationSchema.parse(await this.resolveDestination(scope,token,cap,async()=>{await this.current(actor,scope,cap,signal);},signal));
        await this.current(actor,scope,cap,signal);
        if(destination.account_id!==scope.account_id||destination.provider!=='gmail'||destination.kind!=='label'||ids.has(destination.id))throw denied();
        ids.add(destination.id);destinations.push(destination);
      }
      operation={kind:'labels',label_action:input.label_action!,destinations};
    }else{
      operation={kind:input.kind};
      if(input.kind==='move'){
        if(!this.resolveDestination)throw new EmailNativeTriageError('EMAIL_TRIAGE_DESTINATION_UNAVAILABLE');
        const destination=await this.resolveDestination(scope,input.destination_id!,cap,async()=>{await this.current(actor,scope,cap,signal);},signal);
        await this.current(actor,scope,cap,signal);if(destination.account_id!==scope.account_id)throw denied();operation={kind:'move',destination};
      }
    }
    return this.execute(actor,scope,{mode:'apply',operation_id:input.operation_id,operation,sources:records.map(record=>record.provider_source)},cap,records,signal,pin,input.expected_source_digests!==undefined);
  }
  async status(rawActor:EmailOperationActor,rawScope:EmailScope,operationId:string,signal?:AbortSignal){
    const {actor,scope}=this.identity(rawActor,rawScope),id=OperationId.parse(operationId),cap=await this.current(actor,scope,undefined,signal);
    return this.execute(actor,scope,{mode:'status',operation_id:id},cap,[],signal);
  }
  async undo(rawActor:EmailOperationActor,rawScope:EmailScope,operationId:string,undoOperationId:string,signal?:AbortSignal){
    const {actor,scope}=this.identity(rawActor,rawScope),id=OperationId.parse(operationId),undoId=OperationId.parse(undoOperationId),cap=await this.current(actor,scope,undefined,signal);
    const original=await this.execute(actor,scope,{mode:'status',operation_id:id},cap,[],signal),ids=original.items.filter(item=>item.state==='succeeded'&&item.undo_supported).map(item=>item.logical_message_id);
    if(!ids.length)throw new EmailNativeTriageError('EMAIL_TRIAGE_UNAVAILABLE');const pin=await this.acknowledgementPin(actor,scope,cap,ids,signal);const records=await this.records(actor,scope,ids,cap,signal);
    return this.execute(actor,scope,{mode:'undo',operation_id:id,undo_operation_id:undoId},cap,records,signal,pin);
  }
}
