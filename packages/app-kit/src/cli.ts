#!/usr/bin/env node
import { mkdir, readFile, writeFile, access, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  buildDeftAppPackage,
  parseDeftAppManifest,
  prepareModuleArtifact,
  type DeftAppManifestV0Input,
} from './index.js';

const cwd = process.cwd();

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function assertRegularUnslinkedFile(relativePath: string): Promise<string> {
  let current = cwd;
  for (const segment of relativePath.split('/')) {
    current = resolve(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`App artifacts cannot traverse symbolic links: ${relativePath}`);
  }
  const stat = await lstat(current);
  if (!stat.isFile()) throw new Error(`App artifact is not a regular file: ${relativePath}`);
  return current;
}

async function initialize(): Promise<void> {
  const manifestPath = resolve(cwd, 'deft.app.json');
  if (await exists(manifestPath)) throw new Error('deft.app.json already exists');
  const modulePath = 'modules/hello-workspace/deft.module.json';
  const moduleManifest = {
    schema_version: '1',
    id: 'community.example.hello-workspace',
    slug: 'hello-workspace',
    version: '1.0.0',
    name: 'Hello Workspace',
    description: 'A minimal declarative App authored outside Deft core.',
    collections: [{
      key: 'greetings',
      name: 'Greetings',
      singular_name: 'Greeting',
      fields: [{ key: 'message', label: 'Message', type: 'text', required: true }],
      views: [{ key: 'all', name: 'All greetings', type: 'table', fields: ['message'] }],
      search: { title_field: 'message', subtitle_fields: [], fields: ['message'] },
    }],
    navigation: { default_collection: 'greetings', default_view: 'all' },
  };
  const artifact = await prepareModuleArtifact({ path: modulePath, manifest: moduleManifest });
  const manifest: DeftAppManifestV0Input = {
    schema_version: '0',
    id: 'community.example.hello-workspace-app',
    version: '1.0.0',
    name: 'Hello Workspace',
    description: 'My first declarative Deft App.',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '0' },
    modules: [{
      module_id: moduleManifest.id,
      version: moduleManifest.version,
      manifest_path: modulePath,
      manifest_digest: artifact.digest,
    }],
    navigation: [{
      key: 'greetings', label: 'Greetings', module_id: moduleManifest.id,
      collection_key: 'greetings', view_key: 'all',
    }],
  };
  await writeJson(resolve(cwd, modulePath), moduleManifest);
  await writeJson(manifestPath, manifest);
  await writeFile(resolve(cwd, 'APP_BRIEF.md'), '# App brief\n\nDescribe the workspace outcome this App should provide.\n', 'utf8');
  await writeFile(resolve(cwd, 'AGENTS.md'), [
    '# Declarative Deft App',
    '',
    '- Build this App through `deft.app.json` and included `deft.module.json` files.',
    '- Do not edit Deft core, add executable code, embed secrets, declare network egress, or self-grant permissions.',
    '- App Protocol v0 has no capabilities, connectors, runtime, sync, automation, public routes, or custom UI.',
    '- Keep App license and provenance metadata explicit; generated files are declarative data.',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(cwd, '.gitignore'), '.deft/\n', 'utf8');
  console.log(`Initialized ${manifest.name} in ${cwd}`);
}

async function buildProject(writeOutput: boolean) {
  const source = JSON.parse(await readFile(resolve(cwd, 'deft.app.json'), 'utf8')) as DeftAppManifestV0Input;
  const artifacts = [];
  const modules = [];
  for (const reference of source.modules ?? []) {
    const raw = JSON.parse(await readFile(await assertRegularUnslinkedFile(reference.manifest_path), 'utf8')) as unknown;
    const artifact = await prepareModuleArtifact({ path: reference.manifest_path, manifest: raw });
    artifacts.push(artifact);
    modules.push({ ...reference, manifest_digest: artifact.digest });
  }
  const manifest = parseDeftAppManifest({ ...source, modules });
  const built = await buildDeftAppPackage({ manifest, artifacts });
  if (writeOutput) {
    await mkdir(resolve(cwd, '.deft'), { recursive: true });
    await writeFile(resolve(cwd, '.deft', 'app.deftapp.json'), `${built.json}\n`, 'utf8');
    await writeJson(resolve(cwd, 'deft.app.lock.json'), {
      schema: 'deft.app.lock.v0',
      app_id: manifest.id,
      version: manifest.version,
      package_digest: built.digest,
      manifest_digest: built.package.manifest_digest,
      artifacts: built.package.artifacts.map(({ path, digest, byte_length, media_type }) => ({ path, digest, byte_length, media_type })),
      permissions: [],
    });
  }
  return built;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function hostUrl(): Promise<string> {
  return (option('--url') ?? process.env.DEFT_URL ?? 'http://localhost:3001').replace(/\/$/, '');
}

async function doctor(): Promise<void> {
  const url = await hostUrl();
  const response = await fetch(`${url}/api/app-developer/status`);
  if (!response.ok) throw new Error(`Deft App developer pairing is unavailable at ${url} (${response.status})`);
  const status = await response.json() as { app_protocol?: string; audience?: string };
  if (status.app_protocol !== '0' || status.audience !== 'app-developer') throw new Error('Host is not compatible with App Protocol v0');
  console.log(`Compatible App Protocol v0 host: ${url}`);
}

async function readPairingCode(): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const reader = createInterface({ input: stdin, output: stdout });
  try { return (await reader.question('One-time pairing code: ')).trim(); }
  finally { reader.close(); }
}

async function installLocal(): Promise<void> {
  const url = await hostUrl();
  const built = await buildProject(true);
  const code = await readPairingCode();
  if (!code) throw new Error('A one-time pairing code is required on stdin');
  const exchange = await fetch(`${url}/api/app-developer/pair/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  if (!exchange.ok) throw new Error(`Pairing failed (${exchange.status}): ${await exchange.text()}`);
  const { token } = await exchange.json() as { token: string };
  const installed = await fetch(`${url}/api/app-developer/install`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/vnd.deft.app.package+json' },
    body: built.json,
  });
  if (!installed.ok) throw new Error(`Install failed (${installed.status}): ${await installed.text()}`);
  const result = await installed.json() as { app: { name: string; state: string } };
  console.log(`Installed ${result.app.name} (${result.app.state})`);
}

async function main(): Promise<void> {
  const [domain, command] = process.argv.slice(2);
  if (domain !== 'app') throw new Error('Usage: deft app <init|check|build|doctor|install-local>');
  if (command === 'init') return initialize();
  if (command === 'check') {
    const built = await buildProject(false);
    console.log(`Valid App Protocol v0 package ${built.digest}; connected permissions: none`);
    return;
  }
  if (command === 'build') {
    const built = await buildProject(true);
    console.log(`Built .deft/app.deftapp.json ${built.digest}`);
    return;
  }
  if (command === 'doctor') return doctor();
  if (command === 'install-local') return installLocal();
  throw new Error('Usage: deft app <init|check|build|doctor|install-local>');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
