import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFT_MODULE_MANIFEST_FILENAME,
  MODULE_LIMITS,
  canonicalizeModuleManifest,
  digestModuleManifest,
  getDeftModuleManifestV1JsonSchema,
  parseDeftModuleManifestJson,
  type DeftModuleManifestV1,
} from '@deft/shared/modules';

export type CheckedModule = {
  manifestPath: string;
  manifest: DeftModuleManifestV1;
  digest: string;
};

export type ModuleLockEntry = {
  module_id: string;
  slug: string;
  version: string;
  manifest_digest: string;
  manifest_path: string;
  source_repository: string;
  source_commit: string;
  license: string;
};

type ModuleLock = {
  schema_version: '1';
  modules: ModuleLockEntry[];
};

function prettyCanonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalizeModuleManifest(value), null, 2)}\n`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveModuleManifestPath(inputPath: string): Promise<string> {
  const absolute = resolve(inputPath);
  const info = await stat(absolute).catch(() => null);
  if (!info) throw new Error(`Module path does not exist: ${absolute}`);
  if (info.isDirectory()) return join(absolute, DEFT_MODULE_MANIFEST_FILENAME);
  if (!info.isFile()) throw new Error(`Module path is not a file or directory: ${absolute}`);
  return absolute;
}

export async function checkModule(inputPath: string): Promise<CheckedModule> {
  const manifestPath = await resolveModuleManifestPath(inputPath);
  const info = await stat(manifestPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Missing ${DEFT_MODULE_MANIFEST_FILENAME}: ${manifestPath}`);
  if (info.size > MODULE_LIMITS.manifest_bytes) {
    throw new Error(`Manifest exceeds ${MODULE_LIMITS.manifest_bytes} bytes`);
  }
  const source = await readFile(manifestPath, 'utf8');
  const manifest = parseDeftModuleManifestJson(source);
  return {
    manifestPath,
    manifest,
    digest: await digestModuleManifest(manifest),
  };
}

export async function formatModule(inputPath: string): Promise<CheckedModule> {
  const checked = await checkModule(inputPath);
  await writeFile(checked.manifestPath, prettyCanonicalJson(checked.manifest), 'utf8');
  return checkModule(checked.manifestPath);
}

export async function initModuleProject(
  outputDirectory: string,
  options: { rootDirectory?: string } = {},
): Promise<CheckedModule> {
  const directory = resolve(outputDirectory);
  const manifestPath = join(directory, DEFT_MODULE_MANIFEST_FILENAME);
  if (await fileExists(manifestPath)) {
    throw new Error(`Refusing to overwrite existing manifest: ${manifestPath}`);
  }

  const inferredSlug = basename(directory)
    .toLowerCase()
    .replace(/^deft-module-/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'example';
  const manifest = parseDeftModuleManifestJson(JSON.stringify({
    schema_version: '1',
    id: `community.example.${inferredSlug}`,
    slug: inferredSlug,
    version: '0.1.0',
    name: inferredSlug.split('-').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' '),
    description: `A declarative ${inferredSlug} module for Deft.`,
    icon: 'boxes',
    collections: [
      {
        key: 'items',
        name: 'Items',
        singular_name: 'Item',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'notes', label: 'Notes', type: 'long_text' },
        ],
        search: { title_field: 'name', fields: ['name', 'notes'] },
        views: [
          { key: 'table', name: 'Table', type: 'table', fields: ['name'] },
          { key: 'form', name: 'Form', type: 'form', fields: ['name', 'notes'] },
          { key: 'detail', name: 'Details', type: 'detail', fields: ['name', 'notes'] },
        ],
      },
    ],
  }));

  await mkdir(join(directory, 'fixtures'), { recursive: true });
  await mkdir(join(directory, 'screenshots'), { recursive: true });
  await writeFile(manifestPath, prettyCanonicalJson(manifest), 'utf8');
  await writeFile(
    join(directory, 'README.md'),
    `# ${manifest.name}\n\nA declarative module for [Deft](https://github.com/Maneek21/Deft).\n\n## Validate\n\n\`pnpm module:check .\`\n`,
    'utf8',
  );
  await writeFile(join(directory, 'CHANGELOG.md'), `# Changelog\n\n## 0.1.0\n\n- Initial manifest.\n`, 'utf8');
  await writeFile(
    join(directory, 'CONTRIBUTING.md'),
    '# Contributing\n\nValidate `deft.module.json`, add fixtures for schema changes, and use semantic versions.\n',
    'utf8',
  );
  await writeFile(join(directory, 'fixtures', 'demo-records.json'), '[]\n', 'utf8');
  await writeFile(
    join(directory, 'deft.module.schema.json'),
    `${JSON.stringify(getDeftModuleManifestV1JsonSchema(), null, 2)}\n`,
    'utf8',
  );

  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const licensePath = join(rootDirectory, 'LICENSE');
  if (await fileExists(licensePath)) {
    await writeFile(join(directory, 'LICENSE'), await readFile(licensePath, 'utf8'), 'utf8');
  }
  return checkModule(manifestPath);
}

function validateSourceRepository(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Source repository must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Source repository must be an HTTPS URL without embedded credentials');
  }
  return url.toString().replace(/\/$/, '');
}

function validateSourceCommit(value: string): string {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) {
    throw new Error('Source commit must be a full 40- or 64-character lowercase Git object id');
  }
  return value;
}

function validateLicense(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]{1,63}$/.test(value)) {
    throw new Error('License must be a simple SPDX identifier');
  }
  return value;
}

async function readModuleLock(lockPath: string): Promise<ModuleLock> {
  if (!(await fileExists(lockPath))) return { schema_version: '1', modules: [] };
  const value = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<ModuleLock>;
  if (value.schema_version !== '1' || !Array.isArray(value.modules)) {
    throw new Error(`Invalid module lock: ${lockPath}`);
  }
  return { schema_version: '1', modules: value.modules };
}

export async function verifyVendoredModules(
  rootDirectory = process.cwd(),
): Promise<ModuleLockEntry[]> {
  const root = resolve(rootDirectory);
  const lockPath = join(root, 'modules', 'modules.lock.json');
  const lock = await readModuleLock(lockPath);
  const moduleIds = new Set<string>();
  const slugs = new Set<string>();
  const verified: ModuleLockEntry[] = [];

  for (const rawEntry of lock.modules) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      throw new Error(`Invalid module lock entry in ${lockPath}`);
    }
    const entry = rawEntry as ModuleLockEntry;
    if (moduleIds.has(entry.module_id)) throw new Error(`Duplicate locked module id: ${entry.module_id}`);
    if (slugs.has(entry.slug)) throw new Error(`Duplicate locked module slug: ${entry.slug}`);
    moduleIds.add(entry.module_id);
    slugs.add(entry.slug);

    validateSourceRepository(entry.source_repository);
    validateSourceCommit(entry.source_commit);
    validateLicense(entry.license);
    const expectedPath = `modules/bundled/${entry.slug}/${DEFT_MODULE_MANIFEST_FILENAME}`;
    if (entry.manifest_path !== expectedPath) {
      throw new Error(`Locked manifest path must be ${expectedPath}`);
    }
    const checked = await checkModule(join(root, ...entry.manifest_path.split('/')));
    if (checked.manifest.id !== entry.module_id || checked.manifest.slug !== entry.slug) {
      throw new Error(`Locked identity does not match ${entry.manifest_path}`);
    }
    if (checked.manifest.version !== entry.version) {
      throw new Error(`Locked version does not match ${entry.manifest_path}`);
    }
    if (checked.digest !== entry.manifest_digest) {
      throw new Error(`Locked digest does not match ${entry.manifest_path}`);
    }
    verified.push(entry);
  }
  return verified;
}

export async function vendorModule(
  inputPath: string,
  options: {
    rootDirectory?: string;
    sourceRepository: string;
    sourceCommit: string;
    license: string;
  },
): Promise<ModuleLockEntry> {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const checked = await checkModule(inputPath);
  const sourceRepository = validateSourceRepository(options.sourceRepository);
  const sourceCommit = validateSourceCommit(options.sourceCommit);
  const license = validateLicense(options.license);
  const relativeManifestPath = `modules/bundled/${checked.manifest.slug}/${DEFT_MODULE_MANIFEST_FILENAME}`;
  const targetPath = join(rootDirectory, ...relativeManifestPath.split('/'));
  const lockPath = join(rootDirectory, 'modules', 'modules.lock.json');
  const lock = await readModuleLock(lockPath);

  const slugOwner = lock.modules.find(
    (entry) => entry.slug === checked.manifest.slug && entry.module_id !== checked.manifest.id,
  );
  if (slugOwner) throw new Error(`Module slug is already pinned by ${slugOwner.module_id}`);

  const entry: ModuleLockEntry = {
    module_id: checked.manifest.id,
    slug: checked.manifest.slug,
    version: checked.manifest.version,
    manifest_digest: checked.digest,
    manifest_path: relativeManifestPath,
    source_repository: sourceRepository,
    source_commit: sourceCommit,
    license,
  };
  const modules = lock.modules
    .filter((item) => item.module_id !== entry.module_id)
    .concat(entry)
    .sort((left, right) => left.module_id.localeCompare(right.module_id));

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, prettyCanonicalJson(checked.manifest), 'utf8');
  await writeFile(lockPath, `${JSON.stringify({ schema_version: '1', modules }, null, 2)}\n`, 'utf8');
  return entry;
}

function argumentValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const [command, input, ...args] = process.argv.slice(2);
  if (!command || !input) {
    throw new Error('Usage: modules-cli <init|check|format|vendor|verify-lock> <path> [options]');
  }

  if (command === 'init') {
    const result = await initModuleProject(input);
    console.log(`Created ${result.manifest.name} ${result.manifest.version}`);
    console.log(result.digest);
    return;
  }
  if (command === 'check') {
    const result = await checkModule(input);
    console.log(`${result.manifest.id}@${result.manifest.version}`);
    console.log(result.digest);
    return;
  }
  if (command === 'format') {
    const result = await formatModule(input);
    console.log(`Formatted ${result.manifestPath}`);
    console.log(result.digest);
    return;
  }
  if (command === 'vendor') {
    const sourceRepository = argumentValue(args, '--source');
    const sourceCommit = argumentValue(args, '--commit');
    const license = argumentValue(args, '--license') ?? 'AGPL-3.0-only';
    if (!sourceRepository || !sourceCommit) {
      throw new Error('module:vendor requires --source <https-url> and --commit <full-sha>');
    }
    const entry = await vendorModule(input, { sourceRepository, sourceCommit, license });
    console.log(`Vendored ${entry.module_id}@${entry.version}`);
    console.log(entry.manifest_digest);
    return;
  }
  if (command === 'verify-lock') {
    const verified = await verifyVendoredModules(input);
    console.log(`Verified ${verified.length} vendored module${verified.length === 1 ? '' : 's'}`);
    return;
  }
  throw new Error(`Unknown module command: ${command}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
