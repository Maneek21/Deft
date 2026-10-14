import { EmailOperationActorSchema } from './email-agent-actor.js';
import {z} from 'zod';
import {NativeEmailFolderPageSchema, NativeEmailDestinationSchema, type NativeEmailFolderPage, type NativeEmailAccount, type NativeEmailTriageDestination} from './email-native-adapter-contract.js';
import type {NativeEmailConnectionResolver} from './email-mailbox-provider.js';
import {EmailMailboxError,type EmailOperationActor,type EmailScope,type EmailCapability,type EmailAuthority} from './email-mailbox-service.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailNativeTriageDestinationResolver} from './email-native-triage.js';
import {EmailFolderManageRequestSchema,EmailFolderManagedSchema,EmailFolderManageResultSchema,EmailFolderManageOperationsSchema,EmailFolderManageError,emailFolderManageDigest,type EmailFolderManageJournal,type EmailFolderManageProviderRequest,type EmailFolderManageResult,type EmailFolderManageValue} from './email-folder-management-contract.js';

const Id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const Scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id});
const Actor = EmailOperationActorSchema;
const Request=z.strictObject({cursor:z.string().min(1).max(256*1024).nullable(),limit:z.number().int().min(1).max(100),management:z.literal(true).optional()});
const ttl=15*60_000;
const denied=()=>new EmailMailboxError('EMAIL_ACCESS_DENIED');
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;
const identity=(a:NativeEmailAccount)=>JSON.stringify([a.account_id,a.provider,a.resource_binding_id,a.principal_digest,a.connection_revision,a.authority_epoch]);
const Bound=z.strictObject({principal_digest:z.string().regex(/^[a-f0-9]{64}$/u),connection_revision:z.number().int().positive(),resource_binding_id:Id,
  expires_at:z.number().finite(),provider:z.enum(['gmail','microsoft']),authority_version:Id});
const Cursor=Bound.extend({kind:z.literal('catalog'),cursor:z.string().min(1).max(90000),limit:z.number().int().min(1).max(100)});
const Destination=Bound.extend({kind:z.literal('destination'),id:Id,folder_id:Id,move_allowed:z.literal(true)});
const ManagementCursor=Bound.extend({kind:z.literal('management_catalog'),cursor:z.string().min(1).max(90000),limit:z.number().int().min(1).max(100)});
const Rename=Bound.extend({kind:z.literal('rename'),id:Id,folder_id:Id,name:z.string().min(1).max(512),eligible:z.literal(true)});
export class EmailNativeFolderError extends Error{constructor(readonly code:'EMAIL_FOLDER_CURSOR_INVALID'|'EMAIL_FOLDER_CURSOR_EXPIRED'|'EMAIL_FOLDER_DESTINATION_DENIED'){super(code);this.name='EmailNativeFolderError';}}
export interface EmailNativeFolderProvider{
  current(scope:EmailScope,cap:EmailCapability,recheck:()=>Promise<void>,purpose:'folders'|'destination'|'folder_manage',signal?:AbortSignal):Promise<NativeEmailAccount>;
  list(scope:EmailScope,input:{cursor:string|null;limit:number;management?:true},cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<{account:NativeEmailAccount;page:NativeEmailFolderPage}>;
  destination(scope:EmailScope,id:string,cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailTriageDestination>;
  manage?(scope:EmailScope,input:EmailFolderManageProviderRequest,cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<z.infer<typeof EmailFolderManagedSchema>>;
}
/** Selected adapter and account context are host-only resolver output. */
export class RegisteredEmailNativeFolderProvider implements EmailNativeFolderProvider{
  constructor(private readonly resolve:NativeEmailConnectionResolver,private readonly now=Date.now){}
  private async context(scope:EmailScope,cap:EmailCapability,recheck:()=>Promise<void>,purpose:'folders'|'destination'|'folder_manage',signal?:AbortSignal){
    signal?.throwIfAborted();if(!Scope.safeParse(scope).success||!cap?.scope||!sameScope(scope,cap.scope)||!Number.isFinite(this.now())
      ||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now()||!Id.safeParse(cap.resource_binding_id).success||!Id.safeParse(cap.authority_version).success)throw denied();
    const selected=await this.resolve(scope,cap,recheck,signal,purpose),{adapter,context}=selected;
    if(!adapter.nativeEmailAccount||!sameScope(scope,context)||context.resource_binding_id!==cap.resource_binding_id||context.authority_version!==cap.authority_version
      ||!Number.isFinite(context.expires_at)||context.expires_at>cap.expires_at||context.expires_at<=this.now()||context.signal!==signal||typeof context.recheck!=='function')throw denied();
    const checked=async()=>{signal?.throwIfAborted();await recheck();if(this.now()>=context.expires_at)throw denied();const account=await adapter.nativeEmailAccount!(context);
      if(purpose==='folder_manage'&&(!['gmail','microsoft'].includes(account.provider)||!adapter.nativeEmailFolderManage))throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_UNSUPPORTED');
      if(account.account_id!==scope.account_id||account.resource_binding_id!==cap.resource_binding_id||!['gmail','microsoft'].includes(account.provider)
        ||account.health!=='connected'||!account.capabilities.includes(purpose==='folders'?'read':'modify')||!Number.isSafeInteger(account.connection_revision)||account.connection_revision<1
        ||!Number.isSafeInteger(account.authority_epoch)||account.authority_epoch<1||!/^[a-f0-9]{64}$/u.test(account.principal_digest))throw denied();signal?.throwIfAborted();return account;};
    return {adapter,context,checked};
  }
  async current(scope:EmailScope,cap:EmailCapability,recheck:()=>Promise<void>,purpose:'folders'|'destination'|'folder_manage',signal?:AbortSignal){return (await this.context(scope,cap,recheck,purpose,signal)).checked();}
  async list(scope:EmailScope,input:{cursor:string|null;limit:number;management?:true},cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal){
    const selected=await this.context(scope,cap,recheck,input.management?'folder_manage':'folders',signal),before=await selected.checked();if(!selected.adapter.nativeEmailFolders)throw denied();
    const page=NativeEmailFolderPageSchema.parse(await selected.adapter.nativeEmailFolders(input,selected.context)),after=await selected.checked();
    if(identity(before)!==identity(after)||page.account_id!==scope.account_id||page.provider!==before.provider||page.items.length>input.limit||input.management&&(page.management!==true||page.items.some(row=>typeof row.rename_allowed!=='boolean'))||!input.management&&(page.management!==undefined||page.items.some(row=>row.rename_allowed!==undefined)))throw denied();return {account:after,page};
  }
  async destination(scope:EmailScope,id:string,cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal){
    const selected=await this.context(scope,cap,recheck,'destination',signal),before=await selected.checked();if(!selected.adapter.nativeEmailDestination)throw denied();
    const result=NativeEmailDestinationSchema.parse(await selected.adapter.nativeEmailDestination({id},selected.context)),after=await selected.checked();
    if(identity(before)!==identity(after)||result.account_id!==scope.account_id||result.provider!==before.provider||result.id!==id
      ||result.kind!==(before.provider==='gmail'?'label':'folder'))throw denied();return result;
  }
  async manage(scope:EmailScope,input:EmailFolderManageProviderRequest,cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal){
    const selected=await this.context(scope,cap,recheck,'folder_manage',signal),before=await selected.checked();if(!selected.adapter.nativeEmailFolderManage)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_UNSUPPORTED');
    const result=EmailFolderManagedSchema.parse(await selected.adapter.nativeEmailFolderManage(input,selected.context)),after=await selected.checked();
    if(identity(before)!==identity(after)||result.kind!==(before.provider==='gmail'?'label':'folder')||input.kind==='rename'&&result.id!==input.id||result.label!==input.name)throw denied();return result;
  }
}
export type EmailNativeFolderPage=Readonly<{account_id:string;provider:'gmail'|'microsoft';items:readonly Readonly<{
  folder_id:string;label:string;kind:'label'|'folder';parent_folder_id:string|null;canonical_role:string|null;destination_id:string|null;labels_allowed:boolean;rename_id?:string|null}>[];
  next_cursor:string|null;has_more:boolean;observed_at:string;coverage:'partial'|'complete';consistency:'weak';exact_total:null;create_allowed?:boolean}>;

/** Scoped AEAD handles retain nominations, never permission. Each Move resolves
 * its handle against the current provider mailbox before triage reservation. */
export class EmailNativeFolderService{
  constructor(private readonly authority:EmailAuthority,private readonly provider:EmailNativeFolderProvider,private readonly crypto:EmailMailboxCrypto,private readonly now=Date.now,private readonly journalFactory?:(scope:EmailScope,cap:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal)=>EmailFolderManageJournal){}
  private cryptoContext(scope:EmailScope,kind:'catalog'|'destination'|'management_catalog'|'rename'){return {...scope,kind:'checkpoint' as const,record_id:'native-folder-'+kind+':v1',revision:1};}
  private seal(scope:EmailScope,kind:'catalog'|'destination'|'management_catalog'|'rename',value:unknown){return Buffer.from(JSON.stringify(this.crypto.seal(value,this.cryptoContext(scope,kind)))).toString('base64url');}
  private open(scope:EmailScope,kind:'catalog'|'destination'|'management_catalog'|'rename',token:string){
    try{if(token.length>256*1024||!/^[A-Za-z0-9_-]+$/u.test(token))throw Error();const bytes=Buffer.from(token,'base64url');if(bytes.toString('base64url')!==token)throw Error();return this.crypto.open(JSON.parse(bytes.toString('utf8')),this.cryptoContext(scope,kind));}
    catch{if(kind==='rename')throw new EmailFolderManageError('EMAIL_FOLDER_RENAME_INVALID');throw new EmailNativeFolderError(kind==='catalog'||kind==='management_catalog'?'EMAIL_FOLDER_CURSOR_INVALID':'EMAIL_FOLDER_DESTINATION_DENIED');}
  }
  private binding(account:NativeEmailAccount,cap:EmailCapability){return {principal_digest:account.principal_digest,connection_revision:account.connection_revision,
    resource_binding_id:account.resource_binding_id,provider:account.provider as 'gmail'|'microsoft',authority_version:cap.authority_version,expires_at:Math.min(this.now()+ttl,cap.expires_at)};}
  private matches(bound:z.infer<typeof Bound>,account:NativeEmailAccount,cap:EmailCapability){
    if(bound.expires_at<=this.now())throw new EmailNativeFolderError(bound.expires_at>0?'EMAIL_FOLDER_CURSOR_EXPIRED':'EMAIL_FOLDER_DESTINATION_DENIED');
    if(bound.principal_digest!==account.principal_digest||bound.connection_revision!==account.connection_revision||bound.resource_binding_id!==account.resource_binding_id
      ||bound.provider!==account.provider||bound.authority_version!==cap.authority_version)throw denied();
  }
  async list(rawActor:EmailOperationActor,rawScope:EmailScope,rawInput:z.infer<typeof Request>,signal?:AbortSignal):Promise<EmailNativeFolderPage>{
    const actor=Object.freeze(Actor.parse(rawActor)),scope=Object.freeze(Scope.parse(rawScope)),input=Request.parse(rawInput);
    const check=async(expected?:EmailCapability)=>{signal?.throwIfAborted();if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw denied();
      const cap=structuredClone(await this.authority.current(actor,scope,input.management?'human_modify':'human_read',undefined,signal));if(!sameScope(scope,cap.scope)||cap.expires_at<=this.now()
        ||expected&&(cap.authority_version!==expected.authority_version||cap.resource_binding_id!==expected.resource_binding_id))throw denied();return cap;};
    const cap=await check(),recheck=async()=>{await check(cap);};let cursor:null|string=null;
    const cursorKind=input.management?'management_catalog':'catalog';
    if(input.cursor!==null){const bound=(input.management?ManagementCursor:Cursor).parse(this.open(scope,cursorKind,input.cursor));this.matches(bound,await this.provider.current(scope,cap,recheck,input.management?'folder_manage':'folders',signal),cap);
      if(bound.limit!==input.limit)throw new EmailNativeFolderError('EMAIL_FOLDER_CURSOR_INVALID');cursor=bound.cursor;}
    const {account,page}=await this.provider.list(scope,{cursor,limit:input.limit,...(input.management?{management:true as const}:{})},cap,recheck,signal),binding=this.binding(account,cap);
    const items=page.items.map(row=>({folder_id:row.folder_id,label:row.label,kind:row.kind,
      parent_folder_id:row.parent_folder_id,canonical_role:row.canonical_role,
      destination_id:row.move_allowed?this.seal(scope,'destination',{...binding,kind:'destination',id:row.id,folder_id:row.folder_id,move_allowed:true}):null,labels_allowed:row.labels_allowed,
      ...(input.management?{rename_id:row.rename_allowed?this.seal(scope,'rename',{...binding,kind:'rename',id:row.id,folder_id:row.folder_id,name:row.label,eligible:true}):null}:{})}));
    const next=page.next_cursor===null?null:this.seal(scope,cursorKind,{...binding,kind:cursorKind,cursor:page.next_cursor,limit:input.limit});await recheck();
    return {account_id:scope.account_id,provider:page.provider,items,next_cursor:next,has_more:page.has_more,observed_at:page.observed_at,
      coverage:page.has_more?'partial':'complete',consistency:'weak',exact_total:null,...(input.management?{create_allowed:account.capabilities.includes('modify')}:{})};
  }
  private async management(rawActor:EmailOperationActor,rawScope:EmailScope,signal?:AbortSignal){
    const actor=Object.freeze(Actor.parse(rawActor)),scope=Object.freeze(Scope.parse(rawScope));
    const check=async(expected?:EmailCapability)=>{signal?.throwIfAborted();if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw denied();const cap=structuredClone(await this.authority.current(actor,scope,'human_modify',undefined,signal));
      if(!sameScope(scope,cap.scope)||cap.expires_at<=this.now()||expected&&(cap.authority_version!==expected.authority_version||cap.resource_binding_id!==expected.resource_binding_id))throw denied();return cap;};
    const cap=await check(),recheck=async()=>{await check(cap);},account=await this.provider.current(scope,cap,recheck,'folder_manage',signal);
    if(!this.journalFactory||!['gmail','microsoft'].includes(account.provider))throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_UNSUPPORTED');
    const bound={provider:account.provider as 'gmail'|'microsoft',principal_digest:account.principal_digest,connection_revision:account.connection_revision,authority_epoch:account.authority_epoch,resource_binding_id:account.resource_binding_id,authority_version:cap.authority_version};
    const current=async()=>{await recheck();const after=await this.provider.current(scope,cap,recheck,'folder_manage',signal);if(identity(after)!==identity(account))throw denied();};
    return {scope,cap,account,bound,recheck,current,journal:this.journalFactory(scope,cap,recheck,signal)};
  }
  private retained(value:EmailFolderManageValue,bound:unknown):EmailFolderManageResult{
    if(emailFolderManageDigest(value.plan.binding)!==emailFolderManageDigest(bound))throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');
    return EmailFolderManageResultSchema.parse(value.result??{schema_version:'deft.email_folder_manage_result.v1',account_id:value.plan.scope.account_id,operation_id:value.plan.operation_id,kind:value.plan.request.kind,state:'unknown',folder_id:null,label:null,automatic_retry:false,undo_supported:false,code:'outcome_unknown'});
  }
  async manage(rawActor:EmailOperationActor,rawScope:EmailScope,rawInput:unknown,signal?:AbortSignal):Promise<EmailFolderManageResult>{
    const input=Object.freeze(EmailFolderManageRequestSchema.parse(rawInput)),host=await this.management(rawActor,rawScope,signal);
    const result=await host.journal.change(input.operation_id,async(prior,write)=>{
      if(prior){if(emailFolderManageDigest(prior.plan.request)!==emailFolderManageDigest(input))throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');return this.retained(prior,host.bound);}
      let request:EmailFolderManageProviderRequest={kind:'create',name:input.name};
      if(input.kind==='rename'){let bound:z.infer<typeof Rename>;try{bound=Rename.parse(this.open(host.scope,'rename',input.rename_id));}catch{throw new EmailFolderManageError('EMAIL_FOLDER_RENAME_INVALID');}
        if(bound.expires_at<=this.now())throw new EmailFolderManageError('EMAIL_FOLDER_RENAME_EXPIRED');this.matches(bound,host.account,host.cap);request={kind:'rename',id:bound.id,name:input.name,expected_name:bound.name};}
      const unsigned={schema_version:'deft.email_folder_manage_plan.v1' as const,operation_id:input.operation_id,scope:host.scope,binding:host.bound,request:input,provider_request:request},plan={...unsigned,digest:emailFolderManageDigest(unsigned)};
      await host.current();await write({plan,state:'prepared',result:null});await host.current();await write({plan,state:'started',result:null});await host.current();
      let receipt:EmailFolderManageResult;try{if(!this.provider.manage)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_UNSUPPORTED');const row=await this.provider.manage(host.scope,request,host.cap,host.recheck,signal);await host.current();
        receipt={schema_version:'deft.email_folder_manage_result.v1',account_id:host.scope.account_id,operation_id:input.operation_id,kind:input.kind,state:'succeeded',folder_id:row.folder_id,label:row.label,automatic_retry:false,undo_supported:false};
      }catch(error){await host.current();const code=(error as {code?:string})?.code,known=code==='EMAIL_NATIVE_FOLDER_PROVIDER_REJECTED'||code==='EMAIL_NATIVE_FOLDER_TARGET_CHANGED';
        receipt={schema_version:'deft.email_folder_manage_result.v1',account_id:host.scope.account_id,operation_id:input.operation_id,kind:input.kind,state:known?'failed':'unknown',folder_id:null,label:null,automatic_retry:false,undo_supported:false,code:code==='EMAIL_NATIVE_FOLDER_TARGET_CHANGED'?'target_changed':known?'provider_rejected':'outcome_unknown'};}
      await write({plan,state:receipt.state,result:receipt});return receipt;
    });await host.current();return EmailFolderManageResultSchema.parse(result);
  }
  async status(rawActor:EmailOperationActor,rawScope:EmailScope,operationId:string,signal?:AbortSignal){
    const id=z.uuid().parse(operationId),host=await this.management(rawActor,rawScope,signal),value=await host.journal.load(id);if(!value)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');const result=this.retained(value,host.bound);await host.current();return result;
  }
  async recent(rawActor:EmailOperationActor,rawScope:EmailScope,signal?:AbortSignal){
    const host=await this.management(rawActor,rawScope,signal),rows=await host.journal.recent();if(rows.length>20)throw new EmailFolderManageError('EMAIL_FOLDER_MANAGEMENT_CONFLICT');
    const items=rows.map(row=>({operation_id:row.value.plan.operation_id,kind:row.value.plan.request.kind,proposed_name:row.value.plan.request.name,created_at:row.created_at,result:this.retained(row.value,host.bound)}));
    await host.current();return EmailFolderManageOperationsSchema.parse({schema_version:'deft.email_folder_manage_operations.v1',account_id:host.scope.account_id,items,limit:20,coverage:'recent',automatic_retry:false});
  }
  readonly resolveDestination:EmailNativeTriageDestinationResolver=async(rawScope,token,cap,recheck,signal)=>{
    const scope=Object.freeze(Scope.parse(rawScope));await recheck();const bound=Destination.parse(this.open(scope,'destination',token));
    this.matches(bound,await this.provider.current(scope,cap,recheck,'destination',signal),cap);
    const result=await this.provider.destination(scope,bound.id,cap,recheck,signal);await recheck();return result;
  };
}
