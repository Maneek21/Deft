
import {and,eq,sql} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {appConnectionConsentContinuations as journals} from '@deft/db/schema';
import {ConsentContinuationRecordSchema,continuationDenied} from './app-connection-consent-continuation-store.js';
import {continuationRequest,continuationDigest} from './app-connection-consent-continuation-service.js';
import {appConnectionConsentContinuationReceiptValue} from '@deft/app-kit/core';
import type {AppRunTransaction} from './app-run-repository.js';
import type {AppConnectionSessionRecord} from './app-connection-session-service.js';
export async function continuationSourceIsAvailable(tx:AppRunTransaction,q:{org_id:string;owner_user_id?:string;session_id?:string;resource_binding_id?:string;continuation_session_id?:string}){
 const [row]=await tx.select({id:journals.session_id}).from(journals).where(and(eq(journals.org_id,q.org_id),
  q.owner_user_id?eq(journals.owner_user_id,q.owner_user_id):undefined,
  sql`${journals.record}->'activation_started'='true'::jsonb`,q.continuation_session_id?sql`${journals.session_id}<>${q.continuation_session_id}`:undefined,
  q.session_id?eq(journals.source_session_id,q.session_id):and(eq(journals.resource_binding_id,q.resource_binding_id!),sql`${journals.record}->>'state'<>'connected'`))).limit(1);
 return !row;
}
/** Form protocol successors carry their own distinct consent-only receipt;
 * they never invent a credential-form journal or reuse an expired receipt. */
export async function validateContinuationCarrier(tx:AppRunTransaction,record:AppConnectionSessionRecord,required=false){
 const [row]=await tx.select().from(journals).where(and(eq(journals.org_id,record.scope.org_id),eq(journals.owner_user_id,record.scope.owner_user_id),eq(journals.session_id,record.session_id))).limit(1).for('share');
 if(!row){if(required)throw continuationDenied();return null;}const r=ConsentContinuationRecordSchema.parse(row.record);
 if(r.state!=='connected'||r.result?.state!=='connected'||!r.review||!r.activation_started||record.state!=='connected'
   ||!isDeepStrictEqual(r.scope,record.scope)||!isDeepStrictEqual(r.profile,record.profile)||!isDeepStrictEqual(r.action_consents,record.action_consents)
   ||!isDeepStrictEqual(r.result.account,record.account)||r.result.runtime_session_ref!==record.runtime_session_ref
   ||r.result.receipt_digest!==continuationDigest(appConnectionConsentContinuationReceiptValue(continuationRequest(r,'status',Date.parse(r.review_expires_at)),r.review,r.result.runtime_session_ref)))throw continuationDenied();
 return {custody_generation:r.result.custody_generation,receipt_digest:r.result.receipt_digest};
}
