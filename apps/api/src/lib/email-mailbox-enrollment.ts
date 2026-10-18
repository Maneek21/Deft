import {legacyNativeEntry} from './email-native-adapter-contract.js';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { appResourceBindings, emailAccounts, emailCheckpoints, emailMessages, emailProviderStates, emailSyncReceipts, emailImapCredentials, orgMembers, users, webSessions } from '@deft/db/schema';
import type { EmailAuthorityDatabase } from './email-mailbox-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';
import type { loadLiveAttachmentSyncBindingAuthority, LiveAttachmentSyncBindingAuthority } from './app-attachment-sync-authority.js';
import type { AppConnectionRegistry } from './app-connection-registry.js';
import type {NativeEmailAccount, NativeEmailConnectionContext} from './email-native-adapter-contract.js';
import { EmailMailboxError, type EmailActor, type EmailScope } from './email-mailbox-service.js';
import {EmailImapCredentialCustody,EmailImapSetupProfileSchema,type EmailImapCredentialRecord} from './email-imap-custody.js';
import type {AppRunKeyProvider} from './app-run-keyrings.js';
import {verifyEmailImapSetup} from './email-imap-setup-probe.js';
import {getRegisteredEmailImapConstructors} from './email-imap-runtime.js';

export type EmailAccountNomination = Readonly<{ account_id: string; resource_binding_id: string }>;
export type EmailEnrollmentResult = Readonly<{ account_id: string; provider: NativeEmailAccount['provider']; state: 'active'; authority_revision: number }>;
type BindingLoader = typeof loadLiveAttachmentSyncBindingAuthority;
type Registry = Pick<AppConnectionRegistry, 'select'>;
type ImapVerifier=(input:Omit<Parameters<typeof verifyEmailImapSetup>[0],'constructors'|'lookup'|'now'>)=>ReturnType<typeof verifyEmailImapSetup>;
const deny = (): never => { throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); };
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value);
const time = (value: unknown) => value instanceof Date ? value.getTime() : NaN;
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const accountWhere = (scope: EmailScope) => and(eq(emailAccounts.org_id, scope.org_id),
  eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id));
const bindingWhere = (org: string, binding: string) => and(eq(appResourceBindings.org_id, org), eq(appResourceBindings.id, binding));
// Never include checked_at: a fresh successful check must preserve graph identity.
const graphDigest = (live: LiveAttachmentSyncBindingAuthority) => digest({ installation: live.installation,
  version: live.version, grant: live.grant, registration: live.registration, binding: live.binding,
  descriptor_digest: live.descriptor_digest, provider_snapshot: live.provider_snapshot });
const sameLocator = (a: typeof appResourceBindings.$inferSelect, b: typeof appResourceBindings.$inferSelect) =>
  ['id', 'org_id', 'owner_user_id', 'app_installation_id', 'runtime_registration_id', 'target_key', 'resource_key'].every(key =>
    a[key as keyof typeof a] === b[key as keyof typeof b]);

/** Explicit adoption of existing reviewed owner custody. No enrollment is
 * inferred from mailbox reads, registry presence, or an Experience session. */
export class PostgresEmailMailboxEnrollment {
  private readonly now: () => Date;
  private readonly loadBinding: BindingLoader;
  private readonly getRegistry: () => Promise<Registry>;
  private readonly verifyImap:ImapVerifier;
  constructor(private readonly database: EmailAuthorityDatabase,
    options: { now?: () => Date; loadBinding?: BindingLoader; getRegistry?: () => Promise<Registry>;verifyImap?:ImapVerifier } = {}) {
    this.now = options.now ?? (() => new Date());
    this.loadBinding = options.loadBinding ?? (async (tx, input) =>
      (await import('./app-attachment-sync-authority.js')).loadLiveAttachmentSyncBindingAuthority(tx, input));
    this.getRegistry = options.getRegistry ?? (async () => (await import('./app-connection-registry.js')).getAppConnectionRegistry());
    this.verifyImap=options.verifyImap??(input=>verifyEmailImapSetup({...input,constructors:getRegisteredEmailImapConstructors(input.pins)}));
  }
  async adopt(actor: EmailActor, orgId: string, nomination: EmailAccountNomination, signal?: AbortSignal): Promise<EmailEnrollmentResult> {
    return this.enroll(actor,orgId,nomination,signal);
  }
  /** First-party account setup: authenticate before saving an encrypted profile.
   * The same enrollment transaction owns both the native row and credential CAS;
   * browser input cannot choose constructors, keys or claim verified_at. */
  async setupImap(actor:EmailActor,orgId:string,nomination:EmailAccountNomination,profile:unknown,expectedRevision:number,
    keys:AppRunKeyProvider,signal?:AbortSignal):Promise<EmailEnrollmentResult>{
    const parsed=EmailImapSetupProfileSchema.parse(profile);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=2147483646)return deny();
    try{return await this.enroll(actor,orgId,nomination,signal,{profile:parsed,expectedRevision,keys});}
    finally{parsed.password='';if(parsed.smtp)parsed.smtp.password='';}
  }
  private async enroll(actor:EmailActor,orgId:string,nomination:EmailAccountNomination,signal?:AbortSignal,
    imapSetup?:{profile:unknown;expectedRevision:number;keys:AppRunKeyProvider}):Promise<EmailEnrollmentResult>{
    signal?.throwIfAborted();
    if (!actor || !nomination || ![actor.user_id, actor.web_session_id, orgId, nomination.account_id, nomination.resource_binding_id].every(id)
      || !Number.isFinite(actor.access_expires_at)) return deny();
    actor = Object.freeze({ user_id: actor.user_id, web_session_id: actor.web_session_id, access_expires_at: actor.access_expires_at });
    nomination = Object.freeze({ account_id: nomination.account_id, resource_binding_id: nomination.resource_binding_id });
    const scope: EmailScope = Object.freeze({ org_id: orgId, owner_user_id: actor.user_id, account_id: nomination.account_id });
    return this.database.transaction(async tx => {
      const [locator] = await tx.select().from(appResourceBindings).where(bindingWhere(orgId, nomination.resource_binding_id)).limit(1);
      if (!locator || locator.org_id !== orgId || locator.owner_user_id !== actor.user_id || locator.id !== nomination.resource_binding_id) return deny();
      const live = await this.loadBinding(tx, { org_id: orgId, resource_binding_id: locator.id, clock: this.now });
      if (!live || !sameLocator(locator, live.binding) || live.installation.id !== locator.app_installation_id
        || live.installation.org_id !== orgId || live.registration.org_id !== orgId) return deny();
      const participants = [...new Set([actor.user_id, live.registration.operator_user_id])].sort();
      const graph = graphDigest(live);
      // A transaction-scoped account lock also covers a row that does not exist.
      // Hash collisions only serialize unrelated accounts; they never authorize.
      const scopeLock = BigInt.asIntN(64, BigInt(`0x${digest([orgId, actor.user_id, nomination.account_id]).slice(0, 16)}`)).toString();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${scopeLock}::bigint)`);
      signal?.throwIfAborted();
      const [existing] = await tx.select().from(emailAccounts).where(accountWhere(scope)).limit(1).for('update');
      if (existing && (existing.org_id !== orgId || existing.owner_user_id !== actor.user_id || existing.account_id !== scope.account_id
        || !Number.isSafeInteger(existing.authority_revision) || existing.authority_revision < 1 || existing.authority_revision >= 2147483647
        || !['active', 'paused', 'disconnected', 'revoked'].includes(existing.state)
        || existing.principal_digest !== null && !/^[a-f0-9]{64}$/u.test(existing.principal_digest)
        || existing.state === 'active' && !existing.principal_digest
        || existing.principal_digest === null && existing.resource_binding_id !== locator.id)) return deny();
      let previousBinding: typeof appResourceBindings.$inferSelect | undefined;
      if (existing && existing.resource_binding_id !== locator.id) {
        [previousBinding] = await tx.select().from(appResourceBindings).where(bindingWhere(orgId, existing.resource_binding_id)).limit(1);
        if (!previousBinding || previousBinding.owner_user_id !== actor.user_id
          || previousBinding.app_installation_id !== live.installation.id) return deny();
      }
      // SID is the last new row lock; rechecks below only reacquire held locks.
      await tx.select({ id: webSessions.id }).from(webSessions).where(and(eq(webSessions.id, actor.web_session_id),
        eq(webSessions.org_id, orgId), eq(webSessions.user_id, actor.user_id))).limit(1).for('share');
      const initialAccount = existing ? digest(existing) : null;
      let expectedAccountDigest = initialAccount;
      const assertUnverifiedPlaceholderEmpty = async () => {
        if (!existing || existing.principal_digest !== null) return;
        // Include tombstones: unknown cached identity must never acquire a new
        // principal. These are nonlocking reads under the held account lock.
        const scoped = (table: typeof emailMessages | typeof emailSyncReceipts | typeof emailProviderStates | typeof emailCheckpoints) =>
          and(eq(table.org_id, scope.org_id), eq(table.owner_user_id, scope.owner_user_id), eq(table.account_id, scope.account_id));
        const messages = await tx.select({ id: emailMessages.logical_message_id }).from(emailMessages).where(scoped(emailMessages)).limit(1);
        const receipts = await tx.select({ id: emailSyncReceipts.page_id }).from(emailSyncReceipts).where(scoped(emailSyncReceipts)).limit(1);
        const states = await tx.select({ id: emailProviderStates.state_key }).from(emailProviderStates).where(scoped(emailProviderStates)).limit(1);
        const checkpoints = await tx.select({ revision: emailCheckpoints.revision }).from(emailCheckpoints).where(scoped(emailCheckpoints)).limit(1);
        if (messages.length || receipts.length || states.length || checkpoints.some(c => c.revision !== 0)) return deny();
      };
      const checkHuman = async () => {
        const [session] = await tx.select().from(webSessions).where(and(eq(webSessions.id, actor.web_session_id),
          eq(webSessions.org_id, orgId), eq(webSessions.user_id, actor.user_id))).limit(1);
        const members = await tx.select({ org_id: orgMembers.org_id, user_id: orgMembers.user_id, role: orgMembers.role,
          active: orgMembers.is_active, version: orgMembers.app_run_authorization_version, kind: users.kind, is_agent: users.is_agent })
          .from(orgMembers).innerJoin(users, eq(users.id, orgMembers.user_id)).where(and(eq(orgMembers.org_id, orgId), inArray(orgMembers.user_id, participants)));
        signal?.throwIfAborted();
        const now = time(this.now()), expires = Math.min(actor.access_expires_at, time(session?.expires_at), time(live.binding.consent_expires_at));
        if (!session || session.id !== actor.web_session_id || session.org_id !== orgId || session.user_id !== actor.user_id
          || session.revoked_at !== null || !Number.isFinite(now) || !Number.isFinite(expires) || expires <= now
          || !Number.isFinite(time(live.binding.reviewed_at)) || time(live.binding.reviewed_at) > now
          || !participants.every(userId => members.some(m => m.org_id === orgId && m.user_id === userId && m.active === true
            && m.kind === 'human' && m.is_agent === false && ['owner', 'admin', 'member'].includes(m.role)
            && Number.isSafeInteger(m.version) && m.version > 0))) return deny();
        return { expires, members: members.sort((a, b) => a.user_id.localeCompare(b.user_id)) };
      };
      const human = await checkHuman(), memberDigest = digest(human.members);
      const recheck = async () => {
        // A changed locator must never cause the helper to acquire new ancestry.
        const [currentLocator] = await tx.select().from(appResourceBindings).where(bindingWhere(orgId, locator.id)).limit(1);
        if (!currentLocator || !sameLocator(live.binding, currentLocator)) return deny();
        const current = await this.loadBinding(tx, { org_id: orgId, resource_binding_id: locator.id,
          clock: this.now, prelocked_participant_ids: participants });
        if (!current || graphDigest(current) !== graph) return deny();
        const [account] = await tx.select().from(emailAccounts).where(accountWhere(scope)).limit(1);
        if ((account ? digest(account) : null) !== expectedAccountDigest) return deny();
        await assertUnverifiedPlaceholderEmpty();
        if (previousBinding) {
          const [prior] = await tx.select().from(appResourceBindings).where(bindingWhere(orgId, previousBinding.id)).limit(1);
          if (!prior || !sameLocator(previousBinding, prior) || prior.app_installation_id !== live.installation.id) return deny();
        }
        if (digest((await checkHuman()).members) !== memberDigest) return deny();
      };
      const entry = legacyNativeEntry((await this.getRegistry()).select({ org_id: orgId, owner_user_id: actor.user_id,
        installation_id: live.installation.id, target_key: live.binding.target_key }));
      const pins = entry.pins, binding = live.binding;
      if (pins.org_id !== orgId || pins.owner_user_id !== actor.user_id || pins.installation_id !== live.installation.id
        || pins.app_version_id !== binding.app_version_id || pins.grant_snapshot_id !== binding.grant_snapshot_id
        || pins.target_key !== binding.target_key || pins.resource_key !== binding.resource_key
        || pins.resource_binding_id !== binding.id || typeof entry.adapter.nativeEmailAccount !== 'function') return deny();
      const context: NativeEmailConnectionContext = Object.freeze({ ...scope, installation_id: live.installation.id,
        resource_binding_id: binding.id, authority_version: digest({ graph, members: human.members, native: initialAccount }),
        expires_at: human.expires, recheck, signal });
      await recheck();
      let account: NativeEmailAccount;
      let pendingCredential:EmailImapCredentialRecord|undefined;
      if(imapSetup){
        if(existing&&existing.provider!=='imap_smtp')return deny();
        const [currentCredential]=await tx.select().from(emailImapCredentials).where(and(
          eq(emailImapCredentials.org_id,orgId),eq(emailImapCredentials.owner_user_id,actor.user_id),eq(emailImapCredentials.account_id,scope.account_id))).limit(1);
        if((currentCredential?.connection_revision??0)!==imapSetup.expectedRevision)return deny();
        const verified={...await this.verifyImap({context,pins,profile:imapSetup.profile,keys:imapSetup.keys})};
        try{
          const custody=new EmailImapCredentialCustody(imapSetup.keys,{
            read:async()=>currentCredential?{schema_version:'deft.email.imap.credentials.v1',...scope,
              principal_digest:currentCredential.principal_digest,connection_revision:currentCredential.connection_revision,
              envelope:currentCredential.envelope as EmailImapCredentialRecord['envelope']}:null,
            compareAndSwap:async input=>{await recheck();if(input.expected_revision!==imapSetup.expectedRevision)return false;pendingCredential=input.record;return true;},
          });
          const saved=await custody.saveProfile(scope,imapSetup.expectedRevision,verified,recheck,signal);
          account={account_id:scope.account_id,resource_binding_id:binding.id,provider:'imap_smtp',principal_digest:saved.principal_digest,
            authority_epoch:existing?existing.authority_revision+1:1,connection_revision:saved.connection_revision,health:'connected',
            capabilities:['read',...(pins.action_binding_id?['modify' as const]:[]),...(verified.smtp?['send' as const]:[])],
            primary_address:verified.identity!.primary_address,display_label:verified.identity!.display_label};
        }finally{verified.password='';if(verified.smtp)verified.smtp.password='';}
      }else{
        try { account = await entry.adapter.nativeEmailAccount(context); } finally { await recheck(); }
      }
      if (!account || account.account_id !== scope.account_id || account.resource_binding_id !== binding.id
        || !['gmail', 'microsoft', 'imap_smtp'].includes(account.provider) || account.health !== 'connected'
        || !Array.isArray(account.capabilities) || !account.capabilities.includes('read')
        || !Number.isSafeInteger(account.authority_epoch) || account.authority_epoch < 1
        || !Number.isSafeInteger(account.connection_revision) || account.connection_revision < 0
        || !/^[a-f0-9]{64}$/u.test(account.principal_digest)
        || existing && (existing.provider !== account.provider || existing.principal_digest !== null && existing.principal_digest !== account.principal_digest)) return deny();
      const now = this.now(), revision = existing ? existing.authority_revision + 1 : 1;
      const values = { provider: account.provider, principal_digest: account.principal_digest, resource_binding_id: binding.id,
        state: 'active' as const, authority_revision: revision, consented_at: binding.reviewed_at!, revoked_at: null, updated_at: now };
      signal?.throwIfAborted();
      if (existing) await tx.update(emailAccounts).set(values).where(accountWhere(scope));
      else await tx.insert(emailAccounts).values({ ...scope, ...values, provider_draft_sync_enabled:false, created_at: now });
      expectedAccountDigest = digest(existing ? { ...existing, ...values } : { ...scope, ...values, provider_draft_sync_enabled:false, created_at: now });
      if(pendingCredential){
        const {schema_version:_schema,...record}=pendingCredential;
        await tx.insert(emailImapCredentials).values({...record,updated_at:now}).onConflictDoUpdate({
          target:[emailImapCredentials.org_id,emailImapCredentials.owner_user_id,emailImapCredentials.account_id],
          set:{principal_digest:record.principal_digest,connection_revision:record.connection_revision,envelope:record.envelope,updated_at:now},
        });
      }
      await recheck();
      // No checkpoint, ciphertext, message, draft or journal is modified here.
      return Object.freeze({ account_id: scope.account_id, provider: account.provider, state: 'active' as const, authority_revision: revision });
    });
  }
}
