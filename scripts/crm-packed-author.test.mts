import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { exportCrmAuthorProject } from './export-crm-author-project.mjs';
import { buildContactsCrmApp } from './build-crm-app.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const kitRoot = resolve(repositoryRoot, 'packages/app-kit');
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result;
}
function runPnpm(args: string[], cwd: string) {
  assert.ok(process.env.npm_execpath, 'Run packed author proof with pnpm run test:crm-author');
  return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}

test('packed public Kit builds exported CRM base/connected projects and unrelated Module edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deft-crm-packed-author-'));
  try {
    const packDir = join(root, 'pack');
    await mkdir(packDir);
    runPnpm(['--dir', kitRoot, 'pack', '--pack-destination', packDir, '--json'], repositoryRoot);
    const archiveName = (await readdir(packDir)).find((name) => name.endsWith('.tgz'));
    assert.ok(archiveName);
    const project = await exportCrmAuthorProject(join(root, 'crm-author'), join(packDir, archiveName));
    const packageJson = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    assert.equal(packageJson.dependencies['@deft/app-kit'], 'file:vendor/deft-app-kit.tgz');
    assert.ok((await readdir(join(project, 'vendor'))).includes('deft-app-kit.json'));
    runPnpm(['install', '--ignore-workspace', '--offline'], project);
    const installed = await realpath(resolve(project, 'node_modules/@deft/app-kit'));
    assert.equal(installed.startsWith(await realpath(project)), true);
    const installedPackage = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    const expectedKit = JSON.parse(await readFile(resolve(kitRoot, 'package.json'), 'utf8'));
    assert.equal(installedPackage.version, expectedKit.version);
    const installedFiles = await readdir(installed, { recursive: true });
    assert.equal(installedFiles.some((entry) => /^src[\\/]/.test(entry)), false);
    const installedText = (await Promise.all(installedFiles.filter((entry) => /\.(?:js|d\.ts)$/.test(entry)).map((entry) => readFile(resolve(installed, entry), 'utf8')))).join('\n');
    assert.doesNotMatch(installedText, /from\s+['"]@deft\/(?:db|shared|mcp|api|web)/);
    run(process.execPath, ['build.mjs'], project);
    const base = JSON.parse(await readFile(join(project, 'contacts-crm.deftapp.json'), 'utf8'));
    const baseBytes = await readFile(join(project, 'contacts-crm.deftapp.json'), 'utf8');
    await writeFile(join(project, 'base.deftapp.json'), baseBytes);
    run(process.execPath, ['build.mjs'], project);
    assert.equal(await readFile(join(project, 'contacts-crm.deftapp.json'), 'utf8'), baseBytes);
    assert.equal(base.manifest.schema_version, '0');
    assert.equal(base.manifest.version, '1.8.0');
    assert.equal('connector_requirements' in base.manifest, false);
    assert.equal('capability_requirements' in base.manifest, false);
    assert.equal('actions' in base.manifest, false);
    run(process.execPath, ['build.mjs', '--connected'], project);
    const connected = JSON.parse(await readFile(join(project, 'contacts-crm.deftapp.json'), 'utf8'));
    const connectedBytes = await readFile(join(project, 'contacts-crm.deftapp.json'), 'utf8');
    await writeFile(join(project, 'connected.deftapp.json'), connectedBytes);
    run(process.execPath, ['build.mjs', '--connected'], project);
    assert.equal(await readFile(join(project, 'contacts-crm.deftapp.json'), 'utf8'), connectedBytes);
    assert.equal(connected.manifest.version, '1.9.0');
    assert.equal(connected.manifest.connector_requirements.length, 1);
    assert.equal(connected.manifest.actions.length, 1);
    run(process.execPath, ['build.mjs', '--connected', '--app-version', '2.0.0'], project);
    const custom = JSON.parse(await readFile(join(project, 'contacts-crm.deftapp.json'), 'utf8'));
    assert.equal(custom.manifest.version, '2.0.0');
    run(process.execPath, ['build.mjs', '--connected'], project);
    const internalConnected = (await buildContactsCrmApp()).package;
    assert.deepEqual(connected.manifest, internalConnected.manifest);
    assert.deepEqual(connected.artifacts, internalConnected.artifacts);
    await writeFile(join(project, 'verify-crm.mjs'), "import { verifyDeftAppPackageJson } from '@deft/app-kit'; import { readFile } from 'node:fs/promises'; for (const f of ['base.deftapp.json','connected.deftapp.json']) await verifyDeftAppPackageJson(await readFile(f, 'utf8')); console.log('public-verify-ok');\n");
    assert.match(run(process.execPath, ['verify-crm.mjs'], project).stdout, /public-verify-ok/);
    await writeFile(join(project, 'verify-unrelated.mjs'), `import { buildDeftAppPackage, prepareModuleArtifact, verifyDeftAppPackageJson } from '@deft/app-kit';
const module = { schema_version:'1', id:'org.example.loan-assets', slug:'loan-assets', version:'1.0.0', name:'Loan Assets', collections:[{key:'assets',name:'Assets',fields:[{key:'label',label:'Label',type:'text',required:true},{key:'site',label:'Site',type:'relation',target_collection:'sites'}],views:[{key:'all',name:'All assets',type:'table',fields:['label','site']}]},{key:'sites',name:'Sites',fields:[{key:'label',label:'Label',type:'text',required:true}]}],navigation:{default_collection:'assets',default_view:'all'}};
const artifact = await prepareModuleArtifact({path:'modules/loan-assets/deft.module.json',manifest:module});
const built = await buildDeftAppPackage({manifest:{schema_version:'0',id:'org.example.loan-app',version:'1.0.0',name:'Loan App',description:'Unrelated equipment loans',license:'AGPL-3.0-only',compatibility:{app_protocol:'0'},modules:[{module_id:module.id,version:module.version,manifest_path:artifact.path,manifest_digest:artifact.digest}],navigation:[]},artifacts:[artifact]});
await verifyDeftAppPackageJson(built.json); console.log('unrelated-public-kit-ok');
`);
    const unrelated = run(process.execPath, ['verify-unrelated.mjs'], project);
    assert.match(unrelated.stdout, /unrelated-public-kit-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
