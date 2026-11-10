import {AppDataConsentSnapshotSchema,appConsentDeadline} from '@deft/app-kit/core';
import {humanRecordSaveReceipt} from './app-data-human-save.js';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {appDataConsents,appDataInvocations,appConnectionSessions} from '@deft/db/schema';
import {noPublishedConnectionSuccessor} from './app-connection-current-locators.js';
import {db} from './db.js';
import type {ExperienceCaller} from './app-experience-service.js';
/** PR424-N2b: serializes every writer that can make an app_data_consents row
 * `active` for one owner connection target (all of its sessions: current,
 * credential-repair lineage, restore successor; all stores). Row locks cannot
 * protect the ABSENCE of an active row and the target index is not unique, so
 * without this an ordinary activation and a Restore reissue/carry could each
 * see "no active consent" and both commit one.
 *
 * Lock order (cycle-freedom argument). Holders/waiters of this key are only:
 *  - PostgresAppDataStore.activate: takes it as the FIRST lock of its own
 *    transaction (after one plain, non-locking read that names the target), then
 *    only app_data_consents row locks plus one plain, non-locking
 *    app_connection_sessions read (PR424-N2c successor check), which never waits.
 *  - AppRestoreAccessService.activate: takes it immediately after
 *    `deft.app_restore_access.activate.v1` (which no other path takes) and
 *    before every row lock (member/App/registration/binding/session/review/
 *    consent rows).
 * A waiter therefore holds either nothing or only the restore key, and a holder
 * never waits for a lock taken before this key by another holder, so the key
 * cannot join a cycle. It is distinct from `deft.app_connection_session.target.v1`
 * (session admission/forms/continuations), which neither path takes. The key is
 * target-scoped, not session-scoped, so it is identical whether Restore writes to
 * the current session or to a successor it published in the same transaction. */
export async function lockAppDataConsentTarget(executor:{execute(query:ReturnType<typeof sql>):Promise<unknown>},
 target:{org_id:string;owner_user_id:string;installation_id:string;target_key:string}){
 await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deft.app_data_consent.target.v1'),hashtext(${[target.org_id,target.owner_user_id,target.installation_id,target.target_key].join(':')}))`);
}
export class PostgresAppDataStore {
  constructor(readonly caller:Pick<ExperienceCaller,'org_id'|'user_id'>,readonly database:typeof db=db){}
  private owner(table:typeof appDataConsents|typeof appDataInvocations){return and(eq(table.org_id,this.caller.org_id),eq(table.owner_user_id,this.caller.user_id));}
  async consent(id:string){const [row]=await this.database.select().from(appDataConsents).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id)));return row??null;}
  async activeConsent(session:string|string[],store:string){const rows=await this.database.select().from(appDataConsents).where(and(this.owner(appDataConsents),inArray(appDataConsents.connection_session_id,typeof session==='string'?[session]:session),eq(appDataConsents.store_key,store),eq(appDataConsents.state,'active')));return rows.filter(row=>appConsentDeadline(row.expires_at,AppDataConsentSnapshotSchema.parse(row.snapshot).consent_lifetime)>Date.now());}
  async activeConsents(sessions:string[],stores:string[]){if(!sessions.length||!stores.length)return [];const rows=await this.database.select().from(appDataConsents).where(and(this.owner(appDataConsents),inArray(appDataConsents.connection_session_id,sessions),inArray(appDataConsents.store_key,stores),eq(appDataConsents.state,'active')));return rows.filter(row=>appConsentDeadline(row.expires_at,AppDataConsentSnapshotSchema.parse(row.snapshot).consent_lifetime)>Date.now());}
  async propose(values:typeof appDataConsents.$inferInsert){await this.database.insert(appDataConsents).values(values);}
  async activate(id:string,digest:string,connectionIds?:string[]){return this.database.transaction(async tx=>{
    // The snapshot (and so its target) is immutable under the consent guard, so
    // the unlocked read only names the lock; everything is re-read under it.
    const [named]=await tx.select({snapshot:appDataConsents.snapshot}).from(appDataConsents).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id))).limit(1);
    if(!named)return false;
    const scope=AppDataConsentSnapshotSchema.parse(named.snapshot).scope;
    await lockAppDataConsentTarget(tx,{org_id:this.caller.org_id,owner_user_id:this.caller.user_id,installation_id:scope.installation_id,target_key:scope.target_key});
    // Under the target lock the revoke below re-reads every committed active row
    // for the store, so exactly one live consent (this one) remains.
    const [row]=await tx.select().from(appDataConsents).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id))).for('update');
    if(!row||row.state!=='proposed'||row.consent_digest!==digest||appConsentDeadline(row.expires_at,AppDataConsentSnapshotSchema.parse(row.snapshot).consent_lifetime)<=Date.now()||AppDataConsentSnapshotSchema.parse(row.snapshot).review_expires_at!==undefined&&Date.parse(AppDataConsentSnapshotSchema.parse(row.snapshot).review_expires_at!)<=Date.now())return false;
    // PR424-N2c: the caller's lineage (`connectionIds`) was computed BEFORE this
    // lock. A Restore that committed in between may have published a successor
    // for the proposal's session and carried the live consent onto it, which a
    // revoke over the stale lineage would not see. Under the lock, require the
    // proposal's session to still be current for this exact target, using the
    // same "no published successor" definition as the current-session locators
    // (upgrade/credential-repair receipt, restore successor, connected
    // continuation, connected form). A superseded session is refused (the caller
    // surfaces its existing conflict) and the owner re-proposes on the current
    // connection; nothing is reconciled across sessions.
    // Deadlock-freedom: a plain SELECT (no FOR UPDATE/SHARE) under READ COMMITTED
    // never waits on row locks, so it adds no edge to the order documented at
    // lockAppDataConsentTarget; its fresh statement snapshot sees every
    // successor committed by a Restore that released this lock before us.
    const [currentSession]=await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions).where(and(
     eq(appConnectionSessions.org_id,this.caller.org_id),eq(appConnectionSessions.owner_user_id,this.caller.user_id),
     eq(appConnectionSessions.session_id,row.connection_session_id),
     sql`${appConnectionSessions.record}->'scope'->>'installation_id'=${scope.installation_id}`,
     sql`${appConnectionSessions.record}->'scope'->>'target_key'=${scope.target_key}`,
     sql`${appConnectionSessions.record}->>'state'='connected'`,
     noPublishedConnectionSuccessor())).limit(1);
    if(!currentSession)return false;
    await tx.update(appDataConsents).set({state:'revoked',updated_at:new Date()}).where(and(this.owner(appDataConsents),inArray(appDataConsents.connection_session_id,connectionIds??[row.connection_session_id]),eq(appDataConsents.store_key,row.store_key),eq(appDataConsents.state,'active')));
    await tx.update(appDataConsents).set({state:'active',updated_at:new Date()}).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id)));return true;
  });}
  async revoke(id:string){await this.database.update(appDataConsents).set({state:'revoked',updated_at:new Date()}).where(and(this.owner(appDataConsents),eq(appDataConsents.consent_id,id)));}
  async invocation(id:string){const [row]=await this.database.select().from(appDataInvocations).where(and(this.owner(appDataInvocations),eq(appDataInvocations.request_id,id)));return row??null;}
  async humanSave(authority:{scope:{org_id:string;owner_user_id:string;installation_id:string;target_key:string;resource_key:string};connection:{account_ref:string}},record:{store_key:string;record_id:string;revision:number;content_digest:string}){
    const rows=await this.database.select().from(appDataInvocations).where(and(this.owner(appDataInvocations),eq(appDataInvocations.operation,'record_save'),eq(appDataInvocations.state,'completed'),eq(appDataInvocations.revision,1),
     sql`${appDataInvocations.context}->'scope'->>'installation_id' = ${authority.scope.installation_id}`,sql`${appDataInvocations.context}->'scope'->>'target_key' = ${authority.scope.target_key}`,sql`${appDataInvocations.context}->'scope'->>'resource_key' = ${authority.scope.resource_key}`,
     sql`${appDataInvocations.context}->'connection'->>'account_ref' = ${authority.connection.account_ref}`,
     sql`${appDataInvocations.result}->>'outcome' = 'completed'`,sql`${appDataInvocations.result}->>'store_key' = ${record.store_key}`,sql`${appDataInvocations.result}->>'record_id' = ${record.record_id}`,
     sql`${appDataInvocations.result}->>'revision' = ${String(record.revision)}`,sql`${appDataInvocations.result}->>'content_digest' = ${record.content_digest}`)).limit(2);
    return humanRecordSaveReceipt(authority,record,rows);
  }
  async begin(values:typeof appDataInvocations.$inferInsert){return (await this.database.insert(appDataInvocations).values(values).onConflictDoNothing().returning({id:appDataInvocations.request_id})).length===1;}
  async finish(id:string,state:'completed'|'indeterminate',result:Record<string,unknown>|null){return (await this.database.update(appDataInvocations).set({state,result,revision:1,updated_at:new Date()}).where(and(this.owner(appDataInvocations),eq(appDataInvocations.request_id,id),eq(appDataInvocations.state,'inflight'),eq(appDataInvocations.revision,0))).returning({id:appDataInvocations.request_id})).length===1;}
}
