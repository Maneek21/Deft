import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { appResourceBindings, emailAccounts, orgMembers, users, webSessions, jobQueue } from '@deft/db/schema';
import type { db } from './db.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { loadLiveAttachmentSyncBindingAuthority, LiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import { EmailMailboxError, type EmailActor, type EmailAuthority, type EmailCapability,
  type EmailOperation, type EmailScope } from './email-mailbox-service.js';
import {profileEmailSearchPhase} from './email-search-diagnostics.js';

export type EmailAuthorityDatabase = Pick<typeof db, 'transaction'>;
export type EmailServiceLease = Readonly<{job_id:string;lock_token:string} & (
  {job_name?:'native-email-sync'} | {job_name:'native-email-knowledge';policy_revision:number} | {job_name:'native-email-draft-sync';draft_id:string;revision:number;mode?:'sync'|'reconcile';generation?:number}
  |{job_name:'native-email-draft-cleanup';draft_id:string;revision:number;operation_id:string;mode:'delete'|'reconcile';generation:number}
  |{job_name:'native-email-outbox';outbox_id:string;operation_id:string}
  |{job_name:'native-email-timers';timer_id:string;revision:number}
  |{job_name:'native-email-sent-copy';outbox_id:string;operation_id:string}
  |{job_name:'native-email-notification-dispatch';notification_id:string;revision:number;authority_revision:number})>;
type BindingLoader = typeof loadLiveAttachmentSyncBindingAuthority;
type Fence = Readonly<{ bindingId: string; participants: readonly string[]; ancestry: string;
  installationId: string; registrationId: string; targetKey: string; resourceKey: string }>;
const denied = (): never => { throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); };
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/u.test(value);
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const milliseconds = (value: unknown) => value instanceof Date ? value.getTime() : NaN;
const accountWhere = (scope: EmailScope) => and(eq(emailAccounts.org_id, scope.org_id),
  eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id));
const ancestry = (live: LiveAttachmentSyncBindingAuthority) => digest({
  org: live.binding.org_id, owner: live.binding.owner_user_id, installation: live.installation.id,
  registration: live.registration.id, operator: live.registration.operator_user_id,
  binding: live.binding.id, target: live.binding.target_key,
});

/** Transitional human/account-service bridge. Native consent does not widen the existing
 * reviewed binding. The helper reconstructs and locks the live legacy graph;
 * no Experience lease, operator JWT or AI disclosure grant confers access. */
export class PostgresEmailMailboxAuthority implements EmailAuthority {
  private readonly now: () => Date;
  private readonly loadBinding: BindingLoader;
  // Denial fences only: every invocation still reads the current graph/session.
  // A second commit guard must not follow a changed locator into new locks.
  private readonly fences = new WeakMap<object, Map<string, Fence>>();
  constructor(private readonly database: EmailAuthorityDatabase,
    options: { now?: () => Date; loadBinding?: BindingLoader } = {}) {
    this.now = options.now ?? (() => new Date());
    this.loadBinding = options.loadBinding ?? (async (tx, input) =>
      (await import('./app-attachment-sync-authority.js')).loadLiveAttachmentSyncBindingAuthority(tx, input));
  }
  async current(actor: EmailActor, scope: EmailScope, operation: EmailOperation,
    transaction?: unknown, signal?: AbortSignal): Promise<EmailCapability> {
    signal?.throwIfAborted();
    if (![scope.org_id, scope.owner_user_id, scope.account_id, actor.user_id, actor.web_session_id].every(id)
      || actor.user_id !== scope.owner_user_id || !Number.isFinite(actor.access_expires_at)
      || !['human_read', 'human_sync', 'human_draft', 'human_modify', 'human_send'].includes(operation)) return denied();
    return profileEmailSearchPhase('authority_sql_pass',()=>transaction !== undefined
      ? this.check(transaction as AppRunTransaction, actor, scope, signal)
      : this.database.transaction(tx => this.check(tx, actor, scope, signal)));
  }
  /** Background read/sync authority is the currently leased, scoped queue job
   * plus current account consent. It does not manufacture a human SID/JWT. */
  async currentService(scope:EmailScope,lease:EmailServiceLease,transaction?:unknown,signal?:AbortSignal):Promise<EmailCapability> {
    signal?.throwIfAborted();
    if(![scope.org_id,scope.owner_user_id,scope.account_id,lease.job_id,lease.lock_token].every(id))return denied();
    if(lease.job_name!==undefined&&!['native-email-sync','native-email-knowledge','native-email-draft-sync','native-email-outbox','native-email-draft-cleanup','native-email-sent-copy','native-email-timers','native-email-notification-dispatch'].includes(lease.job_name))return denied();
    if(lease.job_name==='native-email-draft-cleanup'&&(![lease.draft_id,lease.operation_id].every(value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value))
      ||!Number.isSafeInteger(lease.revision)||lease.revision<1||!Number.isSafeInteger(lease.generation)||lease.generation<1||!['delete','reconcile'].includes(lease.mode)))return denied();
    if((lease.job_name==='native-email-outbox'||lease.job_name==='native-email-sent-copy')&&![lease.outbox_id,lease.operation_id].every(value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)))return denied();
    if(lease.job_name==='native-email-timers'&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(lease.timer_id)
      ||!Number.isSafeInteger(lease.revision)||lease.revision<1||lease.revision>2147483646))return denied();
    if(lease.job_name==='native-email-notification-dispatch'&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(lease.notification_id)
      ||!Number.isSafeInteger(lease.revision)||lease.revision<1||lease.revision>2147483647
      ||!Number.isSafeInteger(lease.authority_revision)||lease.authority_revision<1||lease.authority_revision>2147483647))return denied();
    if(lease.job_name==='native-email-draft-sync'&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(lease.draft_id)
      ||!Number.isSafeInteger(lease.revision)||lease.revision<1||lease.revision>2147483647
      ||lease.mode!==undefined&&!['sync','reconcile'].includes(lease.mode)
      ||lease.mode==='reconcile'&&(!Number.isSafeInteger(lease.generation)||(lease.generation??0)<1)))return denied();
    const account=Object.freeze({...scope}),delivery=Object.freeze({...lease});
    if(transaction!==undefined)return this.check(transaction as AppRunTransaction,null,account,signal,delivery);
    return this.database.transaction(tx=>this.check(tx,null,account,signal,delivery));
  }
  private async check(tx: AppRunTransaction, actor: EmailActor|null, scope: EmailScope, signal?: AbortSignal, lease?:EmailServiceLease): Promise<EmailCapability> {
    if (!tx || typeof tx.select !== 'function' || typeof tx.execute !== 'function') return denied();
    const key = JSON.stringify([scope.org_id, scope.owner_user_id, scope.account_id,
      actor ? ['human',actor.user_id,actor.web_session_id] : ['service',lease]]);
    const held = this.fences.get(tx), existing = held?.get(key);
    if (held && !existing) return denied();
    // Locator only: taking a native lock here would invert legacy revocation's
    // participant -> App -> registration -> binding -> native account order.
    const [locator] = await tx.select({ resource_binding_id: emailAccounts.resource_binding_id })
      .from(emailAccounts).where(accountWhere(scope)).limit(1);
    if (!locator || !id(locator.resource_binding_id) || existing && locator.resource_binding_id !== existing.bindingId) return denied();
    if (existing) {
      const [bindingLocator] = await tx.select().from(appResourceBindings).where(and(eq(appResourceBindings.org_id, scope.org_id),
        eq(appResourceBindings.id, existing.bindingId))).limit(1);
      if (!bindingLocator || bindingLocator.org_id !== scope.org_id || bindingLocator.owner_user_id !== scope.owner_user_id
        || bindingLocator.app_installation_id !== existing.installationId || bindingLocator.runtime_registration_id !== existing.registrationId
        || bindingLocator.target_key !== existing.targetKey || bindingLocator.resource_key !== existing.resourceKey) return denied();
    }
    signal?.throwIfAborted();
    const live = await this.loadBinding(tx, { org_id: scope.org_id, resource_binding_id: locator.resource_binding_id,
      clock: this.now, ...(existing ? { prelocked_participant_ids: existing.participants } : {}) });
    if (!live || live.binding.id !== locator.resource_binding_id || live.binding.org_id !== scope.org_id
      || live.binding.owner_user_id !== scope.owner_user_id || live.installation.org_id !== scope.org_id
      || live.registration.org_id !== scope.org_id || existing && ancestry(live) !== existing.ancestry) return denied();
    const participants = [...new Set([scope.owner_user_id, live.registration.operator_user_id])].sort();
    // Native consent follows the complete legacy lock fence.
    const [account] = await tx.select().from(emailAccounts).where(accountWhere(scope)).limit(1).for('share');
    if (!account || account.org_id !== scope.org_id || account.owner_user_id !== scope.owner_user_id
      || account.account_id !== scope.account_id || account.resource_binding_id !== locator.resource_binding_id
      || account.state !== 'active' || account.revoked_at !== null || !account.consented_at
      || !/^[a-f0-9]{64}$/.test(account.principal_digest ?? '')
      || !['gmail', 'microsoft', 'imap_smtp'].includes(account.provider)
      || !Number.isSafeInteger(account.authority_revision) || account.authority_revision < 1) return denied();
    // Exact human web SID is the last new lock. Never lock users after members:
    // password revocation holds users -> members -> web sessions.
    const [session] = actor ? await tx.select({ id: webSessions.id, org_id: webSessions.org_id, user_id: webSessions.user_id,
      revoked_at: webSessions.revoked_at, expires_at: webSessions.expires_at }).from(webSessions)
      .where(and(eq(webSessions.id, actor.web_session_id), eq(webSessions.org_id, scope.org_id),
        eq(webSessions.user_id, actor.user_id))).limit(1).for('share') : [];
    // The queue lease is the service's final principal lock. Queue renewal never
    // acquires mailbox locks; domain commit releases it before worker settlement.
    const [job]=!actor && lease ? await tx.select().from(jobQueue).where(and(eq(jobQueue.id,lease.job_id),
      eq(jobQueue.org_id,scope.org_id))).limit(1).for('share') : [];
    const payload=job?.data as Record<string,unknown>|undefined;
    const principalValid=actor
      ? !!session && session.id===actor.web_session_id && session.org_id===scope.org_id && session.user_id===actor.user_id && session.revoked_at===null
      : !!job && !!lease && job.id===lease.job_id && job.org_id===scope.org_id && job.name===(lease.job_name??'native-email-sync')
        && job.queue==='scheduled-jobs' && job.status==='running' && job.lock_token===lease.lock_token && id(job.locked_by)
        && !!payload && payload.org_id===scope.org_id && payload.owner_user_id===scope.owner_user_id && payload.account_id===scope.account_id
        && payload.authority_revision===account.authority_revision
        && (lease.job_name!=='native-email-knowledge'||payload.policy_revision===lease.policy_revision)
        && (lease.job_name!=='native-email-draft-sync'||account.provider_draft_sync_enabled===true
          && payload.draft_id===lease.draft_id&&payload.revision===lease.revision
          && (payload.mode??'sync')===(lease.mode??'sync')&&(lease.mode!=='reconcile'||payload.generation===lease.generation))
        && (lease.job_name!=='native-email-outbox'||payload.outbox_id===lease.outbox_id&&payload.operation_id===lease.operation_id)
        && (lease.job_name!=='native-email-timers'||payload.timer_id===lease.timer_id&&payload.revision===lease.revision)
        && (lease.job_name!=='native-email-sent-copy'||account.provider==='imap_smtp'&&payload.outbox_id===lease.outbox_id&&payload.operation_id===lease.operation_id&&typeof payload.mime_digest==='string'&&/^[a-f0-9]{64}$/u.test(payload.mime_digest))
        && (lease.job_name!=='native-email-notification-dispatch'||payload.notification_id===lease.notification_id&&payload.revision===lease.revision
          &&payload.authority_revision===lease.authority_revision&&account.authority_revision===lease.authority_revision)
        && (lease.job_name!=='native-email-draft-cleanup'||account.provider_draft_sync_enabled===true&&payload.draft_id===lease.draft_id
          &&payload.revision===lease.revision&&payload.operation_id===lease.operation_id&&payload.mode===lease.mode&&payload.generation===lease.generation);
    const members = await tx.select({ org_id: orgMembers.org_id, user_id: orgMembers.user_id, role: orgMembers.role,
      active: orgMembers.is_active, authorization_version: orgMembers.app_run_authorization_version,
      kind: users.kind, is_agent: users.is_agent }).from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id))
      .where(and(eq(orgMembers.org_id, scope.org_id), inArray(orgMembers.user_id, participants)));
    signal?.throwIfAborted();
    const now = milliseconds(this.now()), expires = Math.min(actor?.access_expires_at ?? Infinity,
      milliseconds(actor ? session?.expires_at : job?.lock_expires_at), milliseconds(live.binding.consent_expires_at));
    if (!principalValid || !Number.isFinite(now) || !Number.isFinite(expires) || expires <= now
      || !Number.isFinite(milliseconds(account.consented_at)) || milliseconds(account.consented_at) > now
      || !participants.every(userId => members.some(member => member.org_id === scope.org_id && member.user_id === userId
        && member.active === true && member.kind === 'human' && member.is_agent === false
        && ['owner', 'admin', 'member'].includes(member.role)
        && Number.isSafeInteger(member.authorization_version) && member.authorization_version > 0))) return denied();
    const version = digest({ scope, native: { provider: account.provider, binding: account.resource_binding_id,
      revision: account.authority_revision, consented_at: account.consented_at, principal_digest:account.principal_digest,
      provider_draft_sync_enabled:account.provider_draft_sync_enabled },
      installation: { id: live.installation.id, version: live.installation.active_version_id,
        grant: live.installation.active_grant_snapshot_id, lifecycle_epoch: live.installation.lifecycle_epoch,
        grant_epoch: live.installation.grant_epoch },
      version: { id: live.version.id, manifest_digest: live.version.manifest_digest, package_digest: live.version.package_digest },
      grant: { id: live.grant.id, snapshot_digest: live.grant.snapshot_digest },
      registration: live.registration, binding: live.binding, descriptor_digest: live.descriptor_digest,
      provider: { id: live.provider_snapshot.id, provider_kind: live.provider_snapshot.provider_kind,
        provider_instance_id: live.provider_snapshot.provider_instance_id, snapshot_digest: live.provider_snapshot.snapshot_digest },
      participants: [...members].sort((a, b) => a.user_id.localeCompare(b.user_id)) });
    const fence = this.fences.get(tx) ?? new Map<string, Fence>();
    fence.set(key, { bindingId: account.resource_binding_id, participants, ancestry: ancestry(live),
      installationId: live.installation.id, registrationId: live.registration.id,
      targetKey: live.binding.target_key, resourceKey: live.binding.resource_key }); this.fences.set(tx, fence);
    return Object.freeze({ scope: Object.freeze({ ...scope }), resource_binding_id: account.resource_binding_id,
      authority_version: version, expires_at: expires });
  }
}
