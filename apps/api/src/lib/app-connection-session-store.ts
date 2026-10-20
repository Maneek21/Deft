import {unstartedReviewClosure,matchesUnstartedReviewClosure,UNSTARTED_REVIEW_CLOSURE_ACTION} from './app-connection-review-closure.js';
import {appConnectionForms} from '../../../../packages/db/src/schema/app-connection-forms.js';
import {validateStoredFormConnection} from './app-connection-form-fence.js';
import {AppError} from './app-errors.js';
import {appConnectionCredentialRepairReservation,appConnectionCredentialRepairSourceIsSuperseded} from './app-connection-credential-repair-fence.js';
import { and, eq, ne, sql,inArray,or,notInArray } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { auditLog,appConnectionSessions,appRuns,appRunAttempts,appRuntimeBindings } from '@deft/db/schema';
import { db } from './db.js';
import { AppConnectionSessionRecordSchema, type AppConnectionSessionRecord, type AppConnectionSessionLocator } from './app-connection-session-service.js';
import type { ExperienceCaller } from './app-experience-service.js';

const where = (locator: AppConnectionSessionLocator) => and(eq(appConnectionSessions.org_id, locator.org_id),
  eq(appConnectionSessions.owner_user_id, locator.owner_user_id), eq(appConnectionSessions.session_id, locator.session_id));

/** Full admitted scope equality excludes obsolete version/consent history.
 * Unknown consumed custody never becomes retryable through lease expiry. */
export function connectionSessionAdmissionFence(scope: AppConnectionSessionRecord['scope'], now: Date, excluding?: string) {
  return and(eq(appConnectionSessions.org_id, scope.org_id), eq(appConnectionSessions.owner_user_id, scope.owner_user_id),
    sql`${appConnectionSessions.record}->'scope'=${JSON.stringify(scope)}::jsonb`,
    excluding ? ne(appConnectionSessions.session_id, excluding) : undefined,
    sql`NOT EXISTS (SELECT 1 FROM public.app_connection_sessions repair_history
      WHERE repair_history.org_id=${appConnectionSessions.org_id}
      AND repair_history.record->'credential_repair'->'source'->>'session_id'=${appConnectionSessions.session_id}
      AND repair_history.record->'credential_repair'->'receipt'<>'null'::jsonb)`,
    sql`${appConnectionSessions.record}->>'state' NOT IN ('disconnected','not_connected')`,
    sql`NOT (${appConnectionSessions.record}->>'state' IN ('starting','awaiting_callback')
      AND ${appConnectionSessions.record}->'callback_consumed'='false'::jsonb
      AND ${appConnectionSessions.record}->'account'='null'::jsonb
      AND COALESCE(${appConnectionSessions.record}->'upgrade'->'begin_consumed','false'::jsonb)='false'::jsonb
      AND (${appConnectionSessions.record}->>'callback_expires_at')::timestamptz <= ${now})`);
}

/** Durable commit-before-IO store; every mutation scopes org and owner. */
export class PostgresAppConnectionSessionStore {
  constructor(private readonly database: typeof db = db, private readonly caller?: ExperienceCaller) {}
  async create(raw: AppConnectionSessionRecord) {return this.insertSession(raw,false);}
  async createUnstartedReviewClosure(raw:AppConnectionSessionRecord){return this.insertSession(raw,true);}
  private async insertSession(raw:AppConnectionSessionRecord,closing:boolean) {
    const record = AppConnectionSessionRecordSchema.parse(raw);
    if (!this.caller || this.caller.org_id !== record.scope.org_id || this.caller.user_id !== record.scope.owner_user_id
      || !Number.isFinite(this.caller.access_expires_at)) return false;
    const caller = this.caller;
    const closure=closing?unstartedReviewClosure(record):null;if(closing&&!closure)return false;
    const admission=closing?AppConnectionSessionRecordSchema.parse({...record,revision:0,state:'starting'}):record;
    return this.database.transaction(async tx => {
      const domain = [record.scope.org_id, record.scope.owner_user_id, record.scope.installation_id, record.scope.target_key].join(':');
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deft.app_connection_session.target.v1'),hashtext(${domain}))`);
      if(await appConnectionCredentialRepairReservation(tx,{org_id:record.scope.org_id,resource_binding_id:record.scope.resource_binding_id}))return false;
      if(record.upgrade||record.credential_repair){
        const source=(record.upgrade??record.credential_repair)!.source;
        const [stored]=await tx.select().from(appConnectionSessions).where(where({org_id:record.scope.org_id,
          owner_user_id:record.scope.owner_user_id,session_id:source.session_id})).limit(1).for('update');
        if(!stored)return false;
        const prior=AppConnectionSessionRecordSchema.parse(stored.record);
        if(prior.state!=='connected'||prior.revision!==source.session_revision||!isDeepStrictEqual(prior.scope,source.scope)
          ||prior.runtime_session_ref!==source.runtime_session_ref||prior.account?.account_ref!==source.account_ref)return false;
      }
      const [competing] = await tx.select({ id: appConnectionSessions.session_id }).from(appConnectionSessions)
        .where(connectionSessionAdmissionFence(record.scope, new Date(),(record.upgrade??record.credential_repair)?.source.session_id)).limit(1).for('update');
      if (competing) return false;
      const rows = await tx.insert(appConnectionSessions).values({ org_id: record.scope.org_id,
      owner_user_id: record.scope.owner_user_id, session_id: record.session_id, revision: admission.revision,
      web_session_id: caller.sid, access_expires_at: new Date(caller.access_expires_at!), record:admission,
      created_at: new Date(record.created_at), updated_at: new Date(record.updated_at) }).onConflictDoNothing().returning({ id: appConnectionSessions.session_id });
      if(rows.length===1&&closure){
        const closed=await tx.update(appConnectionSessions).set({revision:record.revision,record,updated_at:new Date(record.updated_at)}).where(and(where({org_id:record.scope.org_id,owner_user_id:record.scope.owner_user_id,session_id:record.session_id}),eq(appConnectionSessions.revision,0))).returning({id:appConnectionSessions.session_id});
        if(closed.length!==1)throw new AppError('Unstarted review closure changed','APP_STATE_CONFLICT',409);
        await tx.insert(auditLog).values({org_id:record.scope.org_id,actor_type:'user',actor_id:record.scope.owner_user_id,action:UNSTARTED_REVIEW_CLOSURE_ACTION,entity_type:'app_connection_session',entity_id:record.session_id,metadata:closure});}
      return rows.length === 1;
    });
  }
  /** Server-owned audit provenance; public audit API has no write operation. */
  async readUnstartedReviewClosure(locator:AppConnectionSessionLocator){
    if(!this.caller||this.caller.org_id!==locator.org_id||this.caller.user_id!==locator.owner_user_id)return null;
    const row=await this.metadata(locator);if(!row)return null;const record=AppConnectionSessionRecordSchema.parse(row.record),expected=unstartedReviewClosure(record);if(!expected)return null;
    const rows=await this.database.select({metadata:auditLog.metadata}).from(auditLog).where(and(eq(auditLog.org_id,locator.org_id),eq(auditLog.actor_type,'user'),eq(auditLog.actor_id,locator.owner_user_id),eq(auditLog.action,UNSTARTED_REVIEW_CLOSURE_ACTION),eq(auditLog.entity_type,'app_connection_session'),eq(auditLog.entity_id,locator.session_id),sql`${auditLog.metadata}->>'scope_digest'=${expected.scope_digest}`,sql`${auditLog.metadata}->>'closed_at'=${expected.closed_at}`)).limit(2);
    return rows.length===1&&matchesUnstartedReviewClosure(rows[0]!.metadata,record)?expected:null;
  }
  async read(locator: AppConnectionSessionLocator, audience:'oauth'|'data'='oauth') {
    const row = await this.metadata(locator);
    if(!row)return null;const record=AppConnectionSessionRecordSchema.parse(row.record);
    const form=await this.database.transaction(tx=>validateStoredFormConnection(tx,locator,record));
    if(form&&audience==='oauth')throw new AppError('Credential form protocol requires its own management route','APP_ACCESS_DENIED',403);return record;
  }
  async metadata(locator: AppConnectionSessionLocator) {
    const [row] = await this.database.select().from(appConnectionSessions).where(where(locator)).limit(1);
    return row ?? null;
  }
  async compareAndSet(locator: AppConnectionSessionLocator, expectedRevision: number, raw: AppConnectionSessionRecord) {
    const next = AppConnectionSessionRecordSchema.parse(raw);
    if (!this.caller || this.caller.org_id !== locator.org_id || this.caller.user_id !== locator.owner_user_id
      || !Number.isFinite(this.caller.access_expires_at)
      || next.session_id !== locator.session_id || next.scope.org_id !== locator.org_id || next.scope.owner_user_id !== locator.owner_user_id
      || next.revision !== expectedRevision + 1) return false;
    return this.database.transaction(async tx => {
      if(next.credential_repair)await tx.select({id:appConnectionSessions.session_id}).from(appConnectionSessions)
        .where(where({...locator,session_id:next.credential_repair.source.session_id})).limit(1).for('update');
      const [stored] = await tx.select().from(appConnectionSessions).where(where(locator)).limit(1).for('update');
      if (!stored || stored.revision !== expectedRevision) return false;
      const previous = AppConnectionSessionRecordSchema.parse(stored.record);
      if(await appConnectionCredentialRepairSourceIsSuperseded(tx,{org_id:locator.org_id,session_id:locator.session_id}))return false;
      const repairReservation=await appConnectionCredentialRepairReservation(tx,{org_id:previous.scope.org_id,resource_binding_id:previous.scope.resource_binding_id});
      if(repairReservation&&repairReservation.id!==previous.session_id)return false;
      if(previous.credential_repair||next.credential_repair){
        const before=previous.credential_repair,after=next.credential_repair;
        if(!before||!after||!isDeepStrictEqual(before.source,after.source)||before.transport_digest!==after.transport_digest
          ||before.review_expires_at!==after.review_expires_at||!isDeepStrictEqual(before.historical_attempts,after.historical_attempts)
          ||before.publication_continuity_digest!==after.publication_continuity_digest||before.review&&!isDeepStrictEqual(before.review,after.review)
          ||before.receipt&&!isDeepStrictEqual(before.receipt,after.receipt)||before.begin_consumed&&!after.begin_consumed
          ||before.reservation_closed&&!after.reservation_closed||before.closure&&!isDeepStrictEqual(before.closure,after.closure)
          ||after.reservation_closed&&!after.receipt&&!after.closure
          ||previous.runtime_session_ref!==null&&next.runtime_session_ref!==previous.runtime_session_ref
          ||previous.runtime_session_ref===null&&next.runtime_session_ref!==null&&(next.state!=='awaiting_callback'||!after.begin_consumed))return false;
        const [sourceRow]=await tx.select().from(appConnectionSessions).where(where({...locator,session_id:before.source.session_id})).limit(1).for('update');
        const source=sourceRow&&AppConnectionSessionRecordSchema.parse(sourceRow.record);
        if(!source||source.state!=='connected'||source.revision!==before.source.session_revision||!isDeepStrictEqual(source.scope,before.source.scope)
          ||source.runtime_session_ref!==before.source.runtime_session_ref||source.account?.account_ref!==before.source.account_ref)return false;
      }
      const beginning=previous.upgrade?.begin_consumed===false&&next.upgrade?.begin_consumed===true;
      const closing=!!next.upgrade?.closure&&!previous.upgrade?.closure;
      if(beginning||closing){
        if(!previous.upgrade?.review||beginning&&(previous.state!=='upgrade_reviewed'||next.state!=='upgrade_starting')
          ||closing&&(previous.state!=='upgrade_checking'||!previous.upgrade.begin_consumed||previous.callback_consumed!==next.callback_consumed||previous.upgrade.receipt
            ||next.state!=='not_connected'||Date.parse(previous.callback_expires_at)>Date.now()||Date.parse(previous.upgrade.review_expires_at)>Date.now()))return false;
        const sourcePin=previous.upgrade.source;
        const [sourceRow]=await tx.select().from(appConnectionSessions).where(where({...locator,session_id:sourcePin.session_id})).limit(1).for('update');
        if(!sourceRow)return false;const source=AppConnectionSessionRecordSchema.parse(sourceRow.record);
        if(source.state!=='connected'||source.revision!==sourcePin.session_revision||!isDeepStrictEqual(source.scope,sourcePin.scope)
          ||source.runtime_session_ref!==sourcePin.runtime_session_ref||source.account?.account_ref!==sourcePin.account_ref)return false;
        const resources=[source.scope.resource_binding_id,next.scope.resource_binding_id];
        const bindings=await tx.select({id:appRuntimeBindings.id}).from(appRuntimeBindings).where(and(eq(appRuntimeBindings.org_id,locator.org_id),
          eq(appRuntimeBindings.app_installation_id,next.scope.installation_id),inArray(appRuntimeBindings.owner_resource_binding_id,resources)));
        const domain=and(eq(appRuns.org_id,locator.org_id),eq(appRuns.origin_app_installation_id,next.scope.installation_id),
          or(inArray(appRuns.origin_resource_binding_id,resources),bindings.length?inArray(appRuns.origin_runtime_binding_id,bindings.map(row=>row.id)):undefined));
        const [run]=await tx.select({id:appRuns.id}).from(appRuns).where(and(domain,inArray(appRuns.state,['pending','pending_approval','running','waiting_external','unknown_outcome']))).limit(1);
        const [attempt]=await tx.select({id:appRunAttempts.id}).from(appRunAttempts).innerJoin(appRuns,and(eq(appRuns.org_id,appRunAttempts.org_id),eq(appRuns.id,appRunAttempts.run_id))).where(and(domain,
          notInArray(appRuns.state,['succeeded','failed','cancelled','expired']),inArray(appRunAttempts.state,['pending','claimed','provider_call_started','unknown_outcome']))).limit(1);
        if(run||attempt)return false;
      }
      if (!isDeepStrictEqual(previous.scope, next.scope) || !isDeepStrictEqual(previous.profile, next.profile)
        || previous.callback_state_hash !== next.callback_state_hash && !(previous.upgrade?.begin_consumed===false&&next.upgrade?.begin_consumed===true
          ||previous.credential_repair?.begin_consumed===false&&next.credential_repair?.begin_consumed===true)
        || previous.callback_expires_at !== next.callback_expires_at
        || previous.created_at !== next.created_at || previous.callback_consumed && !next.callback_consumed) return false;
      if(!isDeepStrictEqual(previous.action_consent,next.action_consent)||!isDeepStrictEqual(previous.action_consents,next.action_consents))return false;
      if(previous.upgrade||next.upgrade){const before=previous.upgrade,after=next.upgrade;
        if(!before||!after||!isDeepStrictEqual(before.source,after.source)||before.transport_digest!==after.transport_digest
          ||before.review_expires_at!==after.review_expires_at||before.review&&!isDeepStrictEqual(before.review,after.review)
          ||before.receipt&&!isDeepStrictEqual(before.receipt,after.receipt)||before.closure&&!isDeepStrictEqual(before.closure,after.closure)||before.begin_consumed&&!after.begin_consumed)return false;}
      if (previous.reattachment || next.reattachment) {
        const before = previous.reattachment, after = next.reattachment;
        if (!before || !after || !isDeepStrictEqual(before.source, after.source)
          || before.transport_digest !== after.transport_digest || before.review_expires_at !== after.review_expires_at
          || before.review && !isDeepStrictEqual(before.review, after.review)
          || before.receipt && !isDeepStrictEqual(before.receipt, after.receipt)) return false;
      }
      const rows = await tx.update(appConnectionSessions).set({ revision: next.revision, record: next,
        ...(this.caller ? { web_session_id: this.caller.sid, access_expires_at: new Date(this.caller.access_expires_at!) } : {}),
        updated_at: new Date(next.updated_at) }).where(and(where(locator), eq(appConnectionSessions.revision, expectedRevision))).returning({ id: appConnectionSessions.session_id });
      return rows.length === 1;
    });
  }
}
