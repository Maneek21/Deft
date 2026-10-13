import { EmailOperationActorSchema } from './email-agent-actor.js';
import {createHash} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import {NativeEmailConversationPageSchema,type NativeEmailConversationPage} from './app-connection-contract.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailMailboxError,validateEmailMessageRecords,type EmailOperationActor,type EmailScope,type EmailCapability,type EmailAuthority,type EmailMessageRecord} from './email-mailbox-service.js';
import type {EmailMailboxSearchStore} from './email-mailbox-search.js';
const Id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Logical=z.string().regex(/^mail_[a-f0-9]{64}$/u),Scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id});
const Actor = EmailOperationActorSchema;
const Request=z.strictObject({logical_message_id:Logical,cursor:z.string().min(1).max(256*1024).nullable(),limit:z.number().int().min(1).max(100)});
const Cursor=z.strictObject({version:z.literal(1),anchor:Logical,fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),limit:z.number().int().min(1).max(100),provider:z.enum(['gmail','microsoft','imap_smtp']),
  resource_binding_id:Id,authority_version:Id,continuation:z.string().min(1).max(8192),expires_at:z.number().finite(),failures:z.number().int().min(0).max(100000)});
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;
const denied=()=>new EmailMailboxError('EMAIL_ACCESS_DENIED');
export class EmailConversationError extends Error{constructor(readonly code:'EMAIL_CONVERSATION_MESSAGE_NOT_FOUND'|'EMAIL_CONVERSATION_CURSOR_INVALID'|'EMAIL_CONVERSATION_UNAVAILABLE'|'EMAIL_CONVERSATION_SOURCE_CHANGED'){super(code);this.name='EmailConversationError';}}
export interface EmailMailboxConversationProvider{
  readConversation(scope:EmailScope,input:{source:Readonly<Record<string,unknown>>;cursor:string|null;limit:number},cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailConversationPage>;
}
export type EmailMailboxConversationStore=EmailMailboxSearchStore&Readonly<{readMessage(scope:EmailScope,id:string,signal?:AbortSignal):Promise<EmailMessageRecord|null>}>;
const anchorFingerprint=(row:EmailMessageRecord)=>{
  const source=row.provider_source,locator=source.locator as Record<string,unknown>|undefined;
  // Flags/folder membership can change during background sync without changing
  // the nominated immutable message and provider conversation.
  return createHash('sha256').update(canonicalCapabilityJson([row.account_id,row.logical_message_id,source.provider,source.conversation_id,
    locator?.kind??null,locator?.message_id??null,locator?.thread_id??null,locator?.conversation_id??null,locator?.id_type??null,locator?.mailbox??null,locator?.uidvalidity??null,locator?.uid??null])).digest('hex');
};
const visible=(row:EmailMessageRecord)=>{const {logical_message_id,revision,received_at,folders,flags,data}=row;return {logical_message_id,revision,received_at,folders:[...folders],flags:{...flags},data:{...data}};};
export type EmailMailboxConversationResult=Readonly<{account_id:string;anchor_logical_message_id:string;items:readonly ReturnType<typeof visible>[];next_cursor:string|null;
  has_more:boolean;observed_at:string;source:'provider';consistency:'weak';complete:boolean;coverage:'complete'|'partial';failure_count:number;count:Readonly<{returned:number;exact_total:null}>;thread_basis?:'message_headers';limitations?:readonly string[]}>;
export class EmailMailboxConversationService{
  constructor(private readonly authority:EmailAuthority,private readonly store:EmailMailboxConversationStore,private readonly provider:EmailMailboxConversationProvider,private readonly crypto:EmailMailboxCrypto,private readonly now=Date.now){}
  private async current(actor:EmailOperationActor,scope:EmailScope,expected?:EmailCapability,transaction?:unknown,signal?:AbortSignal){
    signal?.throwIfAborted();if(!Number.isFinite(this.now())||actor.access_expires_at<=this.now())throw denied();let cap:EmailCapability;
    try{cap=structuredClone(await this.authority.current(actor,scope,'human_read',transaction,signal));}catch(error){if(signal?.aborted)throw error;throw denied();}
    signal?.throwIfAborted();if(!Scope.safeParse(cap.scope).success||!sameScope(scope,cap.scope)||!Id.safeParse(cap.resource_binding_id).success||!Id.safeParse(cap.authority_version).success
      ||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now()||expected&&(cap.resource_binding_id!==expected.resource_binding_id||cap.authority_version!==expected.authority_version))throw denied();return cap;
  }
  private async anchor(actor:EmailOperationActor,scope:EmailScope,id:string,cap:EmailCapability,signal?:AbortSignal){
    const row=await this.store.readMessage(scope,id,signal);await this.current(actor,scope,cap,undefined,signal);if(!row)throw new EmailConversationError('EMAIL_CONVERSATION_MESSAGE_NOT_FOUND');
    const validated=validateEmailMessageRecords(scope,[row],1)[0]!;if(validated.logical_message_id!==id||validated.provider_source.account_id!==scope.account_id
      ||validated.provider_source.logical_message_id!==id||!['gmail','microsoft','imap_smtp'].includes(String(validated.provider_source.provider)))throw denied();return validated;
  }
  async read(rawActor:EmailOperationActor,rawScope:EmailScope,rawInput:z.infer<typeof Request>,signal?:AbortSignal):Promise<EmailMailboxConversationResult>{
    const actor=Object.freeze(Actor.parse(rawActor)),scope=Object.freeze(Scope.parse(rawScope)),input=Request.parse(rawInput);if(actor.user_id!==scope.owner_user_id)throw denied();
    const cap=await this.current(actor,scope,undefined,undefined,signal),anchor=await this.anchor(actor,scope,input.logical_message_id,cap,signal),fingerprint=anchorFingerprint(anchor);
    const context={...scope,kind:'checkpoint' as const,record_id:'conversation:'+input.logical_message_id,revision:1};let continuation:string|null=null,failures=0,provider:string|null=null;
    if(input.cursor!==null)try{
      if(!/^[A-Za-z0-9_-]+$/u.test(input.cursor))throw Error();const bytes=Buffer.from(input.cursor,'base64url');if(bytes.toString('base64url')!==input.cursor||bytes.length>256*1024)throw Error();
      const cursor=Cursor.parse(this.crypto.open(JSON.parse(bytes.toString('utf8')),context));if(cursor.anchor!==input.logical_message_id||cursor.fingerprint!==fingerprint||cursor.limit!==input.limit
        ||cursor.resource_binding_id!==cap.resource_binding_id||cursor.authority_version!==cap.authority_version||cursor.provider!==anchor.provider_source.provider||cursor.expires_at<=this.now())throw Error();
      continuation=cursor.continuation;provider=cursor.provider;failures=cursor.failures;
    }catch{throw new EmailConversationError('EMAIL_CONVERSATION_CURSOR_INVALID');}
    const recheck=async()=>{await this.current(actor,scope,cap,undefined,signal);};
    const page=NativeEmailConversationPageSchema.parse(await this.provider.readConversation(scope,{source:anchor.provider_source,cursor:continuation,limit:input.limit},cap,recheck,signal));await recheck();
    if(page.account_id!==scope.account_id||page.anchor_logical_message_id!==input.logical_message_id||page.provider!==anchor.provider_source.provider||provider!==null&&provider!==page.provider
      ||page.items.length>input.limit||page.next_cursor!==null&&page.next_cursor===continuation)throw new EmailConversationError('EMAIL_CONVERSATION_UNAVAILABLE');
    const records=validateEmailMessageRecords(scope,page.items,input.limit);if(records.some(row=>row.provider_source.provider!==page.provider||page.provider!=='imap_smtp'&&row.provider_source.conversation_id!==anchor.provider_source.conversation_id))throw denied();
    if(anchorFingerprint(await this.anchor(actor,scope,input.logical_message_id,cap,signal))!==fingerprint)throw new EmailConversationError('EMAIL_CONVERSATION_SOURCE_CHANGED');
    let accepted:Readonly<{records:readonly EmailMessageRecord[];dropped:number}>={records:[],dropped:0};
    if(records.length)accepted=await this.store.persistSearchResults(scope,records,async transaction=>{await this.current(actor,scope,cap,transaction,signal);},signal);await recheck();
    const persisted=validateEmailMessageRecords(scope,accepted.records,input.limit),wanted=new Set(records.map(row=>row.logical_message_id));
    if(!Number.isSafeInteger(accepted.dropped)||accepted.dropped!==records.length-persisted.length||accepted.dropped<0
      ||persisted.some(row=>(!wanted.has(row.logical_message_id)&&!(page.provider==='imap_smtp'&&records.some(item=>canonicalCapabilityJson(item.provider_source.locator)===canonicalCapabilityJson(row.provider_source.locator))))||row.provider_source.provider!==page.provider||page.provider!=='imap_smtp'&&row.provider_source.conversation_id!==anchor.provider_source.conversation_id))throw new EmailConversationError('EMAIL_CONVERSATION_UNAVAILABLE');
    if(anchorFingerprint(await this.anchor(actor,scope,input.logical_message_id,cap,signal))!==fingerprint)throw new EmailConversationError('EMAIL_CONVERSATION_SOURCE_CHANGED');
    failures+=page.failure_count+accepted.dropped;if(failures>100000)throw new EmailConversationError('EMAIL_CONVERSATION_UNAVAILABLE');let next_cursor:string|null=null;
    if(page.next_cursor!==null)next_cursor=Buffer.from(JSON.stringify(this.crypto.seal(Cursor.parse({version:1,anchor:input.logical_message_id,fingerprint,limit:input.limit,provider:page.provider,
      resource_binding_id:cap.resource_binding_id,authority_version:cap.authority_version,continuation:page.next_cursor,expires_at:Math.min(cap.expires_at,this.now()+15*60_000),failures}),context))).toString('base64url');
    await recheck();const complete=page.complete&&!page.has_more&&failures===0,byId=new Map(persisted.map(row=>[row.logical_message_id,row]));
    const items=records.flatMap(row=>{const current=byId.get(row.logical_message_id);return current?[visible(current)]:[];});
    return {account_id:scope.account_id,anchor_logical_message_id:input.logical_message_id,items,next_cursor,has_more:page.has_more,observed_at:page.observed_at,source:'provider',consistency:'weak',
      complete,coverage:complete?'complete':'partial',failure_count:failures,count:{returned:items.length,exact_total:null},...(page.thread_basis?{thread_basis:page.thread_basis,limitations:[...page.limitations!]}:{})};
  }
}
