import { readFile } from 'node:fs/promises';
import {
  buildDeftAppPackage,
  prepareModuleArtifact,
  type DeftAppManifestV0Input,
  type DeftAppManifestV1Input,
} from '@deft/app-kit';
import type { DeftModuleManifestV2Input } from '@deft/shared';

type ProofDirectory =
  | 'resource-participation-contacts-app'
  | 'resource-participation-campaigns-app'
  | 'connected-resource-campaigns-app';

async function loadProofSource<TManifest extends DeftAppManifestV0Input | DeftAppManifestV1Input>(
  directory: ProofDirectory,
): Promise<Readonly<{
  manifest: TManifest;
  module_manifest: DeftModuleManifestV2Input;
  manifest_path: string;
}>> {
  const root = new URL(`../../../../examples/${directory}/`, import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('deft.app.json', root), 'utf8')) as TManifest;
  const reference = manifest.modules?.[0];
  if (!reference) throw new Error(`${directory} must contain one Module reference`);
  const moduleManifest = JSON.parse(
    await readFile(new URL(reference.manifest_path, root), 'utf8'),
  ) as DeftModuleManifestV2Input;
  const artifact = await prepareModuleArtifact({
    path: reference.manifest_path,
    manifest: moduleManifest,
  });
  if (artifact.digest !== reference.manifest_digest) {
    throw new Error(`${directory} Module digest is stale`);
  }
  return {
    manifest,
    module_manifest: moduleManifest,
    manifest_path: reference.manifest_path,
  };
}

async function buildExactV0(
  directory: Extract<ProofDirectory, 'resource-participation-contacts-app' | 'resource-participation-campaigns-app'>,
) {
  const source = await loadProofSource<DeftAppManifestV0Input>(directory);
  const artifact = await prepareModuleArtifact({
    path: source.manifest_path,
    manifest: source.module_manifest,
  });
  return buildDeftAppPackage({ manifest: source.manifest, artifacts: [artifact] });
}

export function buildPhase5DependencyAppPackage() {
  return buildExactV0('resource-participation-contacts-app');
}

export async function buildPhase5ConnectedAppPackage(options: {
  app_version?: string;
  module_version?: string;
  add_campaign_code?: boolean;
} = {}) {
  const source = await loadProofSource<DeftAppManifestV1Input>('connected-resource-campaigns-app');
  const moduleVersion = options.module_version ?? source.module_manifest.version;
  const moduleManifest: DeftModuleManifestV2Input = {
    ...source.module_manifest,
    version: moduleVersion,
    collections: source.module_manifest.collections.map((collection, index) => ({
      ...collection,
      fields: [
        ...collection.fields,
        ...(index === 0 && options.add_campaign_code
          ? [{ key: 'campaign_code', label: 'Campaign code', type: 'text' as const }]
          : []),
      ],
    })),
  };
  const artifact = await prepareModuleArtifact({
    path: source.manifest_path,
    manifest: moduleManifest,
  });
  const reference = source.manifest.modules?.[0];
  if (!reference) throw new Error('Connected Campaigns must contain one Module reference');
  const manifest: DeftAppManifestV1Input = {
    ...source.manifest,
    version: options.app_version ?? source.manifest.version,
    modules: [{
      ...reference,
      version: moduleVersion,
      manifest_digest: artifact.digest,
    }],
    resource_requirements: source.manifest.resource_requirements.map((requirement) => (
      requirement.source.kind === 'included_module'
        ? {
            ...requirement,
            source: { ...requirement.source, version: moduleVersion },
            fields: [
              ...requirement.fields,
              ...(options.add_campaign_code ? ['campaign_code'] : []),
            ],
          }
        : requirement
    )),
  };
  return buildDeftAppPackage({ manifest, artifacts: [artifact] });
}

export function buildPhase5ConnectedPredecessorAppPackage() {
  return buildExactV0('resource-participation-campaigns-app');
}
