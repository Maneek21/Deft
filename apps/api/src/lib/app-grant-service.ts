import { createHash } from 'node:crypto';
import { appGrantSnapshots } from '@deft/db/schema';
import {
  projectDeftAppRequestedAuthority,
  type DeftAppManifest,
} from '@deft/app-kit';
import { db } from './db.js';

export const APP_GRANT_SNAPSHOT_VERSION = 'deft.app_grant_snapshot.v1' as const;

type GrantExecutor = Pick<typeof db, 'insert'>;
export type AppGrantCanonicalJson =
  | null
  | boolean
  | number
  | string
  | AppGrantCanonicalJson[]
  | { [key: string]: AppGrantCanonicalJson };

export type RequestedAppGrantProjection = {
  resource_rights: Record<string, unknown>[];
  classification: Record<string, unknown>;
  canonical_snapshot: Record<string, unknown>;
  snapshot_digest: `sha256:${string}`;
};

export function canonicalizeAppGrantValue(value: unknown): AppGrantCanonicalJson {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Grant snapshot cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeAppGrantValue);
  if (typeof value === 'object') {
    const result: Record<string, AppGrantCanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key.normalize('NFC')] = canonicalizeAppGrantValue(item);
    }
    return result;
  }
  throw new TypeError(`Grant snapshot cannot contain ${typeof value}`);
}

export function digestAppGrantValue(value: unknown): `sha256:${string}` {
  const json = JSON.stringify(canonicalizeAppGrantValue(value));
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`;
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
  const portable = projectDeftAppRequestedAuthority(input.manifest);
  const requirements = portable.requirements;
  const resourceRights = portable.resource_rights;
  const classification = portable.classification;
  const canonicalSnapshot = canonicalizeAppGrantValue({
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
    snapshot_digest: digestAppGrantValue(canonicalSnapshot),
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
