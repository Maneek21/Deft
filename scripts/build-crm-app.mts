import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeftAppPackage, prepareModuleArtifact } from '../packages/app-kit/dist/index.js';
import { buildContactsCrmManifest, CRM_APP_VERSIONS } from '../modules/projects/contacts/author/manifest.mjs';

/** Build from the canonical bundled artifact; never maintain a second CRM schema. */
export async function buildContactsCrmApp() {
  const module = JSON.parse(await readFile(new URL('../modules/bundled/contacts/deft.module.json', import.meta.url), 'utf8'));
  const artifact = await prepareModuleArtifact({ path: 'modules/contacts/deft.module.json', manifest: module });
  return buildDeftAppPackage({ manifest: buildContactsCrmManifest(module, artifact, { connected: true, appVersion: CRM_APP_VERSIONS.connected }), artifacts: [artifact] });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = new URL('../tmp/contacts-crm.deftapp.json', import.meta.url);
  const built = await buildContactsCrmApp();
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  await writeFile(output, built.json, 'utf8');
  console.log(`Contacts CRM package: ${fileURLToPath(output)}`);
}
