import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {emailAccounts,emailAccountConsents} from '@deft/db/schema';
import type {db} from './db.js';
import {canonicalCapabilityJson} from '@deft/shared';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailAccountBridgeSchema,EmailAccountConsentSchema,emailAccountBridgeBindingId,type EmailAccountConsent,type EmailAccountLifecyclePlan} from './email-account-lifecycle.js';
import {z} from 'zod';
import {EmailAccountDisplayIdentitySchema} from './email-account-lifecycle.js';
import type {EmailScope} from './email-mailbox-service.js';
type Database=Pick<typeof db,'transaction'>;
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
export type EmailAccountConsentTransaction=Tx;
export type EmailAccountConsentGuard=(scope:EmailScope,transaction:Tx,phase:'owner'|'principal'|'final')=>Promise<void>;
const where=(table:typeof emailAccounts|typeof emailAccountConsents,scope:EmailScope)=>and(eq(table.org_id,scope.org_id),eq(table.owner_user_id,scope.owner_user_id),eq(table.account_id,scope.account_id));
const hash=(value:unknown)=>createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex');
const context=(scope:EmailScope,revision:number)=>({...scope,kind:'checkpoint' as const,record_id:'native-consent-bridge',revision});
const conflict=():never=>{throw Error('EMAIL_ACCOUNT_LIFECYCLE_CONFLICT');};

/** Account-owned durable consent. owner guard MUST acquire current membership
 * only. principal guard checks exact human SID/lease after the account lock.
 * final guard rechecks these held participants, allowing this known revision.
 * No provider/network work belongs in this transaction or planner invocation. */
export class PostgresEmailAccountConsentStore{
 constructor(private readonly database:Database,private readonly cipher:EmailMailboxCrypto){}
 /** Trusted scoped runtime reads use fresh SQL guards around decoding. This
  * method performs no authorization and must never accept a browser row. */
 decode(row:typeof emailAccountConsents.$inferSelect):EmailAccountConsent{
  const scope={org_id:row.org_id,owner_user_id:row.owner_user_id,account_id:row.account_id};
  const envelope=z.strictObject({bridge:EmailAccountBridgeSchema,identity:EmailAccountDisplayIdentitySchema.optional()}).parse(this.cipher.open(row.bridge_envelope,context(scope,row.revision))),bridge=envelope.bridge;
  if(hash(bridge)!==row.bridge_digest)conflict();
  return EmailAccountConsentSchema.parse({scope,provider:row.provider,principal_digest:row.principal_digest,revision:row.revision,native_revision:row.native_revision,
   credential_revision:row.credential_revision,state:row.state,capabilities:row.capabilities,bridge,...(envelope.identity?{identity:envelope.identity}:{}),consented_at:row.consented_at.toISOString(),updated_at:row.updated_at.toISOString(),revoked_at:row.revoked_at?.toISOString()??null});
 }
 async read(scope:EmailScope,guard:EmailAccountConsentGuard,signal?:AbortSignal,transaction?:Tx):Promise<EmailAccountConsent|null>{
  const work=async(tx:Tx)=>{signal?.throwIfAborted();await guard(scope,tx,'owner');
   const [account]=await tx.select().from(emailAccounts).where(where(emailAccounts,scope)).for('share').limit(1);
   const [row]=await tx.select().from(emailAccountConsents).where(where(emailAccountConsents,scope)).for('share').limit(1);
   await guard(scope,tx,'principal');if(!row){await guard(scope,tx,'final');signal?.throwIfAborted();return null;}
   if(!account||account.provider!==row.provider||account.principal_digest!==row.principal_digest||account.authority_revision<row.native_revision)return conflict();
   const result=this.decode(row);if((account.credential_source??'retained_registry_v1')!==result.bridge.kind||account.resource_binding_id!==emailAccountBridgeBindingId(result.bridge))conflict();await guard(scope,tx,'final');signal?.throwIfAborted();return result;
  };return transaction?work(transaction):this.database.transaction(work);
 }
 async commit(plan:EmailAccountLifecyclePlan,guard:EmailAccountConsentGuard,signal?:AbortSignal):Promise<EmailAccountConsent>{
  const next=EmailAccountConsentSchema.parse(plan.next),scope=next.scope;
  if(plan.effect_policy!=='preserve_started_unknown'||!Number.isSafeInteger(plan.expected_revision)||plan.expected_revision<0
   ||!Number.isSafeInteger(plan.expected_native_revision)||plan.expected_native_revision<1||next.revision!==plan.expected_revision+1||next.native_revision!==plan.expected_native_revision+1)conflict();
  return this.database.transaction(async tx=>{signal?.throwIfAborted();await guard(scope,tx,'owner');
   const [account]=await tx.select().from(emailAccounts).where(where(emailAccounts,scope)).for('update').limit(1);
   if(!account||account.authority_revision!==plan.expected_native_revision||account.provider!==next.provider||account.principal_digest!==next.principal_digest
    ||account.resource_binding_id!==emailAccountBridgeBindingId(next.bridge)||(account.credential_source??'retained_registry_v1')!==next.bridge.kind)conflict();
   const [previous]=await tx.select().from(emailAccountConsents).where(where(emailAccountConsents,scope)).for('update').limit(1);
   await guard(scope,tx,'principal');if((previous?.revision??0)!==plan.expected_revision||(plan.reason==='adopt')!==!previous)conflict();
   const bridgeDigest=hash(next.bridge);
   if(previous&&(previous.provider!==next.provider||previous.principal_digest!==next.principal_digest||previous.bridge_digest!==bridgeDigest
    ||previous.state==='revoked'||next.credential_revision<previous.credential_revision||Date.parse(next.updated_at)<previous.updated_at.getTime()))conflict();
   const row={...scope,provider:next.provider,principal_digest:next.principal_digest,revision:next.revision,native_revision:next.native_revision,credential_revision:next.credential_revision,
    state:next.state,capabilities:next.capabilities,bridge_digest:bridgeDigest,bridge_envelope:this.cipher.seal({bridge:next.bridge,...(next.identity?{identity:next.identity}:{})},context(scope,next.revision)),
    consented_at:new Date(next.consented_at),updated_at:new Date(next.updated_at),revoked_at:next.revoked_at?new Date(next.revoked_at):null};
   if(previous){const result=await tx.update(emailAccountConsents).set(row).where(and(where(emailAccountConsents,scope),eq(emailAccountConsents.revision,plan.expected_revision)));if(result.rowCount!==1)conflict();}
   else await tx.insert(emailAccountConsents).values(row);
   const changed=await tx.update(emailAccounts).set({authority_revision:next.native_revision,state:next.state,consented_at:new Date(next.consented_at),revoked_at:row.revoked_at,updated_at:row.updated_at})
    .where(and(where(emailAccounts,scope),eq(emailAccounts.authority_revision,plan.expected_native_revision)));if(changed.rowCount!==1)conflict();
   // All ciphertext/MIME/jobs/journals remain untouched. A stopped account's
   // rebuildable presentation cache is removed by the runtime disconnect join.
   await guard(scope,tx,'final');signal?.throwIfAborted();return next;
  });
 }
}
