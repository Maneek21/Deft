import {and,eq} from 'drizzle-orm';
import {isDeepStrictEqual} from 'node:util';
import {AppRunAuthorizationSnapshotSchema,canonicalCapabilityJson} from '@deft/shared';
import {ResourceObservationSnapshotSchema,type ResourceObservationSnapshot} from '../../../../packages/app-kit/src/resource-observation.js';
import {appResourceObservationConsents,appResourceObservationRuns} from '../../../../packages/db/src/resource-observation-schema.js';
import {digestAppGrantValue} from './app-grant-service.js';
import {buildAttachmentSyncAuthorizationSnapshot} from './app-attachment-sync-run.js';
import {observationDenied,observedResourceAuthorization} from './app-resource-observation-authority.js';
import type {LiveAttachmentSyncBindingAuthority} from './app-attachment-sync-authority.js';
import type {AppRunTransaction} from './app-run-repository.js';

type Consent=typeof appResourceObservationConsents.$inferSelect;
const scopeIdentity=(scope:ResourceObservationSnapshot['scope'])=>Object.fromEntries(Object.entries(scope)
 .filter(([key])=>key!=='consent_expires_at'&&key!=='consent_lifetime'));

/** Historical consent proves which read failed; only the separately validated
 * current consent authorizes a NEW read. Never use this reader at an effect boundary. */
export function assertObservationRecoveryIdentity(previous:Consent,current:{row:Consent;snapshot:ResourceObservationSnapshot},
 authorization:unknown,authority:LiveAttachmentSyncBindingAuthority){
 const snapshot=ResourceObservationSnapshotSchema.parse(previous.snapshot);
 if(!['active','revoked'].includes(previous.state)||previous.org_id!==authority.binding.org_id
  ||previous.owner_user_id!==authority.binding.owner_user_id||previous.resource_binding_id!==authority.binding.id
  ||snapshot.consent_id!==previous.consent_id||snapshot.connection.session_id!==previous.connection_session_id
  ||snapshot.expires_at!==(previous.expires_at?.toISOString()??null)
  ||digestAppGrantValue(snapshot)!==previous.consent_digest
  ||!isDeepStrictEqual(scopeIdentity(snapshot.scope),scopeIdentity(current.snapshot.scope))
  ||snapshot.connection.account_ref!==current.snapshot.connection.account_ref)throw observationDenied();
 const prior=AppRunAuthorizationSnapshotSchema.parse(authorization),base=buildAttachmentSyncAuthorizationSnapshot(authority);
 const policy=prior.authority_refs.filter(ref=>ref.authority_kind==='policy'&&ref.authority_id===authority.binding.id);
 if(policy.length!==1||digestAppGrantValue(policy)!==snapshot.resource_policy_digest)throw observationDenied();
 // Renewal may replace its reviewed policy/expiry and credential receipt. All
 // immutable App/grant/member/registration/descriptor/provider pins must match.
 const expected=observedResourceAuthorization({...base,authority_refs:base.authority_refs.map(ref=>
  ref.authority_kind==='policy'&&ref.authority_id===authority.binding.id?policy[0]!:ref)},previous);
 if(canonicalCapabilityJson(prior)!==canonicalCapabilityJson(expected))throw observationDenied();
}

export async function requireObservationRecoveryPredecessor(tx:AppRunTransaction,runId:string,
 authority:LiveAttachmentSyncBindingAuthority,current:{row:Consent;snapshot:ResourceObservationSnapshot},authorization:unknown){
 const [link]=await tx.select().from(appResourceObservationRuns).where(and(
  eq(appResourceObservationRuns.org_id,authority.binding.org_id),eq(appResourceObservationRuns.run_id,runId))).limit(1);
 if(!link)throw observationDenied();
 const [previous]=await tx.select().from(appResourceObservationConsents).where(and(
  eq(appResourceObservationConsents.org_id,link.org_id),eq(appResourceObservationConsents.consent_id,link.consent_id))).limit(1).for('share');
 if(!previous||previous.consent_digest!==link.consent_digest)throw observationDenied();
 assertObservationRecoveryIdentity(previous,current,authorization,authority);
}
