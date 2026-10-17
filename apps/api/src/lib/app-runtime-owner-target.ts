import {appConsentDeadline,appConsentExpiryValid,type AppConsentLifetime} from '@deft/app-kit';
import { loadLiveAttachmentSyncBindingAuthority,loadConsentContinuationBindingIdentity } from './app-attachment-sync-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { AppError } from './app-errors.js';

/** Exact owner custody, never authority inferred from a target label. */
async function loadOwnerTarget(tx: AppRunTransaction, input: {
  org_id: string; owner_user_id: string; resource_binding_id: string;
  installation_id: string; app_version_id: string; grant_snapshot_id: string;
  operator_user_id: string; prelocked_participant_ids: readonly string[];
}, continuationExpiry?:Date|null,continuationLifetime?:AppConsentLifetime) {
  const current = await (continuationExpiry!==undefined?loadConsentContinuationBindingIdentity:loadLiveAttachmentSyncBindingAuthority)(tx, {
    org_id: input.org_id, resource_binding_id: input.resource_binding_id,
    clock: () => new Date(), prelocked_participant_ids: input.prelocked_participant_ids,
  });
  if (!current || current.binding.owner_user_id !== input.owner_user_id
    || current.binding.app_installation_id !== input.installation_id
    || current.binding.app_version_id !== input.app_version_id
    || current.binding.grant_snapshot_id !== input.grant_snapshot_id
    || current.registration.operator_user_id !== input.operator_user_id) throw new AppError(
      'Reviewed private target is no longer available', 'APP_STALE', 409);
  if(continuationExpiry!==undefined&&(!appConsentExpiryValid(continuationExpiry,continuationLifetime)||appConsentDeadline(continuationExpiry,continuationLifetime)<=Date.now()||appConsentDeadline(continuationExpiry,continuationLifetime)<=appConsentDeadline(current.binding.consent_expires_at,current.binding.consent_lifetime??undefined)))throw new AppError('Fresh consent required','APP_STALE',409);
  return continuationExpiry!==undefined?{...current,binding:{...current.binding,consent_expires_at:continuationExpiry,consent_lifetime:continuationLifetime??null}}:current;
}

export const loadRuntimeOwnerTarget=(tx:AppRunTransaction,input:Parameters<typeof loadOwnerTarget>[1])=>loadOwnerTarget(tx,input);
export const loadConsentContinuationOwnerTarget=(tx:AppRunTransaction,input:Parameters<typeof loadOwnerTarget>[1],expiry:Date|null,lifetime?:AppConsentLifetime)=>loadOwnerTarget(tx,input,expiry,lifetime);
