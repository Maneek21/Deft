import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {emailAccounts,emailAccountConsents,orgMembers,users,webSessions,jobQueue} from '@deft/db/schema';
import {z} from 'zod';
import {canonicalCapabilityJson} from '@deft/shared';
import type {db} from './db.js';
import type {EmailServiceLease} from './email-mailbox-authority.js';
import {EmailMailboxError,type EmailAuthority,type EmailActor,type EmailCapability,type EmailScope,type EmailOperation} from './email-mailbox-service.js';
import {PostgresEmailAccountConsentStore,type EmailAccountConsentTransaction} from './email-account-consent-store.js';
import {requireEmailAccountConsent,emailAccountBridgeBindingId} from './email-account-lifecycle.js';
const id=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const scopeSchema=z.strictObject({org_id:id,owner_user_id:id,account_id:id}),actorSchema=z.strictObject({user_id:id,web_session_id:id,access_expires_at:z.number().finite()});
const base={job_id:id,lock_token:z.string().uuid()},uuid=z.string().uuid(),counter=z.number().int().positive().max(2147483646);
const leaseSchema=z.union([
 z.strictObject({...base,job_name:z.literal('native-email-sync').optional()}),
 z.strictObject({...base,job_name:z.literal('native-email-knowledge'),policy_revision:counter}),
 z.strictObject({...base,job_name:z.literal('native-email-outbox'),outbox_id:uuid,operation_id:uuid}),
 z.strictObject({...base,job_name:z.literal('native-email-sent-copy'),outbox_id:uuid,operation_id:uuid}),
 z.strictObject({...base,job_name:z.literal('native-email-draft-sync'),draft_id:uuid,revision:counter,mode:z.enum(['sync','reconcile']).optional(),generation:counter.optional()}),
 z.strictObject({...base,job_name:z.literal('native-email-draft-cleanup'),draft_id:uuid,revision:counter,operation_id:uuid,mode:z.enum(['delete','reconcile']),generation:counter}),
 z.strictObject({...base,job_name:z.literal('native-email-timers'),timer_id:uuid,revision:counter}),
 z.strictObject({...base,job_name:z.literal('native-email-notification-dispatch'),notification_id:uuid,revision:counter,authority_revision:counter}),
]);
function denied():never{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');}
const stamp=(value:Date|null|undefined)=>value instanceof Date?value.getTime():NaN;
type Database=Pick<typeof db,'transaction'>;
/** Standalone SQL admission: only native consent, current human owner, exact
 * SID/queue lease. Connected custody still wraps this SQL-only authority. No
 * App installation/grant/operator graph, Experience expiry or AI grant is read. */
export class PostgresEmailAccountAuthority implements EmailAuthority{
 private readonly held=new WeakMap<object,{principal:string;lastAccount:string;bridges:Map<string,string>}>();
 constructor(private readonly database:Database,private readonly store:PostgresEmailAccountConsentStore,private readonly now=Date.now){}
 async current(rawActor:EmailActor,rawScope:EmailScope,operation:EmailOperation,transaction?:unknown,signal?:AbortSignal):Promise<EmailCapability>{
  const actor=actorSchema.safeParse(rawActor),scope=scopeSchema.safeParse(rawScope);
  if(!actor.success||!scope.success||actor.data.user_id!==scope.data.owner_user_id||!['human_read','human_sync','human_draft','human_modify','human_send'].includes(operation))denied();
  return this.run(scope.data,actor.data,operation,null,transaction,signal);
 }
 async currentService(rawScope:EmailScope,rawLease:EmailServiceLease,transaction?:unknown,signal?:AbortSignal):Promise<EmailCapability>{
  const scope=scopeSchema.safeParse(rawScope),lease=leaseSchema.safeParse(rawLease);if(!scope.success||!lease.success)denied();
  if(lease.data.job_name==='native-email-draft-sync'&&lease.data.mode==='reconcile'&&!lease.data.generation)denied();
  const operation=lease.data.job_name==='native-email-outbox'?'human_send':['native-email-draft-sync','native-email-draft-cleanup'].includes(lease.data.job_name??'')?'human_modify':'human_read';
  return this.run(scope.data,null,operation,lease.data as EmailServiceLease,transaction,signal);
 }
 private async run(scope:EmailScope,actor:EmailActor|null,operation:EmailOperation,lease:EmailServiceLease|null,transaction?:unknown,signal?:AbortSignal){
  const work=async(tx:EmailAccountConsentTransaction):Promise<EmailCapability>=>{
   signal?.throwIfAborted();const principal=canonicalCapabilityJson([scope.org_id,scope.owner_user_id,actor?['human',actor.user_id,actor.web_session_id]:['service',lease]]),prior=this.held.get(tx);
   if(prior&&(prior.principal!==principal||!prior.bridges.has(scope.account_id)&&scope.account_id<prior.lastAccount))denied();
   // Password/session revocation locks users -> memberships -> sessions. Take
   // the user before membership, then native account -> consent -> exact SID
   // or lease. Each current call is fresh; held rows are not allow decisions.
   const [user]=await tx.select({kind:users.kind,is_agent:users.is_agent}).from(users).where(eq(users.id,scope.owner_user_id)).for('share').limit(1);
   const [membership]=await tx.select({org_id:orgMembers.org_id,user_id:orgMembers.user_id,role:orgMembers.role,active:orgMembers.is_active,authorization_version:orgMembers.app_run_authorization_version}).from(orgMembers)
    .where(and(eq(orgMembers.org_id,scope.org_id),eq(orgMembers.user_id,scope.owner_user_id))).for('share').limit(1);
   signal?.throwIfAborted();
   if(!membership||!user||membership.active!==true||!['owner','admin','member'].includes(membership.role)||user.kind!=='human'||user.is_agent
    ||!Number.isSafeInteger(membership.authorization_version)||membership.authorization_version<1)denied();
   const member={...membership,...user};
   const [account]=await tx.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).for('share').limit(1);
   const [row]=await tx.select().from(emailAccountConsents).where(and(eq(emailAccountConsents.org_id,scope.org_id),eq(emailAccountConsents.owner_user_id,scope.owner_user_id),eq(emailAccountConsents.account_id,scope.account_id))).for('share').limit(1);
   signal?.throwIfAborted();
   if(!account||!row||account.state!=='active'||account.revoked_at!==null||!account.consented_at||!/^[a-f0-9]{64}$/u.test(account.principal_digest??'')
    ||account.provider!==row.provider||account.principal_digest!==row.principal_digest||account.authority_revision<row.native_revision)denied();
   const [session]=actor?await tx.select().from(webSessions).where(and(eq(webSessions.id,actor.web_session_id),eq(webSessions.org_id,scope.org_id),eq(webSessions.user_id,scope.owner_user_id))).for('share').limit(1):[];
   const [job]=lease?await tx.select().from(jobQueue).where(and(eq(jobQueue.id,lease.job_id),eq(jobQueue.org_id,scope.org_id))).for('share').limit(1):[];
   if(actor?(!session||session.revoked_at!==null):(!job||!lease||!this.validJob(scope,lease,job,account)))denied();
   const consent=this.store.decode(row);requireEmailAccountConsent(consent,scope,operation);
   // No external I/O occurs after the final principal lock. All admission rows
   // remain SHARE-locked until the transaction ends; time and cancellation are
   // sampled after every wait and again immediately before returning.
   const live=()=>{signal?.throwIfAborted();const checked=this.now(),expires=Math.min(actor?.access_expires_at??Infinity,stamp(actor?session?.expires_at:job?.lock_expires_at));
    if(!Number.isFinite(checked)||!Number.isFinite(expires)||expires<=checked||!Number.isFinite(stamp(account.consented_at))||stamp(account.consented_at)>checked)denied();};
   live();
   if(account.resource_binding_id!==emailAccountBridgeBindingId(consent.bridge)||(account.credential_source??'retained_registry_v1')!==consent.bridge.kind)denied();
   const bridge=canonicalCapabilityJson(consent.bridge);if(prior?.bridges.has(scope.account_id)&&prior.bridges.get(scope.account_id)!==bridge)denied();
   const held=prior??{principal,lastAccount:scope.account_id,bridges:new Map<string,string>()};held.lastAccount=held.lastAccount>scope.account_id?held.lastAccount:scope.account_id;held.bridges.set(scope.account_id,bridge);this.held.set(tx,held);
   live();return Object.freeze({scope:Object.freeze({...scope}),resource_binding_id:emailAccountBridgeBindingId(consent.bridge),
    authority_version:createHash('sha256').update(canonicalCapabilityJson({scope,account_revision:account.authority_revision,consent_revision:consent.revision,principal_digest:account.principal_digest,bridge:consent.bridge,capabilities:consent.capabilities,member})).digest('hex'),
    expires_at:Math.min(actor?.access_expires_at??Infinity,stamp(actor?session?.expires_at:job?.lock_expires_at))});
  };
  if(transaction!==undefined)return work(transaction as EmailAccountConsentTransaction);return this.database.transaction(work);
 }
 private validJob(scope:EmailScope,lease:EmailServiceLease,job:typeof jobQueue.$inferSelect,account:typeof emailAccounts.$inferSelect){
  const p=job.data as Record<string,unknown>,name=lease.job_name??'native-email-sync';
  if(job.name!==name||job.queue!=='scheduled-jobs'||job.status!=='running'||job.lock_token!==lease.lock_token||!id.safeParse(job.locked_by).success
   ||!p||p.org_id!==scope.org_id||p.owner_user_id!==scope.owner_user_id||p.account_id!==scope.account_id||p.authority_revision!==account.authority_revision)return false;
  if(lease.job_name==='native-email-outbox'||lease.job_name==='native-email-sent-copy')return p.outbox_id===lease.outbox_id&&p.operation_id===lease.operation_id
   &&(lease.job_name!=='native-email-sent-copy'||account.provider==='imap_smtp'&&typeof p.mime_digest==='string'&&/^[a-f0-9]{64}$/u.test(p.mime_digest));
  if(lease.job_name==='native-email-draft-sync')return account.provider_draft_sync_enabled&&p.draft_id===lease.draft_id&&p.revision===lease.revision&&(p.mode??'sync')===(lease.mode??'sync')&&(lease.mode!=='reconcile'||p.generation===lease.generation);
  if(lease.job_name==='native-email-draft-cleanup')return p.draft_id===lease.draft_id&&p.revision===lease.revision&&p.operation_id===lease.operation_id&&p.mode===lease.mode&&p.generation===lease.generation;
  if(lease.job_name==='native-email-notification-dispatch')return p.notification_id===lease.notification_id&&p.revision===lease.revision&&p.authority_revision===lease.authority_revision&&lease.authority_revision===account.authority_revision;
  if(lease.job_name==='native-email-knowledge')return p.policy_revision===lease.policy_revision;
  if(lease.job_name==='native-email-timers')return p.timer_id===lease.timer_id&&p.revision===lease.revision;return true;
 }
}
