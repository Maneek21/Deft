import {createHash} from 'node:crypto';
import {and,eq,gt,isNotNull} from 'drizzle-orm';
import {appResourceBindings,emailAccounts,emailImapCredentials,orgMembers,users,webSessions} from '@deft/db/schema';
import type {db} from './db.js';
import type {EmailAuthorityDatabase} from './email-mailbox-authority.js';
import type {loadLiveAttachmentSyncBindingAuthority} from './app-attachment-sync-authority.js';
import type {AppConnectionRegistry} from './app-connection-registry.js';
import type {AppConnectionPins} from './app-connection-contract.js';
import {EmailMailboxError,type EmailActor} from './email-mailbox-service.js';
export type EmailImapSetupTarget={account_id:string;resource_binding_id:string;credential_revision:number;display_label:string;primary_address:string;state:'available'|'active'|'needs_attention'};
type Database=EmailAuthorityDatabase&Pick<typeof db,'select'>;
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
type Options={now?:()=>Date;loadBinding?:typeof loadLiveAttachmentSyncBindingAuthority;getRegistry?:()=>Promise<Pick<AppConnectionRegistry,'select'>>;hasConstructors?:(pins:AppConnectionPins)=>boolean};
const denied=():never=>{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=256&&value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export class PostgresEmailImapSetupTargets{
 private readonly now:()=>Date;private readonly load:typeof loadLiveAttachmentSyncBindingAuthority;private readonly registry:()=>Promise<Pick<AppConnectionRegistry,'select'>>;private readonly constructors:(pins:AppConnectionPins)=>Promise<boolean>;
 constructor(private readonly database:Database,options:Options={}){
  this.now=options.now??(()=>new Date());this.load=options.loadBinding??(async(tx,input)=>(await import('./app-attachment-sync-authority.js')).loadLiveAttachmentSyncBindingAuthority(tx,input));
  this.registry=options.getRegistry??(async()=>(await import('./app-connection-registry.js')).getAppConnectionRegistry());
  this.constructors=async pins=>{if(options.hasConstructors)return options.hasConstructors(pins);try{(await import('./email-imap-runtime.js')).getRegisteredEmailImapConstructors(pins);return true;}catch{return false;}};
 }
 private async human(tx:Tx,actor:EmailActor,orgId:string,signal?:AbortSignal){
  const [session]=await tx.select({id:webSessions.id,org_id:webSessions.org_id,user_id:webSessions.user_id,expires_at:webSessions.expires_at,revoked_at:webSessions.revoked_at}).from(webSessions).where(and(eq(webSessions.id,actor.web_session_id),eq(webSessions.org_id,orgId),eq(webSessions.user_id,actor.user_id))).limit(1).for('share');
  // No new member/users locks here; the graph helper owns participant locks.
  // Sample human kind/member version after the SID wait, including empty scans.
  const [member]=await tx.select({active:orgMembers.is_active,role:orgMembers.role,version:orgMembers.app_run_authorization_version,kind:users.kind,is_agent:users.is_agent}).from(orgMembers).innerJoin(users,eq(users.id,orgMembers.user_id)).where(and(eq(orgMembers.org_id,orgId),eq(orgMembers.user_id,actor.user_id))).limit(1);
  signal?.throwIfAborted();const now=this.now().getTime();
  if(!Number.isFinite(now)||actor.access_expires_at<=now||!member||!member.active||!['owner','admin','member'].includes(member.role)||member.kind!=='human'||member.is_agent!==false||!Number.isSafeInteger(member.version)||member.version<1||!session||session.id!==actor.web_session_id||session.org_id!==orgId||session.user_id!==actor.user_id||session.revoked_at!==null||!(session.expires_at instanceof Date)||!Number.isFinite(session.expires_at.getTime())||session.expires_at.getTime()<=now)return denied();
  return digest(member);
 }
 async list(actor:EmailActor,orgId:string,signal?:AbortSignal):Promise<{items:EmailImapSetupTarget[];has_more:boolean}>{
  signal?.throwIfAborted();if(![actor?.user_id,actor?.web_session_id,orgId].every(validId)||!Number.isFinite(actor?.access_expires_at))return denied();actor=Object.freeze({...actor});
  const initial=await this.database.transaction(tx=>this.human(tx,actor,orgId,signal));
  const candidates=await this.database.select({id:appResourceBindings.id}).from(appResourceBindings).where(and(eq(appResourceBindings.org_id,orgId),eq(appResourceBindings.owner_user_id,actor.user_id),eq(appResourceBindings.state,'active'),isNotNull(appResourceBindings.reviewed_at),gt(appResourceBindings.consent_expires_at,this.now()))).orderBy(appResourceBindings.id).limit(51);
  const registry=await this.registry(),items:EmailImapSetupTarget[]=[];
  for(const candidate of candidates.slice(0,50)){
   signal?.throwIfAborted();const target=await this.database.transaction(async tx=>{
    const live=await this.load(tx,{org_id:orgId,resource_binding_id:candidate.id,clock:this.now});
    if(!live||live.binding.org_id!==orgId||live.binding.owner_user_id!==actor.user_id||live.binding.id!==candidate.id)return null;
    const graph=digest({...live,checked_at:undefined}),participants=[...new Set([actor.user_id,live.registration.operator_user_id])].sort();
    let pins:AppConnectionPins;try{pins=registry.select({org_id:orgId,owner_user_id:actor.user_id,installation_id:live.installation.id,target_key:live.binding.target_key}).pins;}catch{return null;}
    if(pins.org_id!==orgId||pins.owner_user_id!==actor.user_id||pins.installation_id!==live.installation.id||pins.resource_binding_id!==live.binding.id||pins.app_version_id!==live.binding.app_version_id||pins.grant_snapshot_id!==live.binding.grant_snapshot_id||pins.target_key!==live.binding.target_key||pins.resource_key!==live.binding.resource_key||!await this.constructors(pins))return null;
    const rows=await tx.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,orgId),eq(emailAccounts.owner_user_id,actor.user_id),eq(emailAccounts.resource_binding_id,candidate.id))).limit(2).for('share');
    if(rows.length>1||rows[0]&&rows[0].provider!=='imap_smtp')return null;
    const account=rows[0],accountId=account?.account_id??'imap_'+digest([orgId,actor.user_id,candidate.id]);
    const [credential]=await tx.select({revision:emailImapCredentials.connection_revision}).from(emailImapCredentials).where(and(eq(emailImapCredentials.org_id,orgId),eq(emailImapCredentials.owner_user_id,actor.user_id),eq(emailImapCredentials.account_id,accountId))).limit(1);
    const revision=credential?.revision??0;if(!Number.isSafeInteger(revision)||revision<0||revision>2147483645)return null;
    if(await this.human(tx,actor,orgId,signal)!==initial)return denied();
    const final=await this.load(tx,{org_id:orgId,resource_binding_id:candidate.id,clock:this.now,prelocked_participant_ids:participants});
    if(!final||digest({...final,checked_at:undefined})!==graph)return null;
    if(await this.human(tx,actor,orgId,signal)!==initial)return denied();
    return {account_id:accountId,resource_binding_id:candidate.id,credential_revision:revision,display_label:'',primary_address:'',state:!account?'available':account.state==='active'?'active':'needs_attention'} as EmailImapSetupTarget;
   });if(target)items.push(target);
  }
  if(await this.database.transaction(tx=>this.human(tx,actor,orgId,signal))!==initial)return denied();signal?.throwIfAborted();return {items,has_more:candidates.length>50};
 }
}
