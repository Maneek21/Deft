import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '..');
function run(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180_000 });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('outside author consumes packed Runtime Kit without workspace imports and builds a verified non-email App', async () => {
  assert.ok(process.env.npm_execpath, 'Run with pnpm');
  const root = await mkdtemp(join(tmpdir(), 'deft-runtime-author-'));
  const pack = join(root, 'pack'); const project = join(root, 'author');
  await mkdir(pack); await mkdir(project);
  run([process.env.npm_execpath, '--dir', join(repo, 'packages/app-kit'), 'pack', '--pack-destination', pack, '--json'], repo);
  const archive = (await readdir(pack)).find((name) => name.endsWith('.tgz'));
  assert.ok(archive);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'independent-runtime-author', private: true, type: 'module',
    dependencies: { '@deft/app-kit': `file:${join(pack, archive).replaceAll('\\', '/')}` } }));
  run([process.env.npm_execpath, 'install', '--ignore-workspace', '--offline', '--ignore-scripts'], project);
  const installed = await realpath(join(project, 'node_modules/@deft/app-kit'));
  assert.ok(installed.startsWith(await realpath(project)));
  assert.ok(!(await readdir(installed)).includes('src'));
  const cli = join(installed, 'dist/cli.js');
  run([cli, 'app', 'init', '--template', 'runtime'], project);
  run([cli, 'app', 'check'], project); run([cli, 'app', 'build'], project);
  const artifact = await readFile(join(project, '.deft/app.deftapp.json'), 'utf8');
  run([cli, 'app', 'build'], project);
  assert.equal(await readFile(join(project, '.deft/app.deftapp.json'), 'utf8'), artifact);
  await writeFile(join(project, 'verify.mjs'), "import {verifyDeftAppPackageJson,parseRuntimeObjectInput,createAppRuntimeClient} from '@deft/app-kit'; import {readFile} from 'node:fs/promises'; if(typeof createAppRuntimeClient!=='function') throw Error('runtime transport export'); const p=await verifyDeftAppPackageJson(await readFile('.deft/app.deftapp.json','utf8')); if(p.package.manifest.schema_version!=='3') throw Error('protocol'); parseRuntimeObjectInput(p.package.manifest.private_capabilities[0].input_schema,{shipment_id:'synthetic-1'}); console.log(p.digest);\n");
  assert.match(run(['verify.mjs'], project), /sha256:[a-f0-9]{64}/);
  if (process.env.DEFT_RUNTIME_AUTHOR_PACKAGE) await writeFile(process.env.DEFT_RUNTIME_AUTHOR_PACKAGE, artifact);
  console.log(`Independent author artifact: ${join(project, '.deft/app.deftapp.json')}`);
});
