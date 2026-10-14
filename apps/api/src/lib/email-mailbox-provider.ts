import {NativeEmailIncomingLimits, NativeEmailDigestSchema, NativeEmailPresentationSchema, NativeEmailFileSchema, NativeEmailImageSchema, NativeEmailCalendarPartsSchema, NativeEmailSearchRequestSchema, NativeEmailSearchPageSchema, NativeEmailConversationPageSchema, type NativeEmailAccount, type NativeEmailConnectionContext, type NativeEmailSource, type NativeEmailPresentation, type NativeEmailFile, type NativeEmailImage, type NativeEmailCalendarParts, type NativeEmailSearchPage, type NativeEmailSearchRequest, type NativeEmailConversationPage, type NativeEmailAdapter as AppConnectionAdapter} from './email-native-adapter-contract.js';
import { EmailMailboxError, type EmailCapability, type EmailProviderPage, type EmailScope } from './email-mailbox-service.js';
import {emailIncomingProviderBudget} from './email-incoming-read-budget.js';

type NativeAdapter = Pick<AppConnectionAdapter, 'nativeEmailAccount' | 'nativeEmailPage' | 'nativeEmailSource'|'nativeEmailPresentation'|'nativeEmailCalendarParts'|'nativeEmailFile'|'nativeEmailImage'|'nativeEmailSearch'|'nativeEmailTriage'|'nativeEmailFolders'|'nativeEmailDestination'|'nativeEmailFolderManage'|'nativeEmailSendIdentity'|'nativeEmailSend'|'nativeEmailPrepareSend'|'nativeEmailSentCopy'|'nativeEmailSentCopySettings'|'nativeEmailSnapshotFactory'|'nativeEmailConversation'|'nativeEmailDraftSync'|'nativeEmailDraftMime'>;
export type NativeEmailConnectionResolver = (scope: EmailScope, capability: EmailCapability,
  recheck: () => Promise<void>, signal: AbortSignal | undefined, purpose: 'status' | 'page'|'triage'|'folders'|'destination'|'folder_manage'|'send'|'draft_sync'|'sent_copy'|'sent_copy_settings') => Promise<Readonly<{
    adapter: NativeAdapter; context: NativeEmailConnectionContext;
  }>>;

const denied = () => new EmailMailboxError('EMAIL_ACCESS_DENIED');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\r\n\0\x00-\x1f\x7f]/.test(value);
function sameScope(a: EmailScope, b: EmailScope) {
  return a.org_id === b.org_id && a.owner_user_id === b.owner_user_id && a.account_id === b.account_id;
}
function checkInput(scope: EmailScope, capability: EmailCapability, now: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!scope || !validId(scope.org_id) || !validId(scope.owner_user_id) || !validId(scope.account_id)
    || !capability || !capability.scope || !sameScope(scope, capability.scope)
    || !validId(capability.resource_binding_id) || !validId(capability.authority_version)
    || !Number.isFinite(capability.expires_at) || capability.expires_at <= now) throw denied();
}

/** Server-owned bridge to the provider's retained OAuth custody. Browser data
 * only nominates a scope; adapter selection and its connection context are
 * supplied by the injected host resolver. */
export class RegisteredEmailMailboxProvider {
  constructor(private readonly resolve: NativeEmailConnectionResolver, private readonly now: () => number = Date.now) {}

  async assertConnected(scope: EmailScope, capability: EmailCapability, recheck: () => Promise<void>, signal?: AbortSignal): Promise<NativeEmailAccount> {
    const { adapter, context } = await this.resolveContext(scope, capability, recheck, signal, 'status');
    await recheck();
    const status = await this.status(adapter, context);
    this.assertLive(scope, capability, context, status, this.now(), signal);
    await recheck();
    this.assertLive(scope, capability, context, status, this.now(), signal);
    return status;
  }

  async readPage(scope: EmailScope, request: { cursor: string | null; limit: number }, capability: EmailCapability,
    recheck: () => Promise<void>, signal?: AbortSignal): Promise<EmailProviderPage> {
    if (!request || !(request.cursor === null || typeof request.cursor === 'string' && request.cursor.length > 0 && request.cursor.length <= 8192)
      || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new EmailMailboxError('EMAIL_PAGE_INVALID');
    const { adapter, context } = await this.resolveContext(scope, capability, recheck, signal, 'page');
    if (typeof adapter.nativeEmailPage !== 'function') throw denied();
    await recheck();
    const before = await this.status(adapter, context);
    this.assertLive(scope, capability, context, before, this.now(), signal);
    let page: EmailProviderPage;
    try {
      page = await adapter.nativeEmailPage({ cursor: request.cursor, limit: request.limit }, context);
    } catch (error) {
      // Recheck after a held provider call even on failure, then preserve its
      // failure. In particular, never turn provider errors into empty pages.
      await recheck();
      this.assertLive(scope, capability, context, await this.status(adapter, context), this.now(), signal);
      throw error;
    }
    await recheck();
    const after = await this.status(adapter, context);
    this.assertLive(scope, capability, context, after, this.now(), signal);
    if (!sameStatus(before, after) || !page || page.account_id !== scope.account_id) throw denied();
    return page;
  }

  async readSearch(scope:EmailScope,rawRequest:NativeEmailSearchRequest,capability:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailSearchPage>{
    const request=Object.freeze(NativeEmailSearchRequestSchema.parse(rawRequest));
    const {adapter,context}=await this.resolveContext(scope,capability,recheck,signal,'page');
    if(!adapter.nativeEmailSearch)throw denied();
    await recheck();const before=await this.status(adapter,context);
    this.assertLive(scope,capability,context,before,this.now(),signal);
    let result:NativeEmailSearchPage;
    try{result=await adapter.nativeEmailSearch(request,context);}catch(error){
      await recheck();this.assertLive(scope,capability,context,await this.status(adapter,context),this.now(),signal);throw error;
    }
    await recheck();const after=await this.status(adapter,context);
    this.assertLive(scope,capability,context,after,this.now(),signal);
    const page=NativeEmailSearchPageSchema.parse(result);
    if(!sameStatus(before,after)||page.account_id!==scope.account_id||page.provider!==before.provider||page.original_query!==request.query
      ||page.items.length+page.failure_count>request.limit||new Set(page.items.map(item=>item.logical_message_id)).size!==page.items.length
      ||page.has_more&&page.next_cursor===request.cursor||page.items.some(item=>item.account_id!==scope.account_id
        ||item.provider_source.schema_version!=='deft.email_provider_source.v1'||item.provider_source.account_id!==scope.account_id
        ||item.provider_source.provider!==before.provider||item.provider_source.logical_message_id!==item.logical_message_id
        ||item.provider_source.authority_epoch!==before.authority_epoch))throw denied();
    return page;
  }

  async readConversation(scope:EmailScope,input:Readonly<{source:Readonly<Record<string,unknown>>;cursor:string|null;limit:number}>,capability:EmailCapability,
    recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailConversationPage>{
    if(!input?.source||input.source.account_id!==scope.account_id||input.source.schema_version!=='deft.email_provider_source.v1'
      ||typeof input.source.logical_message_id!=='string'||!/^mail_[a-f0-9]{64}$/u.test(input.source.logical_message_id)||!Number.isInteger(input.limit)||input.limit<1||input.limit>100
      ||input.cursor!==null&&(typeof input.cursor!=='string'||!input.cursor||input.cursor.length>8192))throw denied();
    const {adapter,context}=await this.resolveContext(scope,capability,recheck,signal,'page');if(!adapter.nativeEmailConversation)throw denied();
    await recheck();const before=await this.status(adapter,context);this.assertLive(scope,capability,context,before,this.now(),signal);
    if(input.source.provider!==before.provider)throw denied();const source:Readonly<Record<string,unknown>>={...structuredClone(input.source),authority_epoch:before.authority_epoch};
    let raw:NativeEmailConversationPage;
    try{raw=await adapter.nativeEmailConversation({...input,source},context);}catch(error){await recheck();this.assertLive(scope,capability,context,await this.status(adapter,context),this.now(),signal);throw error;}
    await recheck();const after=await this.status(adapter,context);this.assertLive(scope,capability,context,after,this.now(),signal);const page=NativeEmailConversationPageSchema.parse(raw);
    if(!sameStatus(before,after)||page.account_id!==scope.account_id||page.provider!==before.provider||page.anchor_logical_message_id!==input.source.logical_message_id||page.items.length>input.limit
      ||page.next_cursor!==null&&page.next_cursor===input.cursor||page.items.some(item=>item.account_id!==scope.account_id||item.provider_source.account_id!==scope.account_id
        ||item.provider_source.logical_message_id!==item.logical_message_id||item.provider_source.provider!==before.provider||item.provider_source.authority_epoch!==before.authority_epoch
        ||before.provider!=='imap_smtp'&&item.provider_source.conversation_id!==source.conversation_id))throw denied();return page;
  }

  async readSource(scope:EmailScope,input:Readonly<{source:Readonly<Record<string,unknown>>}>,capability:EmailCapability,
    recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailSource>{
    if(!input?.source||input.source.account_id!==scope.account_id||input.source.schema_version!=='deft.email_provider_source.v1'
      ||typeof input.source.logical_message_id!=='string'||!/^mail_[a-f0-9]{64}$/.test(input.source.logical_message_id))throw denied();
    const remaining=capability.expires_at-this.now();if(!Number.isFinite(remaining)||remaining<=0)throw denied();
    const release=await emailIncomingProviderBudget.acquire(signal,Date.now()+remaining);
    try{
    const {adapter,context}=await this.resolveContext(scope,capability,recheck,signal,'page');
    if(!adapter.nativeEmailSource)throw denied();
    await recheck();
    const before=await this.status(adapter,context);
    this.assertLive(scope,capability,context,before,this.now(),signal);
    if(input.source.provider!==before.provider)throw denied();
    // The resolver verified the enrolled immutable principal; a reconnect may
    // advance its authority epoch without changing the private message locator.
    const source={...structuredClone(input.source),authority_epoch:before.authority_epoch};
    let result:NativeEmailSource|undefined;
    try{
      result=await adapter.nativeEmailSource({source},context);
      await recheck();
      const after=await this.status(adapter,context);
      this.assertLive(scope,capability,context,after,this.now(),signal);
      if(!sameStatus(before,after)||result.account_id!==scope.account_id||result.provider!==before.provider
        ||result.schema_version!=='deft.email_source.v1'||result.source_kind!=='provider_original'
        ||result.media_type!=='message/rfc822'||!(result.mime_bytes instanceof Uint8Array)
        ||result.mime_bytes.byteLength<1||result.mime_bytes.byteLength>NativeEmailIncomingLimits.source_bytes
        ||result.byte_length!==result.mime_bytes.byteLength||!/^[a-f0-9]{64}$/.test(result.digest))throw denied();
      return result;
    }catch(error){if(result?.mime_bytes instanceof Uint8Array)result.mime_bytes.fill(0);throw error;}
    }finally{release();}
  }

  readPresentation(scope:EmailScope,input:Readonly<{source:Readonly<Record<string,unknown>>}>,capability:EmailCapability,
    recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailPresentation>{
    return this.readContent(scope,input,capability,recheck,signal,async(adapter,request,context)=>{
      if(!adapter.nativeEmailPresentation)throw denied();
      return adapter.nativeEmailPresentation({source:request.source},context);
    },value=>NativeEmailPresentationSchema.parse(value));
  }

  readCalendarParts(scope:EmailScope,input:Readonly<{source:Readonly<Record<string,unknown>>}>,capability:EmailCapability,
    recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailCalendarParts>{
    return this.readContent(scope,input,capability,recheck,signal,async(adapter,request,context)=>{
      if(!adapter.nativeEmailCalendarParts)throw denied();
      return adapter.nativeEmailCalendarParts({source:request.source},context);
    },value=>NativeEmailCalendarPartsSchema.parse(value));
  }

  async readFile(scope:EmailScope,input:Readonly<{source:Readonly<Record<string,unknown>>;source_digest:string;file_ref:string}>,capability:EmailCapability,
    recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailFile>{
    if(!NativeEmailDigestSchema.safeParse(input?.source_digest).success||!NativeEmailDigestSchema.safeParse(input?.file_ref).success)throw denied();
    return this.readContent(scope,input,capability,recheck,signal,async(adapter,request,context)=>{
      if(!adapter.nativeEmailFile)throw denied();
      return adapter.nativeEmailFile({...input,source:request.source},context);
    },value=>NativeEmailFileSchema.parse(value));
  }

  async readImage(scope:EmailScope,input:Readonly<{source:Readonly<Record<string,unknown>>;source_digest:string;image_ref:string}>,capability:EmailCapability,
    recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailImage>{
    if(!NativeEmailDigestSchema.safeParse(input?.source_digest).success||!NativeEmailDigestSchema.safeParse(input?.image_ref).success)throw denied();
    return this.readContent(scope,input,capability,recheck,signal,async(adapter,request,context)=>{
      if(!adapter.nativeEmailImage)throw denied();
      return adapter.nativeEmailImage({...input,source:request.source},context);
    },value=>NativeEmailImageSchema.parse(value));
  }

  private async readContent<T extends NativeEmailPresentation|NativeEmailFile|NativeEmailImage|NativeEmailCalendarParts>(scope:EmailScope,
    input:Readonly<{source:Readonly<Record<string,unknown>>;source_digest?:string;file_ref?:string;image_ref?:string}>,capability:EmailCapability,
    recheck:()=>Promise<void>,signal:AbortSignal|undefined,
    read:(adapter:NativeAdapter,input:Readonly<{source:Readonly<Record<string,unknown>>}>,context:NativeEmailConnectionContext)=>Promise<T>,
    validate:(value:unknown)=>T):Promise<T>{
    if(!input?.source||input.source.account_id!==scope.account_id||input.source.schema_version!=='deft.email_provider_source.v1'
      ||typeof input.source.logical_message_id!=='string'||!/^mail_[a-f0-9]{64}$/u.test(input.source.logical_message_id))throw denied();
    const remaining=capability.expires_at-this.now();if(!Number.isFinite(remaining)||remaining<=0)throw denied();
    const release=await emailIncomingProviderBudget.acquire(signal,Date.now()+remaining);
    try{
    const {adapter,context}=await this.resolveContext(scope,capability,recheck,signal,'page');
    await recheck();const before=await this.status(adapter,context);
    this.assertLive(scope,capability,context,before,this.now(),signal);
    if(input.source.provider!==before.provider)throw denied();
    const source={...structuredClone(input.source),authority_epoch:before.authority_epoch};
    let result:T|undefined;
    try{
      result=await read(adapter,{source},context);
      await recheck();const after=await this.status(adapter,context);
      this.assertLive(scope,capability,context,after,this.now(),signal);
      if(!sameStatus(before,after))throw denied();
      const parsed=validate(result);
      if(parsed.account_id!==scope.account_id||parsed.provider!==before.provider||parsed.logical_message_id!==input.source.logical_message_id
        ||input.source_digest!==undefined&&parsed.source_digest!==input.source_digest
        ||'file_ref'in parsed&&parsed.file_ref!==input.file_ref||'image_ref'in parsed&&parsed.image_ref!==input.image_ref
        ||'presentation'in parsed&&parsed.presentation.metadata.account_id!==scope.account_id)throw denied();
      return parsed;
    }catch(error){if(result&&typeof result==='object'&&'bytes'in result&&result.bytes instanceof Uint8Array)result.bytes.fill(0);throw error;}
    }finally{release();}
  }

  private async resolveContext(scope: EmailScope, capability: EmailCapability, recheck: () => Promise<void>, signal: AbortSignal | undefined,
    purpose: 'status' | 'page'|'triage'|'folders'|'destination'|'send') {
    checkInput(scope, capability, this.now(), signal);
    const resolved = await this.resolve(scope, capability, recheck, signal, purpose);
    signal?.throwIfAborted();
    const c = resolved?.context;
    if (!resolved?.adapter || !c || c.org_id !== scope.org_id || c.owner_user_id !== scope.owner_user_id
      || c.account_id !== scope.account_id || c.resource_binding_id !== capability.resource_binding_id
      || c.authority_version !== capability.authority_version || !validId(c.installation_id)
      || typeof c.recheck !== 'function' || c.signal !== signal
      || !Number.isFinite(c.expires_at) || c.expires_at <= this.now() || c.expires_at > capability.expires_at) throw denied();
    return resolved;
  }

  private async status(adapter: NativeAdapter, context: NativeEmailConnectionContext): Promise<NativeEmailAccount> {
    if (typeof adapter.nativeEmailAccount !== 'function') throw denied();
    return adapter.nativeEmailAccount(context);
  }

  private assertLive(scope: EmailScope, capability: EmailCapability, context: NativeEmailConnectionContext,
    account: NativeEmailAccount, now: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (now >= capability.expires_at || now >= context.expires_at
      || account.account_id !== scope.account_id || account.resource_binding_id !== capability.resource_binding_id
      || !['gmail', 'microsoft', 'imap_smtp'].includes(account.provider)
      || account.health !== 'connected' || !Array.isArray(account.capabilities) || !account.capabilities.includes('read')
      || !Number.isSafeInteger(account.authority_epoch) || account.authority_epoch <= 0
      || !Number.isSafeInteger(account.connection_revision) || account.connection_revision < 0
      || typeof account.principal_digest !== 'string' || !/^[a-f0-9]{64}$/.test(account.principal_digest)) throw denied();
    if(account.implementation_digest!==undefined&&!/^[a-f0-9]{64}$/.test(account.implementation_digest))throw denied();
  }
}

function sameStatus(a: NativeEmailAccount, b: NativeEmailAccount) {
  return a.account_id === b.account_id && a.provider === b.provider && a.resource_binding_id === b.resource_binding_id
    && a.health === b.health && a.authority_epoch === b.authority_epoch && a.connection_revision === b.connection_revision
    && a.principal_digest === b.principal_digest
    && a.implementation_digest === b.implementation_digest
    && a.capabilities.includes('read') === b.capabilities.includes('read');
}
