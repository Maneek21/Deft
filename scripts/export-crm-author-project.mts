import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = resolve(repoRoot, 'modules/bundled/contacts/deft.module.json');
const examples = resolve(repoRoot, 'modules/projects/contacts/examples');
const authorBuilder = resolve(repoRoot, 'modules/projects/contacts/author/build.mjs');

export async function exportCrmAuthorProject(outputDir: string, appKitTarball?: string): Promise<string> {
  const kitPackage = JSON.parse(await readFile(resolve(repoRoot, 'packages/app-kit/package.json'), 'utf8')) as { version?: string };
  if (!kitPackage.version) throw new Error('App Kit package version is missing');
  let archivePackage: { name?: string; version?: string } | undefined;
  if (appKitTarball) {
    const archive = resolve(appKitTarball);
    const inspected = spawnSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' });
    if (inspected.status !== 0 || !inspected.stdout) throw new Error(`Could not inspect App Kit tarball: ${archive}`);
    try { archivePackage = JSON.parse(inspected.stdout) as { name?: string; version?: string }; }
    catch { throw new Error(`App Kit tarball contains invalid package metadata: ${archive}`); }
    if (archivePackage.name !== '@deft/app-kit' || archivePackage.version !== kitPackage.version) {
      throw new Error(`App Kit tarball must contain @deft/app-kit ${kitPackage.version}`);
    }
  }
  const target = resolve(outputDir);
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length > 0) throw new Error(`Output directory must be empty: ${target}`);
  await mkdir(resolve(target, 'modules/contacts'), { recursive: true });
  await cp(canonical, resolve(target, 'modules/contacts/deft.module.json'));
  await cp(examples, resolve(target, 'examples'), { recursive: true });
  await cp(resolve(repoRoot, 'modules/projects/contacts/author/README.md'), resolve(target, 'README.md'));
  const builder = await readFile(authorBuilder, 'utf8');
  const manifestFactory = await readFile(resolve(repoRoot, 'modules/projects/contacts/author/manifest.mjs'), 'utf8');
  const portableBuilder = builder.replace("import { buildContactsCrmManifest, CRM_APP_VERSIONS } from './manifest.mjs';", '');
  const buildScript = `${portableBuilder}\n${manifestFactory}\nimport { readFile, writeFile } from 'node:fs/promises';\nconst module = JSON.parse(await readFile(new URL('./modules/contacts/deft.module.json', import.meta.url), 'utf8'));\nconst connected = process.argv.includes('--connected');\nconst versionIndex = process.argv.indexOf('--app-version');\nconst appVersion = versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined;\nif (versionIndex >= 0 && !appVersion) throw new Error('Usage: node build.mjs [--connected] [--app-version <semver>]');\nconst built = await buildContactsCrmPackage(module, { connected, ...(appVersion ? { appVersion } : {}) });\nawait writeFile(new URL('./contacts-crm.deftapp.json', import.meta.url), built.json, 'utf8');\nconsole.log(connected ? 'Built connected Contacts CRM' : 'Built connector-free Contacts CRM');\n`;
  let appKitDependency = kitPackage.version;
  if (appKitTarball) {
    const vendorPath = resolve(target, 'vendor/deft-app-kit.tgz');
    await mkdir(resolve(target, 'vendor'), { recursive: true });
    await cp(resolve(appKitTarball), vendorPath);
    const bytes = await readFile(vendorPath);
    await writeFile(resolve(target, 'vendor/deft-app-kit.json'), JSON.stringify({ package: archivePackage!.name, version: archivePackage!.version, filename: 'deft-app-kit.tgz', sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
    appKitDependency = 'file:vendor/deft-app-kit.tgz';
  }
  await writeFile(resolve(target, 'build.mjs'), buildScript, 'utf8');
  await writeFile(resolve(target, 'package.json'), JSON.stringify({
    name: 'contacts-crm-author-project', private: true, type: 'module',
    scripts: { build: 'node build.mjs', buildConnected: 'node build.mjs --connected' },
    dependencies: { '@deft/app-kit': appKitDependency },
  }, null, 2) + '\n', 'utf8');
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] ?? resolve(repoRoot, 'tmp/contacts-crm-author-project');
  console.log(`Exported CRM author project to ${await exportCrmAuthorProject(output, process.argv[3])}`);
}
