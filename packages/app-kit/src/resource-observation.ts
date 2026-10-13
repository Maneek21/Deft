import {z} from 'zod';
import {AppConnectionSessionScopeSchema} from './connection-session.js';
import {canonicalConnectionReattachmentJson} from './connection-session-reattach.js';
import {createResourceSyncTransport} from './resource-sync-transport.js';
import {ResourceSyncClaimV3Schema} from './resource-sync-client-v3.js';
import type {ResourceSyncClientOptions,ResourceSyncCallOptions} from './resource-sync-client.js';

const id=z.string().uuid(),digest=z.string().regex(/^sha256:[a-f0-9]{64}$/u),instant=z.iso.datetime();
const opaque=z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const generation=z.number().int().min(1).max(2147483646);
export const ResourceObservationConnectionSchema=z.strictObject({session_id:id,runtime_session_ref:opaque,account_ref:opaque,
  expected_custody_generation:generation.nullable(),receipt_digest:digest.nullable()})
  .refine(value=>(value.expected_custody_generation===null)===(value.receipt_digest===null),'Generation and receipt must be paired');
/** This separately versioned consent admits scalar metadata only, never attachment transfer. */
export const RESOURCE_OBSERVATION_ATTACHMENT_MODE='unsupported' as const;
export const ResourceObservationSnapshotSchema=z.strictObject({schema_version:z.literal('deft.app_resource_observation_consent.v1'),
  consent_id:id,scope:AppConnectionSessionScopeSchema,connection:ResourceObservationConnectionSchema,resource_policy_digest:digest,
  interval_seconds:z.number().int().min(60).max(86400),expires_at:instant})
  .refine(value=>Date.parse(value.expires_at)<=Date.parse(value.scope.consent_expires_at),'Observation exceeds resource consent');
export type ResourceObservationSnapshot=z.infer<typeof ResourceObservationSnapshotSchema>;
export const ResourceObservationReviewRequestSchema=z.strictObject({connection_session_id:id,request_id:id,
  interval_seconds:z.number().int().min(60).max(86400),expires_at:instant});
export const ResourceObservationActivateRequestSchema=z.strictObject({consent_id:id,review_digest:digest});
export const ResourceObservationReferenceSchema=z.strictObject({consent_id:id});
export const ResourceObservationReviewSchema=z.strictObject({schema_version:z.literal('deft.app_resource_observation_review.v1'),
  consent_id:id,review_digest:digest,attachment_mode:z.literal('unsupported'),scope:AppConnectionSessionScopeSchema,connection_session_id:id,
  account:z.strictObject({account_ref:opaque,label:z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]+$/u)}),
  expected_custody_generation:generation.nullable(),interval_seconds:z.number().int().min(60).max(86400),expires_at:instant});
export const ResourceObservationStatusSchema=z.strictObject({schema_version:z.literal('deft.app_resource_observation_status.v1'),
  consent_id:id,state:z.enum(['proposed','active','revoked','unavailable']),review:ResourceObservationReviewSchema});
export const ResourceObservationAuthorityRequestSchema=z.strictObject({schema_version:z.literal('deft.app_resource_observation_authority.v1'),
  audience:z.literal('app_resource_sync'),
  session_id:id,run_id:id,attempt_id:id,claim_token:id,sequence:z.number().int().min(1).max(2147483646),expires_at:instant});
export const ResourceObservationAuthorityResultSchema=ResourceObservationAuthorityRequestSchema.extend({allowed:z.literal(true),
  consent_digest:digest,snapshot:ResourceObservationSnapshotSchema})
  .refine(value=>Date.parse(value.expires_at)<=Date.parse(value.snapshot.expires_at),'Authority exceeds consent');
export async function digestResourceObservation(value:ResourceObservationSnapshot){
  const bytes=new TextEncoder().encode(canonicalConnectionReattachmentJson(ResourceObservationSnapshotSchema.parse(value)));
  return 'sha256:'+Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Read-only current authority, using the same reviewed v3 session credential.
 * channel_url is the observation runtime route; no credential is renewed here. */
export function createResourceObservationClient(options:ResourceSyncClientOptions){
 const post=createResourceSyncTransport({...options,timeout_ms:Math.min(options.timeout_ms??10000,10000),channel_version:'deft.app_resource_observation_authority.v1'});
 return Object.freeze({async authorize(raw:unknown,call?:ResourceSyncCallOptions){
  const claim=ResourceSyncClaimV3Schema.parse(raw),requested=new Date(Date.now()+15000).toISOString();
  if(claim.session_id!==options.credential.session_id)throw new TypeError('Observation session mismatch');
  const result=ResourceObservationAuthorityResultSchema.parse(await post('authority',{run_id:claim.run_id,attempt_id:claim.attempt_id,
   claim_token:claim.claim_token,sequence:claim.sequence,expires_at:requested},call));
  if(result.session_id!==claim.session_id||result.run_id!==claim.run_id||result.attempt_id!==claim.attempt_id
   ||result.claim_token!==claim.claim_token||result.sequence!==claim.sequence||Date.parse(result.expires_at)>Date.parse(requested)
   ||Date.parse(result.expires_at)<=Date.now())throw new TypeError('Observation authority mismatch');
  const scope=result.snapshot.scope;
  if(scope.org_id!==claim.org_id||scope.installation_id!==claim.app_installation_id||scope.app_version_id!==claim.app_version_id
   ||scope.grant_snapshot_id!==claim.grant_snapshot_id||scope.lifecycle_epoch!==claim.lifecycle_epoch||scope.grant_epoch!==claim.grant_epoch
   ||scope.runtime_registration_id!==claim.runtime_registration_id||scope.runtime_epoch!==claim.runtime_epoch
   ||scope.resource_binding_id!==claim.resource_binding_id||await digestResourceObservation(result.snapshot)!==result.consent_digest)
    throw new TypeError('Observation scope mismatch');
  return result;
 }});
}

/** Observation v1 projects scalar metadata only; attachment transfer is not admitted. */
export const ResourceObservationContextSchema=z.strictObject({schema_version:z.literal('deft.app_resource_observation_context.v1'),
 installation_id:id,org_id:id,owner_user_id:id,targets:z.array(z.strictObject({target_key:z.string().regex(/^[a-z][a-z0-9_]{0,47}$/u),
 scope:AppConnectionSessionScopeSchema,connection_session_id:id,
 account:ResourceObservationReviewSchema.shape.account,min_interval_seconds:z.number().int().min(60).max(86400),
 attachment_mode:z.literal('unsupported'),consent:z.strictObject({consent_id:id,state:z.enum(['proposed','active','revoked','unavailable'])}).nullable()})).max(32)});

export type ResourceObservationContext=z.infer<typeof ResourceObservationContextSchema>;
