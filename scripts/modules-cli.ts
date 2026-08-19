import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFT_MODULE_MANIFEST_FILENAME,
  MODULE_LIMITS,
  ModuleIdSchema,
  ModuleSemverSchema,
  ModuleSlugSchema,
  canonicalizeModuleManifest,
  digestModuleManifest,
  getDeftModuleManifestV1JsonSchema,
  parseDeftModuleManifest,
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

type GitProvenance = {
  repositoryRoot: string;
  sourceCommit: string;
  manifest: DeftModuleManifestV1;
  digest: string;
};

export type VerifyVendoredModulesOptions = {
  /**
   * The manifests exposed by the runtime catalog. Supplying this makes the
   * lock a two-way allowlist: every runtime module must be locked and every
   * locked module must be present at runtime.
   */
  runtimeCatalog?: readonly DeftModuleManifestV1[];
  /** Internal: the vendor command owns the exclusive lock while preflighting. */
  allowVendorLock?: boolean;
};

const MODULE_LOCK_FILENAME = 'modules.lock.json';
const VENDOR_LOCK_FILENAME = '.modules-vendor.lock';
const MODULE_LOCK_MAX_BYTES = 1024 * 1024;
const LOCK_ENTRY_KEYS = Object.freeze([
  'license',
  'manifest_digest',
  'manifest_path',
  'module_id',
  'slug',
  'source_commit',
  'source_repository',
  'version',
] as const);

function prettyCanonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalizeModuleManifest(value), null, 2)}\n`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!isContainedPath(absoluteRoot, absoluteCandidate)) {
    throw new Error(`Path escapes the allowed root: ${absoluteCandidate}`);
  }

  const rootInfo = await lstat(absoluteRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Root must be a real directory, not a symlink: ${absoluteRoot}`);
  }

  const child = relative(absoluteRoot, absoluteCandidate);
  if (!child) return;
  let cursor = absoluteRoot;
  for (const component of child.split(sep)) {
    cursor = join(cursor, component);
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink in module distribution path: ${cursor}`);
    }
  }
}

async function assertInputPathHasNoSymlinkComponents(
  physicalRoot: string,
  inputPath: string,
): Promise<void> {
  let cursor = resolve(inputPath);
  while (true) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink in module source path: ${cursor}`);
    }
    const physicalCursor = await realpath(cursor);
    if (relative(physicalRoot, physicalCursor) === '') return;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('Module source path is not rooted in its Git worktree');
    cursor = parent;
  }
}

async function writeNewFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
}

export async function resolveModuleManifestPath(inputPath: string): Promise<string> {
  const absolute = resolve(inputPath);
  const info = await lstat(absolute).catch(() => null);
  if (!info) throw new Error(`Module path does not exist: ${absolute}`);
  if (info.isSymbolicLink()) throw new Error(`Module path must not be a symlink: ${absolute}`);
  if (info.isDirectory()) return join(absolute, DEFT_MODULE_MANIFEST_FILENAME);
  if (!info.isFile()) throw new Error(`Module path is not a file or directory: ${absolute}`);
  return absolute;
}

export async function checkModule(inputPath: string): Promise<CheckedModule> {
  const manifestPath = await resolveModuleManifestPath(inputPath);
  const info = await lstat(manifestPath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error(`Missing real ${DEFT_MODULE_MANIFEST_FILENAME} file: ${manifestPath}`);
  }
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
  const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to initialize through a symlink: ${directory}`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`Module destination must be a directory: ${directory}`);
  }
  if (existing) {
    const entries = await readdir(directory);
    if (entries.length > 0) {
      throw new Error(`Module destination must be empty; refusing to overwrite: ${directory}`);
    }
  } else {
    await mkdir(directory, { recursive: true });
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

  // Every write is create-only. If another process races us and puts a file
  // into the destination, initialization fails without overwriting it.
  await mkdir(join(directory, 'fixtures'));
  await mkdir(join(directory, 'screenshots'));
  await writeNewFile(join(directory, DEFT_MODULE_MANIFEST_FILENAME), prettyCanonicalJson(manifest));
  await writeNewFile(
    join(directory, 'README.md'),
    `# ${manifest.name}\n\nA declarative module for [Deft](https://github.com/Maneek21/Deft).\n\n## Validate\n\n\`pnpm module:check .\`\n`,
  );
  await writeNewFile(join(directory, 'CHANGELOG.md'), '# Changelog\n\n## 0.1.0\n\n- Initial manifest.\n');
  await writeNewFile(
    join(directory, 'CONTRIBUTING.md'),
    '# Contributing\n\nValidate `deft.module.json`, add fixtures for schema changes, and use semantic versions.\n',
  );
  await writeNewFile(join(directory, 'fixtures', 'demo-records.json'), '[]\n');
  await writeNewFile(
    join(directory, 'deft.module.schema.json'),
    `${JSON.stringify(getDeftModuleManifestV1JsonSchema(), null, 2)}\n`,
  );

  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const licensePath = join(rootDirectory, 'LICENSE');
  const licenseInfo = await lstat(licensePath).catch(() => null);
  if (licenseInfo?.isFile() && !licenseInfo.isSymbolicLink()) {
    await writeNewFile(join(directory, 'LICENSE'), await readFile(licensePath, 'utf8'));
  }
  return checkModule(join(directory, DEFT_MODULE_MANIFEST_FILENAME));
}

function validateSourceRepository(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Source repository must be an absolute HTTPS URL');
  }
  if (
    url.protocol !== 'https:'
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('Source repository must be a plain HTTPS URL without credentials, query, or fragment');
  }
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!pathname || pathname === '/') throw new Error('Source repository URL must include a repository path');
  return `https://${url.host.toLowerCase()}${pathname}`;
}

function repositoryIdentity(value: string): string {
  if (/^git@[^:]+:.+/.test(value)) {
    const [, host, path] = /^git@([^:]+):(.+)$/.exec(value) ?? [];
    return `https://${host.toLowerCase()}/${path.replace(/\/+$/, '').replace(/\.git$/i, '')}`;
  }
  if (value.startsWith('ssh://')) {
    const url = new URL(value);
    const pathname = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    return `https://${url.host.toLowerCase()}/${pathname}`;
  }
  return validateSourceRepository(value);
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

function gitText(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    throw new Error(stderr || `Git command failed: git ${args.join(' ')}`);
  }
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: MODULE_LIMITS.manifest_bytes + 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
    throw new Error(stderr || `Git command failed: git ${args.join(' ')}`);
  }
}

function gitSucceeds(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

async function proveGitProvenance(
  checked: CheckedModule,
  sourceRepository: string,
  sourceCommit: string,
): Promise<GitProvenance> {
  const manifestPath = resolve(checked.manifestPath);
  if (basename(manifestPath) !== DEFT_MODULE_MANIFEST_FILENAME) {
    throw new Error(`Vendored source must be named ${DEFT_MODULE_MANIFEST_FILENAME}`);
  }
  const manifestDirectory = dirname(manifestPath);
  let repositoryRoot: string;
  try {
    repositoryRoot = resolve(gitText(manifestDirectory, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new Error('Module vendoring requires a local Git worktree');
  }
  const physicalRepositoryRoot = await realpath(repositoryRoot);
  const physicalManifestPath = await realpath(manifestPath);
  await assertNoSymlinkComponents(physicalRepositoryRoot, physicalManifestPath);
  await assertInputPathHasNoSymlinkComponents(physicalRepositoryRoot, manifestPath);
  if (!isContainedPath(physicalRepositoryRoot, physicalManifestPath)) {
    throw new Error('Module manifest escapes its Git worktree');
  }
  const relativeManifestPath = relative(physicalRepositoryRoot, physicalManifestPath).split(sep).join('/');
  if (!relativeManifestPath || relativeManifestPath.startsWith('../')) {
    throw new Error('Module manifest must be a file inside its Git worktree');
  }

  const status = gitText(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error('Module source Git worktree must be completely clean before vendoring');

  const headCommit = gitText(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase();
  if (headCommit !== sourceCommit) {
    throw new Error(`Source commit does not match clean worktree HEAD (${headCommit})`);
  }

  const origin = gitText(repositoryRoot, ['remote', 'get-url', 'origin']);
  let originIdentity: string;
  try {
    originIdentity = repositoryIdentity(origin);
  } catch {
    throw new Error('Git origin must be an HTTPS or SSH repository URL');
  }
  if (originIdentity !== sourceRepository) {
    throw new Error(`Source repository does not match Git origin (${originIdentity})`);
  }

  const staged = gitText(repositoryRoot, ['ls-files', '--stage', '--', relativeManifestPath]);
  const stageMatch = /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t/.exec(staged);
  if (!stageMatch) {
    throw new Error('Module manifest must be a tracked regular file, not a symlink');
  }

  const blobObject = gitText(repositoryRoot, [
    'rev-parse',
    '--verify',
    `${sourceCommit}:${relativeManifestPath}`,
  ]);
  if (gitText(repositoryRoot, ['cat-file', '-t', blobObject]) !== 'blob') {
    throw new Error('Source commit manifest path is not a Git blob');
  }
  const blob = gitBuffer(repositoryRoot, ['cat-file', 'blob', blobObject]);
  if (blob.byteLength > MODULE_LIMITS.manifest_bytes) {
    throw new Error(`Committed manifest exceeds ${MODULE_LIMITS.manifest_bytes} bytes`);
  }
  const committedManifest = parseDeftModuleManifestJson(blob.toString('utf8'));
  const committedDigest = await digestModuleManifest(committedManifest);
  if (committedDigest !== checked.digest) {
    throw new Error('Working manifest does not match the exact manifest blob at the source commit');
  }

  if (gitText(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('Module source Git worktree changed during provenance verification');
  }
  if (gitText(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase() !== sourceCommit) {
    throw new Error('Module source HEAD changed during provenance verification');
  }

  return {
    repositoryRoot,
    sourceCommit,
    manifest: committedManifest,
    digest: committedDigest,
  };
}

function parseLockEntry(value: unknown, lockPath: string): ModuleLockEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid module lock entry in ${lockPath}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join('\0') !== [...LOCK_ENTRY_KEYS].sort().join('\0')) {
    throw new Error(`Module lock entry has missing or unknown fields in ${lockPath}`);
  }
  if (
    typeof record.module_id !== 'string'
    || typeof record.slug !== 'string'
    || typeof record.version !== 'string'
    || typeof record.manifest_digest !== 'string'
    || typeof record.manifest_path !== 'string'
    || typeof record.source_repository !== 'string'
    || typeof record.source_commit !== 'string'
    || typeof record.license !== 'string'
  ) {
    throw new Error(`Module lock entry fields must be strings in ${lockPath}`);
  }

  const moduleId = ModuleIdSchema.parse(record.module_id);
  const slug = ModuleSlugSchema.parse(record.slug);
  const version = ModuleSemverSchema.parse(record.version);
  if (!/^sha256:[a-f0-9]{64}$/.test(record.manifest_digest)) {
    throw new Error(`Invalid manifest digest for locked module ${moduleId}`);
  }
  const sourceRepository = validateSourceRepository(record.source_repository);
  if (sourceRepository !== record.source_repository) {
    throw new Error(`Source repository is not canonical for locked module ${moduleId}`);
  }

  return {
    module_id: moduleId,
    slug,
    version,
    manifest_digest: record.manifest_digest,
    manifest_path: record.manifest_path,
    source_repository: sourceRepository,
    source_commit: validateSourceCommit(record.source_commit),
    license: validateLicense(record.license),
  };
}

async function readModuleLock(lockPath: string): Promise<ModuleLock> {
  const info = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { schema_version: '1', modules: [] };
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Module lock must be a real file: ${lockPath}`);
  }
  if (info.size > MODULE_LOCK_MAX_BYTES) throw new Error(`Module lock is too large: ${lockPath}`);

  let value: unknown;
  try {
    value = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    throw new Error(`Invalid JSON in module lock: ${lockPath}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid module lock: ${lockPath}`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== ['modules', 'schema_version'].join('\0')
    || record.schema_version !== '1'
    || !Array.isArray(record.modules)
  ) {
    throw new Error(`Invalid module lock: ${lockPath}`);
  }
  const modules = record.modules.map((entry) => parseLockEntry(entry, lockPath));
  const sortedIds = modules.map((entry) => entry.module_id).sort(compareText);
  if (modules.some((entry, index) => entry.module_id !== sortedIds[index])) {
    throw new Error(`Module lock entries must be sorted by module_id: ${lockPath}`);
  }
  return { schema_version: '1', modules };
}

async function listVendoredArtifactSlugs(root: string): Promise<string[]> {
  const bundledDirectory = join(root, 'modules', 'bundled');
  const info = await lstat(bundledDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return [];
  await assertNoSymlinkComponents(root, bundledDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Bundled modules path must be a real directory: ${bundledDirectory}`);
  }

  const slugs: string[] = [];
  for (const entry of await readdir(bundledDirectory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Unexpected entry in bundled module directory: ${entry.name}`);
    }
    ModuleSlugSchema.parse(entry.name);
    const moduleDirectory = join(bundledDirectory, entry.name);
    await assertNoSymlinkComponents(root, moduleDirectory);
    const contents = await readdir(moduleDirectory, { withFileTypes: true });
    if (
      contents.length !== 1
      || contents[0]?.name !== DEFT_MODULE_MANIFEST_FILENAME
      || !contents[0].isFile()
      || contents[0].isSymbolicLink()
    ) {
      throw new Error(
        `Bundled module ${entry.name} must contain exactly one real ${DEFT_MODULE_MANIFEST_FILENAME}`,
      );
    }
    slugs.push(entry.name);
  }
  return slugs.sort();
}

export async function verifyVendoredModules(
  rootDirectory = process.cwd(),
  options: VerifyVendoredModulesOptions = {},
): Promise<ModuleLockEntry[]> {
  const root = resolve(rootDirectory);
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Verification root must be a real directory: ${root}`);
  }
  const lockPath = join(root, 'modules', MODULE_LOCK_FILENAME);
  const vendorLockPath = join(root, 'modules', VENDOR_LOCK_FILENAME);
  if (!options.allowVendorLock && await pathExists(vendorLockPath)) {
    throw new Error('Module vendoring is in progress; refusing a potentially inconsistent verification');
  }
  const modulesDirectory = dirname(lockPath);
  if (await pathExists(modulesDirectory)) await assertNoSymlinkComponents(root, modulesDirectory);
  const lock = await readModuleLock(lockPath);
  const moduleIds = new Set<string>();
  const slugs = new Set<string>();
  const verified: ModuleLockEntry[] = [];

  for (const entry of lock.modules) {
    if (moduleIds.has(entry.module_id)) throw new Error(`Duplicate locked module id: ${entry.module_id}`);
    if (slugs.has(entry.slug)) throw new Error(`Duplicate locked module slug: ${entry.slug}`);
    moduleIds.add(entry.module_id);
    slugs.add(entry.slug);

    const expectedPath = `modules/bundled/${entry.slug}/${DEFT_MODULE_MANIFEST_FILENAME}`;
    if (entry.manifest_path !== expectedPath) {
      throw new Error(`Locked manifest path must be ${expectedPath}`);
    }
    const manifestPath = join(root, ...entry.manifest_path.split('/'));
    await assertNoSymlinkComponents(root, manifestPath);
    const checked = await checkModule(manifestPath);
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

  const artifactSlugs = await listVendoredArtifactSlugs(root);
  for (const slug of artifactSlugs) {
    if (!slugs.has(slug)) throw new Error(`Vendored module artifact is missing a lock entry: ${slug}`);
  }
  for (const slug of slugs) {
    if (!artifactSlugs.includes(slug)) throw new Error(`Locked module is missing its artifact: ${slug}`);
  }

  if (options.runtimeCatalog) {
    const runtimeIds = new Set<string>();
    const runtimeSlugs = new Set<string>();
    for (const rawManifest of options.runtimeCatalog) {
      const manifest = parseDeftModuleManifest(rawManifest);
      if (runtimeIds.has(manifest.id)) throw new Error(`Duplicate runtime bundled module id: ${manifest.id}`);
      if (runtimeSlugs.has(manifest.slug)) throw new Error(`Duplicate runtime bundled module slug: ${manifest.slug}`);
      runtimeIds.add(manifest.id);
      runtimeSlugs.add(manifest.slug);
      const entry = lock.modules.find((candidate) => candidate.module_id === manifest.id);
      if (!entry) throw new Error(`Runtime bundled module is missing a lock entry: ${manifest.id}`);
      const digest = await digestModuleManifest(manifest);
      if (
        entry.slug !== manifest.slug
        || entry.version !== manifest.version
        || entry.manifest_digest !== digest
      ) {
        throw new Error(`Runtime bundled module does not match its locked artifact: ${manifest.id}`);
      }
    }
    for (const entry of lock.modules) {
      if (!runtimeIds.has(entry.module_id)) {
        throw new Error(`Locked module is absent from the runtime bundled catalog: ${entry.module_id}`);
      }
    }
  }
  return verified;
}

type ParsedSemver = {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[] | null;
};

function parseSemver(value: string): ParsedSemver {
  ModuleSemverSchema.parse(value);
  const withoutBuild = value.split('+', 1)[0] ?? value;
  const prereleaseSeparator = withoutBuild.indexOf('-');
  const core = prereleaseSeparator === -1
    ? withoutBuild
    : withoutBuild.slice(0, prereleaseSeparator);
  const prereleaseSource = prereleaseSeparator === -1
    ? undefined
    : withoutBuild.slice(prereleaseSeparator + 1);
  const [major, minor, patch] = core!.split('.');
  return {
    major: BigInt(major!),
    minor: BigInt(minor!),
    patch: BigInt(patch!),
    prerelease: prereleaseSource ? prereleaseSource.split('.') : null,
  };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function stageAtomicFile(targetPath: string, contents: string): Promise<string> {
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, 'wx', 0o644);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporaryPath;
}

async function replaceVendoredPair(
  manifestPath: string,
  manifestContents: string,
  lockPath: string,
  lockContents: string,
): Promise<void> {
  const stagedManifest = await stageAtomicFile(manifestPath, manifestContents);
  let stagedLock: string | null = null;
  try {
    stagedLock = await stageAtomicFile(lockPath, lockContents);
    // The lock is the commit point. A crash after the manifest rename but
    // before the lock rename is fail-closed: module:verify detects the digest
    // mismatch and the runtime still cannot silently accept new provenance.
    await rename(stagedManifest, manifestPath);
    await rename(stagedLock, lockPath);
    stagedLock = null;
  } finally {
    await rm(stagedManifest, { force: true });
    if (stagedLock) await rm(stagedLock, { force: true });
  }
}

async function acquireVendorLock(modulesDirectory: string): Promise<() => Promise<void>> {
  const lockPath = join(modulesDirectory, VENDOR_LOCK_FILENAME);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Another module vendor operation is in progress (${lockPath})`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return async () => {
    try {
      await handle.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  };
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
  const rootInfo = await lstat(rootDirectory).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Vendoring root must be a real directory: ${rootDirectory}`);
  }
  const checked = await checkModule(inputPath);
  const sourceRepository = validateSourceRepository(options.sourceRepository);
  const sourceCommit = validateSourceCommit(options.sourceCommit);
  const license = validateLicense(options.license);
  const provenance = await proveGitProvenance(checked, sourceRepository, sourceCommit);

  const modulesDirectory = join(rootDirectory, 'modules');
  await mkdir(modulesDirectory, { recursive: true });
  await assertNoSymlinkComponents(rootDirectory, modulesDirectory);
  const releaseLock = await acquireVendorLock(modulesDirectory);
  try {
    const lockPath = join(modulesDirectory, MODULE_LOCK_FILENAME);
    const lock = await readModuleLock(lockPath);
    await verifyVendoredModules(rootDirectory, { allowVendorLock: true });

    const existing = lock.modules.find((entry) => entry.module_id === provenance.manifest.id);
    const slugOwner = lock.modules.find(
      (entry) => entry.slug === provenance.manifest.slug && entry.module_id !== provenance.manifest.id,
    );
    if (slugOwner) throw new Error(`Module slug is already pinned by ${slugOwner.module_id}`);
    if (existing) {
      if (existing.slug !== provenance.manifest.slug) {
        throw new Error(`Module slug cannot change from ${existing.slug} to ${provenance.manifest.slug}`);
      }
      if (existing.source_repository !== sourceRepository) {
        throw new Error(`Module source repository cannot change for ${existing.module_id}`);
      }
      if (existing.license !== license) {
        throw new Error(`Module license cannot change during vendoring for ${existing.module_id}`);
      }
      if (compareSemver(existing.version, provenance.manifest.version) >= 0) {
        throw new Error(
          `Vendored version must be strictly newer than ${existing.version}; received ${provenance.manifest.version}`,
        );
      }
      if (!gitSucceeds(provenance.repositoryRoot, [
        'merge-base',
        '--is-ancestor',
        existing.source_commit,
        provenance.sourceCommit,
      ])) {
        throw new Error('New source commit must descend from the previously locked source commit');
      }
    }

    const relativeManifestPath = `modules/bundled/${provenance.manifest.slug}/${DEFT_MODULE_MANIFEST_FILENAME}`;
    const targetPath = join(rootDirectory, ...relativeManifestPath.split('/'));
    const targetDirectory = dirname(targetPath);
    await mkdir(targetDirectory, { recursive: true });
    await assertNoSymlinkComponents(rootDirectory, targetDirectory);
    await assertNoSymlinkComponents(rootDirectory, targetPath);

    const entry: ModuleLockEntry = {
      module_id: provenance.manifest.id,
      slug: provenance.manifest.slug,
      version: provenance.manifest.version,
      manifest_digest: provenance.digest,
      manifest_path: relativeManifestPath,
      source_repository: sourceRepository,
      source_commit: provenance.sourceCommit,
      license,
    };
    const modules = lock.modules
      .filter((item) => item.module_id !== entry.module_id)
      .concat(entry)
      .sort((left, right) => compareText(left.module_id, right.module_id));

    await replaceVendoredPair(
      targetPath,
      prettyCanonicalJson(provenance.manifest),
      lockPath,
      `${JSON.stringify({ schema_version: '1', modules }, null, 2)}\n`,
    );
    return entry;
  } finally {
    await releaseLock();
  }
}

export async function loadRuntimeBundledCatalog(rootDirectory: string): Promise<DeftModuleManifestV1[]> {
  const root = resolve(rootDirectory);
  const runtimeCatalogPath = join(root, 'apps', 'api', 'src', 'lib', 'bundled-modules.ts');
  const info = await stat(runtimeCatalogPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Runtime bundled catalog is missing: ${runtimeCatalogPath}`);
  const moduleUrl = `${pathToFileURL(runtimeCatalogPath).href}?module-verify=${Date.now()}`;
  const runtimeModule = await import(moduleUrl) as {
    listBundledModules?: () => unknown;
  };
  if (typeof runtimeModule.listBundledModules !== 'function') {
    throw new Error('Runtime bundled catalog must export listBundledModules()');
  }
  const catalog = runtimeModule.listBundledModules();
  if (!Array.isArray(catalog)) throw new Error('Runtime bundled catalog must return an array');
  return catalog.map((manifest) => parseDeftModuleManifest(manifest));
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
    const runtimeCatalog = await loadRuntimeBundledCatalog(input);
    const verified = await verifyVendoredModules(input, { runtimeCatalog });
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
