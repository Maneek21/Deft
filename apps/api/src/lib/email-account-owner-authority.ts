import {createHash} from 'node:crypto';
import {assertNativeAccountAvailable} from './email-native-adoption-gate.js';
import {and,eq} from 'drizzle-orm';
import {emailAccounts,orgMembers,users,webSessions} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import type {db} from './db.js';
import {EmailMailboxError,type EmailActor,type EmailScope,type EmailCapability} from './email-mailbox-service.js';
import {PostgresEmailAccountConsentStore,type EmailAccountConsentGuard,type EmailAccountConsentTransaction} from './email-account-consent-store.js';
import type {EmailAccountConsent} from './email-account-lifecycle.js';
const id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const actorSchema=z.strictObject({user_id:id,web_session_id:id,access_expires_at:z.number().finite()});
const scopeSchema=z.strictObject({org_id:id,owner_user_id:id,account_id:id});
function deny():never{throw new EmailMailboxError('EMAIL_ACCESS_DENIED');}
export type EmailAccountOwnerSnapshot=Readonly<{account:typeof emailAccounts.$inferSelect;consent:EmailAccountConsent|null;capability:EmailCapability}>;
/** Owner management authority deliberately has no content/provider effect grant.
 * It admits lifecycle metadata even after a mailbox is stopped or its former
 * App grant expires. Exact current SID, human membership and scope stay fresh. */
export class EmailAccountOwnerAuthority{
 constructor(private readonly database:Pick<typeof db,'transaction'>,private readonly store:PostgresEmailAccountConsentStore,private readonly now=Date.now){}
 guard(rawActor:EmailActor,rawScope:EmailScope,signal?:AbortSignal):EmailAccountConsentGuard{
  const actor=actorSchema.parse(rawActor),scope=scopeSchema.parse(rawScope);if(actor.user_id!==scope.owner_user_id)deny();
  const held=new WeakMap<object,string>();
  return async(selected,tx,phase)=>{
   signal?.throwIfAborted();if(canonicalCapabilityJson(selected)!==canonicalCapabilityJson(scope))deny();await assertNativeAccountAvailable(tx,scope);
   const memberQuery=tx.select({role:orgMembers.role,active:orgMembers.is_active,version:orgMembers.app_run_authorization_version}).from(orgMembers).where(and(eq(orgMembers.org_id,scope.org_id),eq(orgMembers.user_id,scope.owner_user_id))).limit(1);
   const [member]=await(phase==='owner'?memberQuery.for('share'):memberQuery),[user]=await tx.select({kind:users.kind,agent:users.is_agent}).from(users).where(eq(users.id,scope.owner_user_id)).limit(1);
   if(!member||!user||!member.active||!['owner','admin','member'].includes(member.role)||user.kind!=='human'||user.agent||!Number.isSafeInteger(member.version)||member.version<1)deny();
   const fingerprint=canonicalCapabilityJson({...member,...user});if(phase==='owner')held.set(tx,fingerprint);else if(held.get(tx)!==fingerprint)deny();
   if(phase==='owner')return;
   const query=tx.select().from(webSessions).where(and(eq(webSessions.id,actor.web_session_id),eq(webSessions.org_id,scope.org_id),eq(webSessions.user_id,scope.owner_user_id))).limit(1);
   const [session]=await(phase==='principal'?query.for('share'):query);if(!session||session.revoked_at||session.expires_at.getTime()<=this.now()||actor.access_expires_at<=this.now())deny();signal?.throwIfAborted();
  };
 }
 async inspect(actor:EmailActor,scope:EmailScope,signal?:AbortSignal,transaction?:EmailAccountConsentTransaction):Promise<EmailAccountOwnerSnapshot>{
  const guard=this.guard(actor,scope,signal),work=async(tx:EmailAccountConsentTransaction)=>{
   const consent=await this.store.read(scope,guard,signal,tx),[account]=await tx.select().from(emailAccounts).where(and(eq(emailAccounts.org_id,scope.org_id),eq(emailAccounts.owner_user_id,scope.owner_user_id),eq(emailAccounts.account_id,scope.account_id))).limit(1);
   if(!account||!account.consented_at||!account.principal_digest||!/^[a-f0-9]{64}$/u.test(account.principal_digest))deny();await guard(scope,tx,'final');
   return {account,consent,capability:Object.freeze({scope:{...scope},resource_binding_id:account.resource_binding_id,
    authority_version:createHash('sha256').update(canonicalCapabilityJson({scope,revision:account.authority_revision,state:account.state,principal:account.principal_digest,consent_revision:consent?.revision??0})).digest('hex'),expires_at:actor.access_expires_at})};
  };return transaction?work(transaction):this.database.transaction(work);
 }
}
