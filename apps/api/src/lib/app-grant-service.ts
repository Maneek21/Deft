import { createHash } from 'node:crypto';
import { appGrantSnapshots } from '@deft/db/schema';
import {
  SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT,
  type DeftAppManifest,
  type DeftAppManifestV1,
} from '@deft/app-kit';
import { db } from './db.js';

export const APP_GRANT_SNAPSHOT_VERSION = 'deft.app_grant_snapshot.v1' as const;

type GrantExecutor = Pick<typeof db, 'insert'>;
type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

export type RequestedAppGrantProjection = {
  resource_rights: Record<string, unknown>[];
  classification: Record<string, unknown>;
  canonical_snapshot: Record<string, unknown>;
  snapshot_digest: `sha256:${string}`;
};

function canonicalize(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Grant snapshot cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key.normalize('NFC')] = canonicalize(item);
    }
    return result;
  }
  throw new TypeError(`Grant snapshot cannot contain ${typeof value}`);
}

function digestCanonical(value: unknown): `sha256:${string}` {
  const json = JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

function v1RequestedRequirements(manifest: DeftAppManifestV1) {
  return {
    dependencies: manifest.dependencies,
    resources: manifest.resource_requirements,
    capabilities: manifest.capability_requirements,
    connectors: manifest.connector_requirements,
    actions: manifest.actions,
  };
}

export function buildRequestedAppGrantProjection(input: {
  organization_id: string;
  app_installation_id: string;
  app_version_id: string;
  manifest: DeftAppManifest;
  manifest_digest: string;
  package_digest: string;
}): RequestedAppGrantProjection {
  const protocol = input.manifest.compatibility.app_protocol;
  const requirements = protocol === '1'
    ? v1RequestedRequirements(input.manifest as DeftAppManifestV1)
    : { dependencies: [], resources: [], capabilities: [], connectors: [], actions: [] };
  const resourceRights = protocol === '1'
    ? (input.manifest as DeftAppManifestV1).resource_requirements.map((requirement) => ({
        requirement_key: requirement.key,
        source: requirement.source,
        resource_type: requirement.resource_type,
        fields: requirement.fields,
        right: 'read',
      }))
    : [];
  const classification = {
    authority_state: 'requested_only',
    executable: false,
    provider_access: false,
    review_required: protocol === '1',
    actions: protocol === '1'
      ? (input.manifest as DeftAppManifestV1).actions.map((action) => ({
          action_key: action.key,
          capability_requirement_key: action.capability_requirement_key,
          host_policy: SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.host_policy,
        }))
      : [],
  };
  const canonicalSnapshot = canonicalize({
    snapshot_version: APP_GRANT_SNAPSHOT_VERSION,
    snapshot_kind: 'requested',
    organization_id: input.organization_id,
    app: {
      installation_id: input.app_installation_id,
      version_id: input.app_version_id,
      id: input.manifest.id,
      version: input.manifest.version,
      protocol_version: protocol,
      manifest_digest: input.manifest_digest,
      package_digest: input.package_digest,
    },
    requirements,
    resource_rights: resourceRights,
    classification,
  });
  if (canonicalSnapshot === null || Array.isArray(canonicalSnapshot) || typeof canonicalSnapshot !== 'object') {
    throw new TypeError('Canonical grant snapshot must be an object');
  }
  return {
    resource_rights: resourceRights,
    classification,
    canonical_snapshot: canonicalSnapshot,
    snapshot_digest: digestCanonical(canonicalSnapshot),
  };
}

export async function insertRequestedAppGrantSnapshotWithExecutor(
  executor: GrantExecutor,
  input: {
    id: string;
    organization_id: string;
    app_installation_id: string;
    app_version_id: string;
    manifest: DeftAppManifest;
    manifest_digest: string;
    package_digest: string;
  },
): Promise<void> {
  const projection = buildRequestedAppGrantProjection(input);
  await executor.insert(appGrantSnapshots).values({
    id: input.id,
    org_id: input.organization_id,
    app_installation_id: input.app_installation_id,
    app_version_id: input.app_version_id,
    app_id: input.manifest.id,
    app_version: input.manifest.version,
    manifest_digest: input.manifest_digest,
    package_digest: input.package_digest,
    snapshot_kind: 'requested',
    snapshot_version: APP_GRANT_SNAPSHOT_VERSION,
    requested_snapshot_id: null,
    supersedes_snapshot_id: null,
    resource_rights: projection.resource_rights,
    classification: projection.classification,
    canonical_snapshot: projection.canonical_snapshot,
    snapshot_digest: projection.snapshot_digest,
    reviewed_by_actor_type: null,
    reviewed_by_actor_id: null,
    reviewed_at: null,
  });
}
