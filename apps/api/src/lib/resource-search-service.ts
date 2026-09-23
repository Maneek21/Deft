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
import { isModuleError } from './module-errors.js';

/** Safe state for callers that can distinguish an unavailable Module read from
 * an authorized search that simply found no records. Never includes a module,
 * record, query, provider, or database error value. */
export type ModuleReadDiagnostic = {
  source: 'modules';
  status: 'forbidden' | 'unavailable';
  code: 'MODULE_READ_FORBIDDEN' | 'MODULE_READ_UNAVAILABLE';
  message: string;
};

export type ModuleRecordSearchOutcome = {
  items: ModuleSearchHit[];
  next_cursor: string | null;
  diagnostic?: ModuleReadDiagnostic;
};

export function moduleReadForbiddenDiagnostic(): ModuleReadDiagnostic {
  return {
    source: 'modules',
    status: 'forbidden',
    code: 'MODULE_READ_FORBIDDEN',
    message: 'Module search is not permitted for this actor.',
  };
}

export function moduleReadFailureDiagnostic(error: unknown): ModuleReadDiagnostic {
  if (isModuleError(error) && (error.code === 'MODULE_ACCESS_DENIED' || error.code === 'MODULE_SCOPE_REQUIRED')) {
    return moduleReadForbiddenDiagnostic();
  }
  return {
    source: 'modules',
    status: 'unavailable',
    code: 'MODULE_READ_UNAVAILABLE',
    message: 'Module search is temporarily unavailable. Retry the search.',
  };
}

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

/**
 * The result-only search remains the strict operation contract for direct
 * tools. This adapter is for authorized aggregate surfaces which must show a
 * safe unavailable/forbidden state instead of presenting a failed branch as
 * an empty module search.
 */
export async function searchAuthorizedModuleResourcesWithDiagnostics(
  actor: ModuleActor,
  input: ModuleRecordSearchRequest,
): Promise<ModuleRecordSearchOutcome> {
  try {
    return await searchAuthorizedModuleResources(actor, input);
  } catch (error) {
    return {
      items: [],
      next_cursor: null,
      diagnostic: moduleReadFailureDiagnostic(error),
    };
  }
}
