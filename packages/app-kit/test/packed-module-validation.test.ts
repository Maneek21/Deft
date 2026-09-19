import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validEquipmentModule } from './fixtures/module-semantic-negative-corpus.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

function runPnpm(args: string[], cwd: string) {
  assert.ok(process.env.npm_execpath, 'Run App Kit tests through pnpm');
  return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}

test('the actual packed Kit validates Modules in a clean external directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deft-app-kit-packed-'));
  const packDir = join(root, 'pack');
  const consumerDir = join(root, 'consumer');
  try {
    await mkdir(packDir);
    await mkdir(consumerDir);
    runPnpm(['pack', '--pack-destination', packDir], packageRoot);
    const tarballName = (await readdir(packDir)).find((name) => name.endsWith('.tgz'));
    assert.ok(tarballName, 'pnpm pack must create a tarball');
    const tarball = join(packDir, tarballName);

    await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
      name: 'external-equipment-author',
      private: true,
      type: 'module',
    }), 'utf8');
    runPnpm(['add', '--offline', '--ignore-scripts', '--ignore-workspace', '--save-dev', tarball], consumerDir);

    const invalid = structuredClone(validEquipmentModule) as Record<string, any>;
    invalid.collections[0].fields[4].target_collection = 'missing_sites';
    await writeFile(join(consumerDir, 'validate.mjs'), [
      "import { prepareModuleArtifact, validateDeftModuleManifest } from '@deft/app-kit';",
      `const valid = ${JSON.stringify(validEquipmentModule)};`,
      `const invalid = ${JSON.stringify(invalid)};`,
      "if (!validateDeftModuleManifest(valid).success) throw new Error('packed Kit rejected valid Module');",
      "const result = validateDeftModuleManifest(invalid, { artifactPath: 'modules/equipment/deft.module.json' });",
      "if (result.success) throw new Error('packed Kit accepted invalid Module semantics');",
      "if (result.issues[0]?.artifact_path !== 'modules/equipment/deft.module.json') throw new Error('missing artifact path');",
      "if (!result.issues.some((issue) => issue.field_path.includes('target_collection'))) throw new Error('missing field path');",
      "await prepareModuleArtifact({ path: 'modules/equipment/deft.module.json', manifest: valid });",
      "try { await prepareModuleArtifact({ path: 'modules/equipment/deft.module.json', manifest: invalid }); throw new Error('artifact accepted'); }",
      "catch (error) { if (error.message === 'artifact accepted') throw error; }",
    ].join('\n'), 'utf8');
    run(process.execPath, ['validate.mjs'], consumerDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
