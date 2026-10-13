import { EmailOperationActorSchema } from './email-agent-actor.js';
import { createHash } from 'node:crypto';
import { canonicalCapabilityJson } from '@deft/shared';
import { z } from 'zod';
import {NativeEmailIncomingLimits,NativeEmailPresentationSchema,NativeEmailFileSchema,NativeEmailImageSchema,NativeEmailDigestSchema,NativeEmailCalendarPartsSchema,
  type NativeEmailSource,type NativeEmailPresentation,type NativeEmailFile,type NativeEmailImage,type NativeEmailCalendarParts} from './app-connection-contract.js';
import type { EmailOperationActor, EmailAuthority, EmailCapability, EmailMessageRecord, EmailScope } from './email-mailbox-service.js';
import {EmailIncomingReadBusyError} from './email-incoming-read-budget.js';

const Identifier = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope = z.strictObject({ org_id: Identifier, owner_user_id: Identifier, account_id: Identifier });
const Actor = EmailOperationActorSchema;
const LogicalId = z.string().regex(/^mail_[a-f0-9]{64}$/u);
const PrivateSource = z.record(z.string(), z.json()).refine(value => value.schema_version === 'deft.email_provider_source.v1'
  && value.account_id !== undefined && value.logical_message_id !== undefined
  && value.provider !== undefined);
const MAX_SOURCE_BYTES = NativeEmailIncomingLimits.source_bytes;

export type EmailMessageSource = NativeEmailSource;
export type EmailMessageContentResult = Readonly<{ account_id: string; logical_message_id: string; media_type: 'message/rfc822';
  byte_length: number; digest: string; mime_bytes: Uint8Array }>;
export class EmailMessageContentError extends Error {
  constructor(readonly code: 'EMAIL_ACCESS_DENIED' | 'EMAIL_MESSAGE_NOT_FOUND' | 'EMAIL_SOURCE_UNAVAILABLE' | 'EMAIL_SOURCE_BUSY') {
    super(code); this.name = 'EmailMessageContentError';
  }
}
const denied = () => new EmailMessageContentError('EMAIL_ACCESS_DENIED');
const sameScope = (left: EmailScope, right: EmailScope) => left.org_id === right.org_id
  && left.owner_user_id === right.owner_user_id && left.account_id === right.account_id;
const sourceFingerprint = (record: EmailMessageRecord) => createHash('sha256')
  .update(canonicalCapabilityJson([record.account_id, record.logical_message_id, record.revision, record.provider_source])).digest('hex');

export type EmailMessageContentStore = Readonly<{ readMessage(scope: EmailScope, logicalId: string, signal?: AbortSignal): Promise<EmailMessageRecord | null> }>;
export type EmailPresentationCache=Readonly<{
 read(scope:EmailScope,key:string,signal?:AbortSignal):Promise<NativeEmailPresentation|null>;
 write(scope:EmailScope,key:string,value:NativeEmailPresentation,signal?:AbortSignal):Promise<void>;
}>;
export type EmailMessageContentProvider = Readonly<{ readSource(scope: EmailScope,
  request: { source: Readonly<Record<string, unknown>> }, capability: EmailCapability, recheck: () => Promise<void>,
  signal?: AbortSignal): Promise<EmailMessageSource>;
  readCalendarParts?(scope:EmailScope,request:{source:Readonly<Record<string,unknown>>},capability:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailCalendarParts>;
  readPresentation?(scope:EmailScope,request:{source:Readonly<Record<string,unknown>>},capability:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailPresentation>;
  readFile?(scope:EmailScope,request:{source:Readonly<Record<string,unknown>>;source_digest:string;file_ref:string},capability:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailFile>;
  readImage?(scope:EmailScope,request:{source:Readonly<Record<string,unknown>>;source_digest:string;image_ref:string},capability:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailImage> }>;

/** Owner-authorized private source retrieval. No AI grant, Experience projection,
 * or provider locator is created here; bytes are returned only after both fresh
 * human authority and the encrypted cached-source fingerprint still agree. */
export class EmailMessageContentService {
  constructor(private readonly authority: EmailAuthority, private readonly store: EmailMessageContentStore,
    private readonly provider: EmailMessageContentProvider, private readonly now = Date.now,
    private readonly presentationCache?:EmailPresentationCache) {}

  private async current(actor: EmailOperationActor, scope: EmailScope, expected?: EmailCapability, signal?: AbortSignal): Promise<EmailCapability> {
    signal?.throwIfAborted();
    const before = this.now();
    if (!Number.isFinite(before) || actor.access_expires_at <= before) throw denied();
    let capability: EmailCapability;
    try { capability = structuredClone(await this.authority.current(actor, scope, 'human_read', undefined, signal)); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    signal?.throwIfAborted();
    const after = this.now();
    if (!Number.isFinite(after) || !Number.isFinite(capability.expires_at) || capability.expires_at <= after
      || !Scope.safeParse(capability.scope).success || !sameScope(scope, capability.scope)
      || !Identifier.safeParse(capability.resource_binding_id).success || !Identifier.safeParse(capability.authority_version).success
      || expected && (capability.authority_version !== expected.authority_version
        || capability.resource_binding_id !== expected.resource_binding_id)) throw denied();
    return capability;
  }

  readPresentation(actor:EmailOperationActor,scope:EmailScope,logicalId:string,signal?:AbortSignal):Promise<NativeEmailPresentation>{
    return this.readContent(actor,scope,logicalId,async(record,capability,recheck,heldScope)=>{
      if(!this.provider.readPresentation)throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
      const cache=record.folders.includes('drafts')?undefined:this.presentationCache;
      const key=createHash('sha256').update(canonicalCapabilityJson(['email-presentation-v1',heldScope,sourceFingerprint(record),capability.authority_version])).digest('hex');
      const retained=await cache?.read(heldScope,key,signal);
      if(retained)return NativeEmailPresentationSchema.parse(retained);
      const value=NativeEmailPresentationSchema.parse(await this.provider.readPresentation(heldScope,{source:record.provider_source},capability,recheck,signal));
      await recheck();
      if(value.account_id!==heldScope.account_id||value.logical_message_id!==record.logical_message_id||value.provider!==record.provider_source.provider)
        throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
      await cache?.write(heldScope,key,value,signal);
      return value;
    },value=>NativeEmailPresentationSchema.parse(value),signal);
  }

  readCalendarParts(actor:EmailOperationActor,scope:EmailScope,logicalId:string,signal?:AbortSignal):Promise<NativeEmailCalendarParts>{
    return this.readContent(actor,scope,logicalId,async(record,capability,recheck,heldScope)=>{
      if(!this.provider.readCalendarParts)throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
      return this.provider.readCalendarParts(heldScope,{source:record.provider_source},capability,recheck,signal);
    },value=>NativeEmailCalendarPartsSchema.parse(value),signal);
  }

  async readFile(actor:EmailOperationActor,scope:EmailScope,logicalId:string,rawInput:Readonly<{source_digest:string;file_ref:string}>,signal?:AbortSignal):Promise<NativeEmailFile>{
    const input=z.strictObject({source_digest:NativeEmailDigestSchema,file_ref:NativeEmailDigestSchema}).parse(rawInput);
    return this.readContent(actor,scope,logicalId,async(record,capability,recheck,heldScope)=>{
      if(!this.provider.readFile)throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
      return this.provider.readFile(heldScope,{...input,source:record.provider_source},capability,recheck,signal);
    },value=>{const result=NativeEmailFileSchema.parse(value);if(result.source_digest!==input.source_digest||result.file_ref!==input.file_ref)throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');return result;},signal);
  }

  async readImage(actor:EmailOperationActor,scope:EmailScope,logicalId:string,rawInput:Readonly<{source_digest:string;image_ref:string}>,signal?:AbortSignal):Promise<NativeEmailImage>{
    const input=z.strictObject({source_digest:NativeEmailDigestSchema,image_ref:NativeEmailDigestSchema}).parse(rawInput);
    return this.readContent(actor,scope,logicalId,async(record,capability,recheck,heldScope)=>{
      if(!this.provider.readImage)throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
      return this.provider.readImage(heldScope,{...input,source:record.provider_source},capability,recheck,signal);
    },value=>{const result=NativeEmailImageSchema.parse(value);if(result.source_digest!==input.source_digest||result.image_ref!==input.image_ref)throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');return result;},signal);
  }

  private async readContent<T extends NativeEmailPresentation|NativeEmailFile|NativeEmailImage|NativeEmailCalendarParts>(rawActor:EmailOperationActor,rawScope:EmailScope,rawLogicalId:string,
    read:(record:EmailMessageRecord,capability:EmailCapability,recheck:()=>Promise<void>,scope:EmailScope)=>Promise<T>,validate:(value:unknown)=>T,signal?:AbortSignal):Promise<T>{
    const actor=Object.freeze(Actor.parse(rawActor)),scope=Object.freeze(Scope.parse(rawScope)),logicalId=LogicalId.parse(rawLogicalId);
    if(actor.user_id!==scope.owner_user_id)throw denied();
    let result:T|undefined;
    try{
      const capability=await this.current(actor,scope,undefined,signal),record=await this.store.readMessage(scope,logicalId,signal);
      await this.current(actor,scope,capability,signal);
      if(!record)throw new EmailMessageContentError('EMAIL_MESSAGE_NOT_FOUND');
      const privateSource=PrivateSource.safeParse(record.provider_source);
      if(record.account_id!==scope.account_id||record.logical_message_id!==logicalId||!privateSource.success
        ||privateSource.data.account_id!==scope.account_id||privateSource.data.logical_message_id!==logicalId
        ||!['gmail','microsoft','imap_smtp'].includes(String(privateSource.data.provider)))throw denied();
      const fingerprint=sourceFingerprint(record),recheck=async()=>{await this.current(actor,scope,capability,signal);};
      result=await read(record,capability,recheck,scope);
      await recheck();const currentRecord=await this.store.readMessage(scope,logicalId,signal);await recheck();
      if(!currentRecord||currentRecord.account_id!==scope.account_id||currentRecord.logical_message_id!==logicalId
        ||sourceFingerprint(currentRecord)!==fingerprint)throw denied();
      const parsed=validate(result);
      if(parsed.account_id!==scope.account_id||parsed.logical_message_id!==logicalId||parsed.provider!==privateSource.data.provider
        ||'presentation'in parsed&&parsed.presentation.metadata.account_id!==scope.account_id)throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
      signal?.throwIfAborted();return Object.freeze(parsed);
    }catch(error){
      if(result&&typeof result==='object'&&'bytes'in result&&result.bytes instanceof Uint8Array)result.bytes.fill(0);
      if(signal?.aborted)throw error;
      if(error instanceof EmailMessageContentError)throw error;
      if(error instanceof EmailIncomingReadBusyError)throw new EmailMessageContentError('EMAIL_SOURCE_BUSY');
      throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
    }
  }

  async readSource(rawActor: EmailOperationActor, rawScope: EmailScope, rawLogicalId: string, signal?: AbortSignal): Promise<EmailMessageContentResult> {
    const actor = Object.freeze(Actor.parse(rawActor)), scope = Object.freeze(Scope.parse(rawScope)), logicalId = LogicalId.parse(rawLogicalId);
    if (actor.user_id !== scope.owner_user_id) throw denied();
    let bytes: Uint8Array | undefined;
    try {
      const capability = await this.current(actor, scope, undefined, signal);
      const record = await this.store.readMessage(scope, logicalId, signal);
      await this.current(actor, scope, capability, signal);
      if (!record) throw new EmailMessageContentError('EMAIL_MESSAGE_NOT_FOUND');
      if (record.account_id !== scope.account_id || record.logical_message_id !== logicalId) throw denied();
      const privateSource = PrivateSource.safeParse(record.provider_source);
      if (!privateSource.success || privateSource.data.account_id !== scope.account_id
        || privateSource.data.logical_message_id !== logicalId
        || !['gmail', 'microsoft', 'imap_smtp'].includes(String(privateSource.data.provider))) throw denied();
      const fingerprint = sourceFingerprint(record);
      const recheck = async () => { await this.current(actor, scope, capability, signal); };
      const source = await this.provider.readSource(scope, { source: record.provider_source }, capability, recheck, signal);
      if (source?.mime_bytes instanceof Uint8Array) bytes = source.mime_bytes;
      await recheck();
      const currentRecord = await this.store.readMessage(scope, logicalId, signal);
      await recheck();
      if (!currentRecord || currentRecord.account_id !== scope.account_id || currentRecord.logical_message_id !== logicalId
        || sourceFingerprint(currentRecord) !== fingerprint) throw denied();
      if (source.schema_version !== 'deft.email_source.v1' || source.account_id !== scope.account_id
        || source.provider !== privateSource.data.provider
        || !['gmail', 'microsoft', 'imap_smtp'].includes(source.provider) || source.source_kind !== 'provider_original'
        || source.media_type !== 'message/rfc822' || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_SOURCE_BYTES
        || source.byte_length !== bytes.byteLength || !/^[a-f0-9]{64}$/u.test(source.digest)
        || createHash('sha256').update(bytes).digest('hex') !== source.digest) throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
      signal?.throwIfAborted();
      return Object.freeze({ account_id: scope.account_id, logical_message_id: logicalId, media_type: source.media_type,
        byte_length: bytes.byteLength, digest: source.digest, mime_bytes: bytes });
    } catch (error) {
      if (bytes instanceof Uint8Array) bytes.fill(0);
      if (signal?.aborted) throw error;
      if (error instanceof EmailMessageContentError) throw error;
      if (error instanceof EmailIncomingReadBusyError) throw new EmailMessageContentError('EMAIL_SOURCE_BUSY');
      throw new EmailMessageContentError('EMAIL_SOURCE_UNAVAILABLE');
    }
  }
}
