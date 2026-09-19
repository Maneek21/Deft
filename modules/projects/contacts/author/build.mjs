import { buildDeftAppPackage, prepareModuleArtifact } from '@deft/app-kit';
import { buildContactsCrmManifest, CRM_APP_VERSIONS } from './manifest.mjs';

export async function buildContactsCrmPackage(module, { connected = true, appVersion = connected ? CRM_APP_VERSIONS.connected : CRM_APP_VERSIONS.base } = {}) {
  const artifact = await prepareModuleArtifact({ path: 'modules/contacts/deft.module.json', manifest: module });
  return buildDeftAppPackage({ manifest: buildContactsCrmManifest(module, artifact, { connected, appVersion }), artifacts: [artifact] });
}
