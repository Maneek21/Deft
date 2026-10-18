import {createHash} from 'node:crypto';
import {and,eq,inArray} from 'drizzle-orm';
import {emailAccounts,orgMembers,users} from '@deft/db/schema';
import type {db} from './db.js';
import type {EmailAuthorityDatabase} from './email-mailbox-authority.js';
import type {ConnectedEmailMailboxAuthority} from './email-mailbox-connected-authority.js';
import type {loadLiveAttachmentSyncBindingAuthority,LiveAttachmentSyncBindingAuthority} from './app-attachment-sync-authority.js';
import {EmailMailboxError,type EmailActor,type EmailScope} from './email-mailbox-service.js';

export type EmailProviderDraftSetting=Readonly<{account_id:string;enabled:boolean;revision:number;supported:boolean}>;
export type EmailProviderDraftSettingUpdate=Readonly<{enabled:boolean;expected_revision:number}>;
type Runtime={authority:Pick<ConnectedEmailMailboxAuthority,'inspect'>};
type Transaction=Parameters<Parameters<EmailAuthorityDatabase['transaction']>[0]>[0];
type Options={runtime?:(actor:EmailActor)=>Promise<Runtime>;loadBinding?:typeof loadLiveAttachmentSyncBindingAuthority;now?:()=>Date;
 pauseQueued?:(tx:Transaction,scope:EmailScope,now:Date)=>Promise<unknown>;resumePaused?:(tx:Transaction,scope:EmailScope,now:Date)=>Promise<unknown>};
export class EmailProviderDraftSettingsError extends Error {constructor(readonly code:'EMAIL_DRAFT_SYNC_INVALID'|'EMAIL_DRAFT_SYNC_CONFLICT'|'EMAIL_DRAFT_SYNC_UNSUPPORTED'){super(code);}}
const deny=():never=>{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
const conflict=():never=>{throw new EmailProviderDraftSettingsError('EMAIL_DRAFT_SYNC_CONFLICT');};
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const accountWhere=(scope:EmailScope)=>and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id));
function canonical(value:unknown):unknown {
 if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,part])=>[key,canonical(part)]));return value;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const graphDigest=(live:LiveAttachmentSyncBindingAuthority)=>digest({...live,checked_at:undefined});
const stableAccount=(row:typeof emailAccounts.$inferSelect)=>digest({...row,provider_draft_sync_enabled:undefined,authority_revision:undefined,updated_at:undefined});
type Inspection=Awaited<ReturnType<Runtime['authority']['inspect']>>;
const sameConnection=(before:Inspection,after:Inspection)=>before.capability.resource_binding_id===after.capability.resource_binding_id
 &&before.account.account_id===after.account.account_id&&before.account.resource_binding_id===after.account.resource_binding_id
 &&before.account.provider===after.account.provider&&before.account.principal_digest===after.account.principal_digest
 &&before.account.connection_revision===after.account.connection_revision&&before.account.health===after.account.health
 &&digest([...before.account.capabilities].sort())===digest([...after.account.capabilities].sort());

/** Explicit owner opt-in only. The legacy graph is locked before the native
 * account UPDATE lock; the exact human SID is acquired by inspect last. This
 * avoids upgrading a shared account lock after acquiring the session lock. */
export class PostgresEmailProviderDraftSettings {
 private readonly options:Required<Options>;
 constructor(private readonly database:EmailAuthorityDatabase&Pick<typeof db,'select'>,options:Options={}){
  this.options={now:options.now??(()=>new Date()),runtime:options.runtime??(async actor=>(await import('./email-mailbox-runtime.js')).getEmailMailboxRuntime(actor)),
   loadBinding:options.loadBinding??(async(tx,input)=>(await import('./app-attachment-sync-authority.js')).loadLiveAttachmentSyncBindingAuthority(tx,input)),
   pauseQueued:options.pauseQueued??(async(tx,scope,now)=>(await import('./email-provider-draft-mirror-store.js')).pauseQueuedEmailProviderDraftMirrors(tx,scope,now)),
   resumePaused:options.resumePaused??(async(tx,scope,now)=>(await import('./email-provider-draft-mirror-store.js')).resumePausedEmailProviderDraftMirrors(tx,scope,now))};
 }
 private scope(actor:EmailActor,orgId:string,accountId:string,signal?:AbortSignal):EmailScope {
  signal?.throwIfAborted();const now=this.options.now().getTime();
  if(![actor?.user_id,actor?.web_session_id,orgId,accountId].every(id)||!Number.isFinite(now)||!Number.isFinite(actor?.access_expires_at)||actor.access_expires_at<=now)return deny();
  return Object.freeze({org_id:orgId,owner_user_id:actor.user_id,account_id:accountId});
 }
 private view(scope:EmailScope,row:typeof emailAccounts.$inferSelect|undefined,inspection:Inspection):EmailProviderDraftSetting {
  const now=this.options.now().getTime();
  if(!row||row.org_id!==scope.org_id||row.owner_user_id!==scope.owner_user_id||row.account_id!==scope.account_id||row.state!=='active'||row.revoked_at!==null||!(row.consented_at instanceof Date)||!Number.isFinite(row.consented_at.getTime())||row.consented_at.getTime()>now
   ||typeof row.provider_draft_sync_enabled!=='boolean'||!Number.isSafeInteger(row.authority_revision)||row.authority_revision<1
   ||inspection.capability.scope.org_id!==scope.org_id||inspection.capability.scope.owner_user_id!==scope.owner_user_id||inspection.capability.scope.account_id!==scope.account_id
   ||inspection.account.account_id!==scope.account_id||row.provider!==inspection.account.provider||row.resource_binding_id!==inspection.capability.resource_binding_id
   ||row.principal_digest!==inspection.account.principal_digest||!row.principal_digest||!/^[a-f0-9]{64}$/u.test(row.principal_digest)
   ||!Number.isFinite(inspection.capability.expires_at)||inspection.capability.expires_at<=now||inspection.account.health!=='connected'||!inspection.account.capabilities.includes('read'))return deny();
  return Object.freeze({account_id:scope.account_id,enabled:row.provider_draft_sync_enabled,revision:row.authority_revision,supported:['gmail','microsoft'].includes(row.provider)&&inspection.account.capabilities.includes('modify')});
 }
 private async participants(tx:Transaction,scope:EmailScope,live:LiveAttachmentSyncBindingAuthority) {
  const ids=[...new Set([scope.owner_user_id,live.registration.operator_user_id])].sort();
  // These members are already locked by the live helper. No users lock is
  // introduced after the established graph/native/SID order.
  const rows=await tx.select({org_id:orgMembers.org_id,user_id:orgMembers.user_id,role:orgMembers.role,active:orgMembers.is_active,authorization_version:orgMembers.app_run_authorization_version,kind:users.kind,is_agent:users.is_agent})
   .from(orgMembers).innerJoin(users,eq(users.id,orgMembers.user_id)).where(and(eq(orgMembers.org_id,scope.org_id),inArray(orgMembers.user_id,ids)));
  return digest(rows.sort((a,b)=>a.user_id.localeCompare(b.user_id)));
 }
 async get(actor:EmailActor,orgId:string,accountId:string,signal?:AbortSignal):Promise<EmailProviderDraftSetting> {
  const scope=this.scope(actor,orgId,accountId,signal);actor=Object.freeze({user_id:actor.user_id,web_session_id:actor.web_session_id,access_expires_at:actor.access_expires_at});
  const {authority}=await this.options.runtime(actor);
  const before=await authority.inspect(actor,scope,'human_read',undefined,signal);
  const [row]=await this.database.select().from(emailAccounts).where(accountWhere(scope)).limit(1);
  const after=await authority.inspect(actor,scope,'human_read',undefined,signal);this.scope(actor,orgId,accountId,signal);
  if(before.capability.authority_version!==after.capability.authority_version||!sameConnection(before,after))return deny();
  return this.view(scope,row,after);
 }
 async update(actor:EmailActor,orgId:string,accountId:string,input:EmailProviderDraftSettingUpdate,signal?:AbortSignal):Promise<EmailProviderDraftSetting> {
  const scope=this.scope(actor,orgId,accountId,signal);
  if(!input||Object.keys(input).sort().join(',')!=='enabled,expected_revision'||typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1||input.expected_revision>=2147483647)throw new EmailProviderDraftSettingsError('EMAIL_DRAFT_SYNC_INVALID');
  input=Object.freeze({...input});actor=Object.freeze({...actor});const {authority}=await this.options.runtime(actor);
  return this.database.transaction(async tx=>{
   const [locator]=await tx.select({resource_binding_id:emailAccounts.resource_binding_id}).from(emailAccounts).where(accountWhere(scope)).limit(1);
   if(!locator||!id(locator.resource_binding_id))return deny();
   const live=await this.options.loadBinding(tx,{org_id:orgId,resource_binding_id:locator.resource_binding_id,clock:this.options.now});
   if(!live||live.binding.org_id!==orgId||live.binding.owner_user_id!==scope.owner_user_id||live.binding.id!==locator.resource_binding_id)return deny();
   const graph=graphDigest(live),members=await this.participants(tx,scope,live);
   const [row]=await tx.select().from(emailAccounts).where(accountWhere(scope)).limit(1).for('update');
   if(!row||row.resource_binding_id!==locator.resource_binding_id)return deny();this.scope(actor,orgId,accountId,signal);
   const operation=input.enabled?'human_modify':'human_read',before=await authority.inspect(actor,scope,operation,tx,signal),previous=this.view(scope,row,before);
   if(previous.revision!==input.expected_revision)return conflict();
   if(input.enabled&&!['gmail','microsoft'].includes(row.provider))throw new EmailProviderDraftSettingsError('EMAIL_DRAFT_SYNC_UNSUPPORTED');
   if(input.enabled&&!before.account.capabilities.includes('modify'))return deny();
   let written=row;
   if(previous.enabled!==input.enabled){
    const rows=await tx.update(emailAccounts).set({provider_draft_sync_enabled:input.enabled,authority_revision:row.authority_revision+1,updated_at:this.options.now()})
     .where(and(accountWhere(scope),eq(emailAccounts.authority_revision,input.expected_revision),eq(emailAccounts.resource_binding_id,locator.resource_binding_id))).returning();
    if(rows.length!==1)return conflict();written=rows[0]!;
    if(input.enabled)await this.options.resumePaused(tx,scope,this.options.now());else await this.options.pauseQueued(tx,scope,this.options.now());
   }
   signal?.throwIfAborted();
   const after=await authority.inspect(actor,scope,operation,tx,signal);
   const final=await this.options.loadBinding(tx,{org_id:orgId,resource_binding_id:locator.resource_binding_id,clock:this.options.now,prelocked_participant_ids:[...new Set([scope.owner_user_id,live.registration.operator_user_id])].sort()});
   const [finalRow]=await tx.select().from(emailAccounts).where(accountWhere(scope)).limit(1);
   const finalMembers=final?await this.participants(tx,scope,final):null;
   this.scope(actor,orgId,accountId,signal);
   if(!final||graphDigest(final)!==graph||members!==finalMembers||!sameConnection(before,after)||!finalRow
    ||stableAccount(finalRow)!==stableAccount(row)||finalRow.authority_revision!==written.authority_revision||finalRow.provider_draft_sync_enabled!==input.enabled
    ||previous.enabled===input.enabled&&before.capability.authority_version!==after.capability.authority_version)return deny();
   // The authority digest changes intentionally when the native flag/revision
   // changes. All other graph, member and provider custody pins remain exact.
   return this.view(scope,finalRow,after);
  });
 }
}
