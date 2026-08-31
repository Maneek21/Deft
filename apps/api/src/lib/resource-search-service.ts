import {
  RESOURCE_CONTRACT_VERSIONS,
  type ModuleResourceRefV1,
} from '@deft/shared/resources';
import type {
  ModuleActor,
  ModuleRecordSearchRequest,
  ModuleSearchHit,
} from '@deft/shared/modules';
import { searchModuleRecords } from './module-service.js';
import {
  isResourceAuthorizationError,
} from './resource-authorization.js';
import { resourceAuthorizationService } from './resource-provider-adapters.js';

/**
 * Search indexes nominate candidates only. Every returned title/snippet is
 * gated by a live owner resolution immediately before it leaves the service.
 */
export async function searchAuthorizedModuleResources(
  actor: ModuleActor,
  input: ModuleRecordSearchRequest,
): Promise<{ items: ModuleSearchHit[]; next_cursor: string | null }> {
  const candidates = await searchModuleRecords(actor, input);
  const items: ModuleSearchHit[] = [];
  for (const candidate of candidates.items) {
    const ref: ModuleResourceRefV1 = {
      schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
      provider: { kind: 'module', provider_instance_id: candidate.installation_id },
      resource_type: candidate.collection_key,
      resource_id: candidate.record_id,
    };
    try {
      const projection = await resourceAuthorizationService.resolve(
        { org_id: actor.org_id, actor },
        ref,
      );
      items.push({ ...candidate, title: projection.label });
    } catch (error) {
      if (!isResourceAuthorizationError(error) || error.code === 'RESOURCE_PROVIDER_FAILURE') throw error;
    }
  }
  return { items, next_cursor: candidates.next_cursor };
}
