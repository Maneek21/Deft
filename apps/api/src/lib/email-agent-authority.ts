import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { emailAgentGrants, emailAccounts, emailAccountConsents, mcpTokens, users, orgMembers, spaces, spaceMembers, agentEmployees,webSessions } from '@deft/db/schema';
import {isCanonicalDeftyEmployee} from './defty-identity.js';
import { EmailAgentActorSchema } from './email-agent-actor.js';
import { EmailMailboxError, type EmailAuthority, type EmailOperationActor, type EmailScope, type EmailOperation } from './email-mailbox-service.js';
import { requireEmailAccountConsent, emailAccountBridgeBindingId } from './email-account-lifecycle.js';
import { PostgresEmailAccountConsentStore } from './email-account-consent-store.js';
import type { db } from './db.js';
const deny = (): never => { throw new EmailMailboxError('EMAIL_ACCESS_DENIED'); };
export const emailAgentOperation = (op: EmailOperation) => op === 'human_send' ? 'send' : op === 'human_modify' ? 'triage' : op === 'human_draft' ? 'draft' : 'read';
/** Explicit reusable account delegation, independent of mailbox OAuth consent.
 * Membership -> account -> consent -> exact token -> grant lock order also
 * fences revocation during guarded draft/send commits. */
export class PostgresEmailAgentAuthority implements EmailAuthority {
  constructor(private readonly database: Pick<typeof db,'transaction'>, private readonly consents: PostgresEmailAccountConsentStore, private readonly now = Date.now) {}
  async current(raw: EmailOperationActor, scope: EmailScope, operation: EmailOperation, transaction?: unknown, signal?: AbortSignal) {
    if(process.env.DEFT_NATIVE_EMAIL_ENABLED!=='true')return deny();
    const parsed = EmailAgentActorSchema.safeParse(raw); if (!parsed.success) return deny(); const actor = parsed.data;
    if (actor.user_id !== scope.owner_user_id || actor.access_expires_at <= this.now() || operation === 'human_sync') return deny();
    const work = async (tx: any) => {
      signal?.throwIfAborted();
      const [user] = await tx.select().from(users).where(eq(users.id,scope.owner_user_id)).limit(1).for('share');
      const [member] = await tx.select().from(orgMembers).where(and(eq(orgMembers.org_id,scope.org_id),eq(orgMembers.user_id,scope.owner_user_id))).limit(1).for('share');
      if (!user || user.kind !== 'human' || user.is_agent || !member?.is_active || !['owner','admin','member'].includes(member.role)) return deny();
      const [account] = await tx.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1).for('share');
      const [consentRow] = await tx.select().from(emailAccountConsents).where(and(eq(emailAccountConsents.org_id,scope.org_id),eq(emailAccountConsents.owner_user_id,scope.owner_user_id),eq(emailAccountConsents.account_id,scope.account_id))).limit(1).for('share');
      if (!account || account.state !== 'active' || account.revoked_at !== null || !consentRow || account.provider !== consentRow.provider || account.principal_digest !== consentRow.principal_digest || account.authority_revision < consentRow.native_revision) return deny();
      const consent = this.consents.decode(consentRow); requireEmailAccountConsent(consent,scope,operation);
      if (account.resource_binding_id !== emailAccountBridgeBindingId(consent.bridge) || (account.credential_source ?? 'retained_registry_v1') !== consent.bridge.kind) return deny();
      let tokenVersion: number | null = null;
      if (actor.principal_kind === 'personal_mcp') {
        const [token] = await tx.select().from(mcpTokens).where(and(eq(mcpTokens.id,actor.principal_id),eq(mcpTokens.org_id,scope.org_id))).limit(1).for('share');
        if (!token || token.principal_kind !== 'human' || token.user_id !== scope.owner_user_id || token.revoked_at !== null || !actor.token_authorization_version || token.app_run_authorization_version!==actor.token_authorization_version) return deny();
        tokenVersion = token.app_run_authorization_version;
      } else {
        if(actor.principal_id!==scope.owner_user_id||!actor.conversation_id)return deny();
        const [space]=await tx.select().from(spaces).where(and(eq(spaces.id,actor.conversation_id),eq(spaces.org_id,scope.org_id),eq(spaces.type,'dm'),eq(spaces.is_archived,false))).limit(1).for('share');if(!space)return deny();
        const members=await tx.select({user_id:spaceMembers.user_id,is_agent:users.is_agent}).from(spaceMembers).innerJoin(users,eq(users.id,spaceMembers.user_id)).where(eq(spaceMembers.space_id,space.id));
        if(!members.some((m:any)=>m.user_id===scope.owner_user_id)||members.some((m:any)=>m.user_id!==scope.owner_user_id&&!m.is_agent))return deny();
        if(actor.employee_id){const [employee]=await tx.select().from(agentEmployees).where(and(eq(agentEmployees.id,actor.employee_id),eq(agentEmployees.org_id,scope.org_id))).limit(1).for('share');if(!isCanonicalDeftyEmployee(employee)||!employee?.is_active)return deny();}
      }
      const [grant] = await tx.select().from(emailAgentGrants).where(and(eq(emailAgentGrants.id,actor.agent_grant_id),eq(emailAgentGrants.org_id,scope.org_id),eq(emailAgentGrants.owner_user_id,scope.owner_user_id),eq(emailAgentGrants.account_id,scope.account_id),eq(emailAgentGrants.principal_kind,actor.principal_kind),eq(emailAgentGrants.principal_id,actor.principal_id))).limit(1).for('share');
      if(actor.review_session_id){
        const [reviewer]=await tx.select().from(webSessions).where(and(eq(webSessions.id,actor.review_session_id),eq(webSessions.org_id,scope.org_id),eq(webSessions.user_id,scope.owner_user_id))).limit(1).for('share');
        if(!reviewer||reviewer.revoked_at!==null||reviewer.expires_at.getTime()<=this.now()||!actor.review_expires_at||actor.review_expires_at<=this.now())return deny();
      }
      signal?.throwIfAborted();
      if (!grant || grant.revoked_at !== null || !grant.operations.includes(emailAgentOperation(operation)) || actor.access_expires_at <= this.now() || !Number.isFinite(this.now())) return deny();
      return Object.freeze({scope:Object.freeze({...scope}),resource_binding_id:account.resource_binding_id,
        authority_version:createHash('sha256').update(JSON.stringify({account:account.authority_revision,consent:consent.revision,bridge:consent.bridge,member:member.app_run_authorization_version,tokenVersion,grant:grant.id,revision:grant.revision,operations:grant.operations,review_session_id:actor.review_session_id})).digest('hex'),expires_at:Math.min(actor.access_expires_at,actor.review_expires_at??Infinity)});
    };
    return transaction !== undefined ? work(transaction) : this.database.transaction(work);
  }
}
