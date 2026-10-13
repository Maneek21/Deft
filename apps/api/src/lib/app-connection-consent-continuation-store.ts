import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {AppConnectionConsentContinuationSourceSchema,AppConnectionConsentContinuationStoredReviewSchema,
  AppConnectionSessionScopeSchema,AppConnectionProfileSchema,AppConnectionActionConsentsSchema,
  AppConnectionConsentContinuationRuntimeResultSchema} from '@deft/app-kit';
import {appConnectionConsentContinuations as journals,appConnectionSessions,appResourceBindings} from '@deft/db/schema';
import {db} from './db.js';
import {AppConnectionSessionRecordSchema,type AppConnectionSessionRecord} from './app-connection-session-service.js';
import type {AppRunTransaction} from './app-run-repository.js';
import type {ExperienceCaller} from './app-experience-service.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import {AppError} from './app-errors.js';
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const ConsentContinuationRecordSchema=z.strictObject({
  session_id:z.string().uuid(),revision:z.number().int().nonnegative(),
  state:z.enum(['preparing','reviewed','activating','indeterminate','committing','connected','not_connected']),
  activation_started:z.boolean(),scope:AppConnectionSessionScopeSchema,profile:AppConnectionProfileSchema,
  source:AppConnectionConsentContinuationSourceSchema,action_consents:AppConnectionActionConsentsSchema,
  transport_digest:digest,review_expires_at:z.iso.datetime(),reviewed_at:z.iso.datetime(),
  binding_before:z.record(z.string(),z.unknown()),attachment_consent_digest:digest,
  review:AppConnectionConsentContinuationStoredReviewSchema.nullable(),
  result:AppConnectionConsentContinuationRuntimeResultSchema.nullable(),created_at:z.iso.datetime(),updated_at:z.iso.datetime(),
});
export type ConsentContinuationRecord=z.infer<typeof ConsentContinuationRecordSchema>;
export const continuationDenied=()=>new AppError('Account consent review is no longer available','APP_ACCESS_DENIED',403);
export type ContinuationLocator={org_id:string;owner_user_id:string;session_id:string};
const where=(q:ContinuationLocator)=>and(eq(journals.org_id,q.org_id),eq(journals.owner_user_id,q.owner_user_id),eq(journals.session_id,q.session_id));
export async function lockContinuationTarget(tx:AppRunTransaction,scope:ConsentContinuationRecord['scope']){
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('deft.app_connection_session.target.v1'),hashtext(${[scope.org_id,scope.owner_user_id,scope.installation_id,scope.target_key].join(':')}))`);
}
export async function assertContinuationSource(tx:AppRunTransaction,r:ConsentContinuationRecord){
  const [row]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,r.scope.org_id),eq(appConnectionSessions.owner_user_id,r.scope.owner_user_id),eq(appConnectionSessions.session_id,r.source.session_id))).for('share');
  if(!row)throw continuationDenied();const old=AppConnectionSessionRecordSchema.parse(row.record);
  if(old.state!=='connected'||old.revision!==r.source.session_revision||!isDeepStrictEqual(old.scope,r.source.scope)
    ||!isDeepStrictEqual(old.profile,r.profile)||!isDeepStrictEqual(old.action_consents,r.source.action_consents)
    ||old.runtime_session_ref!==r.source.runtime_session_ref||old.account?.account_ref!==r.source.account_ref)throw continuationDenied();
  const competing=await tx.select({id:journals.session_id}).from(journals).where(and(eq(journals.org_id,r.scope.org_id),eq(journals.owner_user_id,r.scope.owner_user_id),
    sql`${journals.record}->'scope'->>'resource_binding_id'=${r.scope.resource_binding_id}`,sql`${journals.session_id}<>${r.session_id}`,sql`${journals.record}->>'state'<>'not_connected'`,
    sql`(${journals.source_session_id}=${r.source.session_id} OR ${journals.record}->>'state'<>'connected')`)).limit(1);
  if(competing.length)throw continuationDenied();
  // Terminal unknown outcomes are immutable evidence and do not block fresh
  // independent consent. An actual claimed provider attempt must finish first.
  const active=await tx.execute(sql`SELECT a.id FROM app_run_attempts a JOIN app_runs r ON r.org_id=a.org_id AND r.id=a.run_id
    LEFT JOIN app_runtime_bindings b ON b.org_id=r.org_id AND b.id=r.origin_runtime_binding_id
    WHERE r.org_id=${r.scope.org_id} AND (r.origin_resource_binding_id=${r.scope.resource_binding_id} OR b.owner_resource_binding_id=${r.scope.resource_binding_id})
      AND a.state IN ('claimed','provider_call_started') LIMIT 1 FOR SHARE OF a`);
  if(active.rows.length||!await appConnectionUpgradeSourceIsAvailable(tx,{org_id:r.scope.org_id,owner_user_id:r.scope.owner_user_id,session_id:r.source.session_id,continuation_session_id:r.session_id}))throw continuationDenied();return old;
}
export class PostgresConsentContinuationStore{
  async metadata(q:ContinuationLocator,tx?:AppRunTransaction,lock=false){
    let query=(tx??db).select().from(journals).where(where(q)).limit(1);const [row]=await (lock?query.for('update'):query);
    return row?{...row,record:ConsentContinuationRecordSchema.parse(row.record)}:null;
  }
  async create(tx:AppRunTransaction,caller:ExperienceCaller,record:ConsentContinuationRecord,authorityDeadline:number){
    const r=ConsentContinuationRecordSchema.parse(record);await lockContinuationTarget(tx,r.scope);await assertContinuationSource(tx,r);
    const rows=await tx.insert(journals).values({org_id:r.scope.org_id,owner_user_id:r.scope.owner_user_id,session_id:r.session_id,
      source_session_id:r.source.session_id,resource_binding_id:r.scope.resource_binding_id,web_session_id:caller.sid,
      access_expires_at:new Date(caller.access_expires_at!),authority_operation:'prepare',authority_expires_at:new Date(authorityDeadline),revision:r.revision,record:r,created_at:new Date(r.created_at),updated_at:new Date(r.updated_at)}).onConflictDoNothing().returning();
    if(rows.length!==1)throw continuationDenied();return r;
  }
  async cas(tx:AppRunTransaction,q:ContinuationLocator,previous:ConsentContinuationRecord,next:ConsentContinuationRecord){
    const r=ConsentContinuationRecordSchema.parse(next);if(r.revision!==previous.revision+1)throw continuationDenied();
    const rows=await tx.update(journals).set({record:r,revision:r.revision,updated_at:new Date(r.updated_at)}).where(and(where(q),eq(journals.revision,previous.revision))).returning();
    if(rows.length!==1)throw continuationDenied();return r;
  }
  async retainFreshOwner(tx:AppRunTransaction,q:ContinuationLocator,previous:ConsentContinuationRecord,caller:ExperienceCaller,operation:'prepare'|'activate'|'status',deadline:number){
    if(['connected','not_connected','committing'].includes(previous.state)||!caller.sid||!caller.access_expires_at||caller.access_expires_at<=Date.now())throw continuationDenied();
    const r={...previous,revision:previous.revision+1,updated_at:new Date().toISOString()};
    const rows=await tx.update(journals).set({web_session_id:caller.sid,access_expires_at:new Date(caller.access_expires_at),authority_operation:operation,authority_expires_at:new Date(deadline),record:r,revision:r.revision,updated_at:new Date(r.updated_at)})
      .where(and(where(q),eq(journals.revision,previous.revision))).returning();if(rows.length!==1)throw continuationDenied();return ConsentContinuationRecordSchema.parse(r);
  }
  async publish(tx:AppRunTransaction,q:ContinuationLocator,previous:ConsentContinuationRecord,session:AppConnectionSessionRecord){
    const r=previous;if(r.state!=='committing'||r.result?.state!=='connected')throw continuationDenied();
    await lockContinuationTarget(tx,r.scope);await assertContinuationSource(tx,r);
    const now=await tx.execute(sql`SELECT to_jsonb(b) AS snapshot FROM app_resource_bindings b WHERE b.org_id=${q.org_id} AND b.id=${r.scope.resource_binding_id} FOR UPDATE`);
    if(!isDeepStrictEqual(now.rows[0]?.snapshot,r.binding_before))throw continuationDenied();
    await tx.update(appResourceBindings).set({consent_expires_at:new Date(r.scope.consent_expires_at),reviewed_at:new Date(r.reviewed_at),attachment_consent_digest:r.attachment_consent_digest,updated_at:new Date(session.updated_at)})
      .where(and(eq(appResourceBindings.org_id,q.org_id),eq(appResourceBindings.id,r.scope.resource_binding_id)));
    const starting={...session,revision:0,state:'starting' as const,callback_consumed:false,runtime_session_ref:null,account:null};
    await tx.insert(appConnectionSessions).values({org_id:q.org_id,owner_user_id:q.owner_user_id,session_id:q.session_id,web_session_id:(await this.metadata(q,tx))!.web_session_id,
      access_expires_at:(await this.metadata(q,tx))!.access_expires_at,revision:0,record:starting,created_at:new Date(session.created_at),updated_at:new Date(session.updated_at)});
    await tx.update(appConnectionSessions).set({revision:session.revision,record:session,updated_at:new Date(session.updated_at)}).where(and(eq(appConnectionSessions.org_id,q.org_id),eq(appConnectionSessions.owner_user_id,q.owner_user_id),eq(appConnectionSessions.session_id,q.session_id)));
    return this.cas(tx,q,r,{...r,state:'connected',revision:r.revision+1,updated_at:session.updated_at});
  }
}
