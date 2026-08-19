import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DeftModuleManifestV1 } from '@deft/shared/modules';
import {
  checkModule,
  formatModule,
  initModuleProject,
  vendorModule,
  verifyVendoredModules,
} from './modules-cli.js';

const SOURCE_REPOSITORY = 'https://github.com/deft-modules/deft-module-contacts';

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'deft-modules-cli-'));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function createCore(root: string): Promise<string> {
  const core = join(root, 'core');
  await mkdir(join(core, 'modules'), { recursive: true });
  await writeFile(
    join(core, 'modules', 'modules.lock.json'),
    '{\n  "schema_version": "1",\n  "modules": []\n}\n',
    'utf8',
  );
  return core;
}

async function createGitModule(
  root: string,
): Promise<{ project: string; commit: string; manifest: DeftModuleManifestV1 }> {
  const project = join(root, 'deft-module-contacts');
  const checked = await initModuleProject(project, { rootDirectory: root });
  git(project, ['init']);
  git(project, ['config', 'user.name', 'Deft Module Tests']);
  git(project, ['config', 'user.email', 'modules@example.test']);
  git(project, ['config', 'core.autocrlf', 'false']);
  git(project, ['remote', 'add', 'origin', `${SOURCE_REPOSITORY}.git`]);
  git(project, ['add', '-A']);
  git(project, ['commit', '-m', 'Initial module']);
  return {
    project,
    commit: git(project, ['rev-parse', 'HEAD']),
    manifest: checked.manifest,
  };
}

async function updateManifestAndCommit(
  project: string,
  mutate: (manifest: Record<string, unknown>) => void,
  message: string,
): Promise<{ commit: string; manifest: DeftModuleManifestV1 }> {
  const manifestPath = join(project, 'deft.module.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const checked = await formatModule(project);
  git(project, ['add', 'deft.module.json']);
  git(project, ['commit', '-m', message]);
  return { commit: git(project, ['rev-parse', 'HEAD']), manifest: checked.manifest };
}

test('init requires a nonexistent or empty destination and never overwrites unrelated files', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'LICENSE'), 'test license\n', 'utf8');

  const project = join(root, 'deft-module-equipment-register');
  const checked = await initModuleProject(project, { rootDirectory: root });
  assert.equal(checked.manifest.slug, 'equipment-register');
  assert.equal(checked.manifest.id, 'community.example.equipment-register');
  assert.match(checked.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await readFile(join(project, 'LICENSE'), 'utf8'), 'test license\n');
  assert.match(
    await readFile(join(project, 'deft.module.schema.json'), 'utf8'),
    /Deft declarative module manifest v1/,
  );
  await assert.rejects(
    () => initModuleProject(project, { rootDirectory: root }),
    /must be empty; refusing to overwrite/,
  );

  const unrelated = join(root, 'existing-project');
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'KEEP.txt'), 'do not replace\n', 'utf8');
  await assert.rejects(
    () => initModuleProject(unrelated, { rootDirectory: root }),
    /must be empty; refusing to overwrite/,
  );
  assert.equal(await readFile(join(unrelated, 'KEEP.txt'), 'utf8'), 'do not replace\n');

  const empty = join(root, 'deft-module-empty-start');
  await mkdir(empty);
  assert.equal((await initModuleProject(empty, { rootDirectory: root })).manifest.slug, 'empty-start');
});

test('check and format produce a stable digest for differently ordered JSON', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'deft-module-content-calendar');
  const initial = await initModuleProject(project, { rootDirectory: root });
  const parsed = JSON.parse(await readFile(join(project, 'deft.module.json'), 'utf8'));
  await writeFile(
    join(project, 'deft.module.json'),
    JSON.stringify({
      collections: parsed.collections,
      name: parsed.name,
      version: parsed.version,
      slug: parsed.slug,
      id: parsed.id,
      icon: parsed.icon,
      description: parsed.description,
      schema_version: parsed.schema_version,
    }),
    'utf8',
  );
  assert.equal((await checkModule(project)).digest, initial.digest);
  assert.equal((await formatModule(project)).digest, initial.digest);
  assert.match(await readFile(join(project, 'deft.module.json'), 'utf8'), /^\{\n  "collections"/);
});

test('vendor proves a clean Git HEAD, origin, and exact committed manifest blob', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = await createCore(root);
  const source = await createGitModule(root);

  const entry = await vendorModule(source.project, {
    rootDirectory: core,
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: source.commit,
    license: 'AGPL-3.0-only',
  });
  assert.equal(entry.source_commit, source.commit);
  assert.equal(entry.source_repository, SOURCE_REPOSITORY);
  assert.equal(entry.manifest_digest, (await checkModule(source.project)).digest);
  assert.deepEqual(
    await verifyVendoredModules(core, { runtimeCatalog: [source.manifest] }),
    [entry],
  );

  const pinnedPath = join(core, entry.manifest_path);
  const tampered = JSON.parse(await readFile(pinnedPath, 'utf8'));
  tampered.description = 'Tampered after the lock was written.';
  await writeFile(pinnedPath, JSON.stringify(tampered), 'utf8');
  await assert.rejects(() => verifyVendoredModules(core), /Locked digest does not match/);
});

test('vendor rejects dirty worktrees, wrong commits, wrong origins, and blob mismatches', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = await createCore(root);
  const source = await createGitModule(root);
  const options = {
    rootDirectory: core,
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: source.commit,
    license: 'AGPL-3.0-only',
  };

  await writeFile(join(source.project, 'README.md'), 'dirty\n', 'utf8');
  await assert.rejects(() => vendorModule(source.project, options), /worktree must be completely clean/);
  git(source.project, ['restore', 'README.md']);

  await assert.rejects(
    () => vendorModule(source.project, { ...options, sourceCommit: 'a'.repeat(40) }),
    /does not match clean worktree HEAD/,
  );
  await assert.rejects(
    () => vendorModule(source.project, {
      ...options,
      sourceRepository: 'https://github.com/example/different-module',
    }),
    /does not match Git origin/,
  );
  await assert.rejects(
    () => vendorModule(source.project, {
      ...options,
      sourceRepository: 'https://user:token@github.com/private/repo',
    }),
    /without credentials/,
  );

  git(source.project, ['update-index', '--assume-unchanged', 'deft.module.json']);
  const manifestPath = join(source.project, 'deft.module.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.description = 'Hidden working-tree replacement.';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  assert.equal(git(source.project, ['status', '--porcelain=v1']), '');
  await assert.rejects(() => vendorModule(source.project, options), /does not match the exact manifest blob/);
  git(source.project, ['update-index', '--no-assume-unchanged', 'deft.module.json']);
});

test('vendor enforces source continuity and strictly increasing semantic versions', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = await createCore(root);
  const source = await createGitModule(root);
  const common = {
    rootDirectory: core,
    sourceRepository: SOURCE_REPOSITORY,
    license: 'AGPL-3.0-only',
  };
  await vendorModule(source.project, { ...common, sourceCommit: source.commit });

  const replacement = await updateManifestAndCommit(
    source.project,
    (manifest) => { manifest.description = 'Different digest at the same version.'; },
    'Attempt same-version replacement',
  );
  await assert.rejects(
    () => vendorModule(source.project, { ...common, sourceCommit: replacement.commit }),
    /must be strictly newer/,
  );

  const downgrade = await updateManifestAndCommit(
    source.project,
    (manifest) => { manifest.version = '0.0.9'; },
    'Attempt downgrade',
  );
  await assert.rejects(
    () => vendorModule(source.project, { ...common, sourceCommit: downgrade.commit }),
    /must be strictly newer/,
  );

  const upgrade = await updateManifestAndCommit(
    source.project,
    (manifest) => { manifest.version = '0.2.0'; },
    'Release 0.2.0',
  );
  const entry = await vendorModule(source.project, { ...common, sourceCommit: upgrade.commit });
  assert.equal(entry.version, '0.2.0');
  assert.deepEqual(
    await verifyVendoredModules(core, { runtimeCatalog: [upgrade.manifest] }),
    [entry],
  );

  const next = await updateManifestAndCommit(
    source.project,
    (manifest) => { manifest.version = '0.3.0'; },
    'Prepare 0.3.0',
  );
  const replacementRepository = 'https://github.com/deft-modules/contacts-replacement';
  git(source.project, ['remote', 'set-url', 'origin', replacementRepository]);
  await assert.rejects(
    () => vendorModule(source.project, {
      ...common,
      sourceRepository: replacementRepository,
      sourceCommit: next.commit,
    }),
    /source repository cannot change/,
  );
  git(source.project, ['remote', 'set-url', 'origin', SOURCE_REPOSITORY]);

  const tree = git(source.project, ['rev-parse', `${next.commit}^{tree}`]);
  const divergentCommit = git(source.project, [
    'commit-tree',
    tree,
    '-p',
    source.commit,
    '-m',
    'Divergent 0.3.0 release',
  ]);
  git(source.project, ['reset', '--hard', divergentCommit]);
  await assert.rejects(
    () => vendorModule(source.project, { ...common, sourceCommit: divergentCommit }),
    /must descend from the previously locked source commit/,
  );
});

test('vendor serializes writers and rejects symlink escapes in bundled paths', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = await createCore(root);
  const source = await createGitModule(root);
  const options = {
    rootDirectory: core,
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: source.commit,
    license: 'AGPL-3.0-only',
  };

  const writerLock = join(core, 'modules', '.modules-vendor.lock');
  await writeFile(writerLock, 'held\n', 'utf8');
  await assert.rejects(() => vendorModule(source.project, options), /Another module vendor operation/);
  await rm(writerLock);

  const outside = join(root, 'outside-target');
  await mkdir(outside);
  await mkdir(join(core, 'modules', 'bundled'), { recursive: true });
  try {
    await symlink(outside, join(core, 'modules', 'bundled', 'contacts'), 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Creating a junction is not permitted in this test environment');
      return;
    }
    throw error;
  }
  await assert.rejects(() => vendorModule(source.project, options), /symlink|Unexpected entry/);
});

test('verify-lock rejects orphan artifacts, unlocked runtime modules, and catalog drift', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = await createCore(root);
  const source = await createGitModule(root);

  await assert.rejects(
    () => verifyVendoredModules(core, { runtimeCatalog: [source.manifest] }),
    /Runtime bundled module is missing a lock entry/,
  );

  const orphanDirectory = join(core, 'modules', 'bundled', source.manifest.slug);
  await mkdir(orphanDirectory, { recursive: true });
  await writeFile(
    join(orphanDirectory, 'deft.module.json'),
    await readFile(join(source.project, 'deft.module.json'), 'utf8'),
    'utf8',
  );
  await assert.rejects(() => verifyVendoredModules(core), /artifact is missing a lock entry/);
  await rm(join(core, 'modules', 'bundled'), { recursive: true, force: true });

  const entry = await vendorModule(source.project, {
    rootDirectory: core,
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: source.commit,
    license: 'AGPL-3.0-only',
  });
  await assert.rejects(
    () => verifyVendoredModules(core, { runtimeCatalog: [] }),
    /Locked module is absent from the runtime bundled catalog/,
  );
  const drifted = structuredClone(source.manifest);
  drifted.description = 'Runtime hardcoded truth drifted away from its offline artifact.';
  await assert.rejects(
    () => verifyVendoredModules(core, { runtimeCatalog: [drifted] }),
    /does not match its locked artifact/,
  );
  assert.deepEqual(
    await verifyVendoredModules(core, { runtimeCatalog: [source.manifest] }),
    [entry],
  );
});
