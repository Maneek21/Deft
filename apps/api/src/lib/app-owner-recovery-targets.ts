import { isDeepStrictEqual } from 'node:util';
import type { OwnerConnectionAdmissionSnapshot } from './app-owner-connection-contract.js';

/** Historical pins identify saved accounts, never current delivery authority. */
export function compatibleOwnerRecoverySnapshot(current: OwnerConnectionAdmissionSnapshot, previous: OwnerConnectionAdmissionSnapshot) {
  const fields = ['org_id', 'installation_id', 'operator_user_id', 'policy', 'policy_digest', 'resource_descriptor_digest',
    'actions', 'limits', 'connection_profile', 'connection_profile_digest', 'connection_transport_digest'] as const;
  return fields.every(field => isDeepStrictEqual(current[field], previous[field]));
}
