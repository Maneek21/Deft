import {and,eq} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {appConnectionSessions,appDataConsents} from '@deft/db/schema';
import {db} from './db.js';
import {validateStoredFormConnection} from './app-connection-form-fence.js';
import {appConnectionUpgradeSourceIsAvailable} from './app-connection-upgrade-fence.js';
import {AppConnectionSessionRecordSchema} from './app-connection-session-service.js';
import {appDataDenied,type CurrentAppDataAuthority} from './app-data-authority.js';
import type {AppRunTransaction} from './app-run-repository.js';
import type {ExperienceCaller} from './app-experience-service.js';
export async function captureResourceBatchDataFence(caller:ExperienceCaller,authority:CurrentAppDataAuthority){
 if(!authority.consent)throw appDataDenied();
 const locator={org_id:caller.org_id,owner_user_id:caller.user_id,session_id:authority.connection.session_id};
 const [carrier]=await db.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,locator.org_id),eq(appConnectionSessions.owner_user_id,locator.owner_user_id),eq(appConnectionSessions.session_id,locator.session_id))).limit(1);
 const [consent]=await db.select().from(appDataConsents).where(and(eq(appDataConsents.org_id,locator.org_id),eq(appDataConsents.owner_user_id,locator.owner_user_id),eq(appDataConsents.consent_id,authority.consent.consent_id))).limit(1);
 if(!carrier||!consent)throw appDataDenied();const record=AppConnectionSessionRecordSchema.parse(carrier.record);
 if(record.state!=='connected'||carrier.revision!==authority.connection.session_revision||record.runtime_session_ref!==authority.connection.runtime_session_ref||record.account?.account_ref!==authority.connection.account_ref||!isDeepStrictEqual(record.scope,authority.scope)||consent.state!=='active'||consent.connection_session_id!==locator.session_id||consent.store_key!==authority.store.key||consent.consent_digest!==authority.consent.consent_digest)throw appDataDenied();
 const form=await db.transaction(tx=>validateStoredFormConnection(tx,locator,carrier.record));
 return {locator,carrier:record,consent:consent.snapshot,consent_id:consent.consent_id,consent_digest:consent.consent_digest,form_receipt:form?.receipt??null,expires_at:Math.min(authority.expires_at,consent.expires_at.getTime())};
}
export async function assertResourceBatchDataFence(tx:AppRunTransaction,capture:Awaited<ReturnType<typeof captureResourceBatchDataFence>>){
 const q=capture.locator;
 if(capture.expires_at<=Date.now())throw appDataDenied();
 const [carrier]=await tx.select().from(appConnectionSessions).where(and(eq(appConnectionSessions.org_id,q.org_id),eq(appConnectionSessions.owner_user_id,q.owner_user_id),eq(appConnectionSessions.session_id,q.session_id))).limit(1).for('share');
 if(!carrier||!isDeepStrictEqual(carrier.record,capture.carrier)||!await appConnectionUpgradeSourceIsAvailable(tx,{...q,purpose:'saved_read'}))throw appDataDenied();
 const form=await validateStoredFormConnection(tx,q,carrier.record);
 if(!isDeepStrictEqual(form?.receipt??null,capture.form_receipt)||form&&form.state!=='connected')throw appDataDenied();
 const [consent]=await tx.select().from(appDataConsents).where(and(eq(appDataConsents.org_id,q.org_id),eq(appDataConsents.owner_user_id,q.owner_user_id),eq(appDataConsents.consent_id,capture.consent_id))).limit(1).for('share');
 if(!consent||consent.state!=='active'||consent.consent_digest!==capture.consent_digest||consent.connection_session_id!==q.session_id||consent.expires_at.getTime()<=Date.now()||!isDeepStrictEqual(consent.snapshot,capture.consent))throw appDataDenied();
}
