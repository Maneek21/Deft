#!/usr/bin/env node
import { mkdir, readFile, writeFile, access, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  buildDeftAppPackage,
  canonicalDeftAppRequestedAuthorityReportJson,
  checkDeftAppDeveloperContract,
  DEFT_APP_PACKAGE_FORMAT,
  DEFT_APP_REQUESTED_AUTHORITY_REPORT_PATH,
  parseDeftAppManifest,
  prepareModuleArtifact,
  type DeftAppManifestInput,
  type DeftAppManifestV0Input,
  type DeftAppManifestV1Input,
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

type AppTemplate = 'declarative' | 'connected';

function parseInitTemplate(): AppTemplate {
  const args = process.argv.slice(4);
  if (args.length === 0) return 'declarative';
  if (
    args.length !== 2
    || args[0] !== '--template'
    || (args[1] !== 'declarative' && args[1] !== 'connected')
  ) {
    throw new Error('Usage: deft app init [--template declarative|connected]');
  }
  return args[1];
}

async function initializeDeclarative(): Promise<void> {
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

async function initializeConnected(): Promise<void> {
  const manifestPath = resolve(cwd, 'deft.app.json');
  if (await exists(manifestPath)) throw new Error('deft.app.json already exists');
  const modulePath = 'modules/connected-campaigns/deft.module.json';
  const moduleManifest = {
    schema_version: '2',
    id: 'community.example.connected-campaigns',
    slug: 'connected-campaigns',
    version: '1.0.0',
    name: 'Connected Campaigns',
    description: 'Campaign resources that reference Contacts owned by a dependency App.',
    collections: [{
      key: 'campaigns',
      name: 'Campaigns',
      singular_name: 'Campaign',
      fields: [
        { key: 'subject', label: 'Subject', type: 'text', required: true },
        { key: 'body', label: 'Body', type: 'long_text', required: true },
        {
          key: 'contacts',
          label: 'Contacts',
          type: 'resource_ref',
          target: { module_id: 'org.deft.reference.resource-contacts', resource_type: 'contacts' },
          multiple: true,
          display: 'label',
        },
      ],
      views: [
        { key: 'all', name: 'All campaigns', type: 'table', fields: ['subject', 'contacts'] },
        { key: 'detail', name: 'Campaign details', type: 'detail', fields: ['subject', 'body', 'contacts'] },
      ],
      search: { title_field: 'subject', subtitle_fields: [], fields: ['subject', 'body'] },
    }],
    navigation: { default_collection: 'campaigns', default_view: 'all' },
  };
  const artifact = await prepareModuleArtifact({ path: modulePath, manifest: moduleManifest });
  const manifest: DeftAppManifestV1Input = {
    schema_version: '1',
    id: 'community.example.connected-campaigns-app',
    version: '1.0.0',
    name: 'Connected Campaigns',
    description: 'A connected Deft App that relates Campaigns to Contacts and requests sandbox email.',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '1' },
    modules: [{
      module_id: moduleManifest.id,
      version: moduleManifest.version,
      manifest_path: modulePath,
      manifest_digest: artifact.digest,
    }],
    navigation: [{
      key: 'campaigns', label: 'Campaigns', module_id: moduleManifest.id,
      collection_key: 'campaigns', view_key: 'all',
    }],
    dependencies: [{
      key: 'contacts_app',
      app_id: 'org.deft.reference.resource-contacts-app',
      version: '1.0.0',
    }],
    resource_requirements: [
      {
        key: 'campaign',
        source: { kind: 'included_module', module_id: moduleManifest.id, version: moduleManifest.version },
        resource_type: 'campaigns',
        fields: ['subject', 'body', 'contacts'],
      },
      {
        key: 'contact',
        source: {
          kind: 'dependency_module',
          dependency_key: 'contacts_app',
          module_id: 'org.deft.reference.resource-contacts',
          version: '1.0.0',
        },
        resource_type: 'contacts',
        fields: ['email'],
      },
    ],
    capability_requirements: [{
      key: 'send_email',
      interface: {
        kind: 'private', namespace: 'app_lineage', key: 'sandbox_email_send', version: '1',
      },
    }],
    connector_requirements: [{ key: 'mail_provider', provider_kind: 'mcp' }],
    actions: [{
      key: 'send_campaign_email',
      label: 'Send campaign email',
      capability_requirement_key: 'send_email',
      connector_requirement_key: 'mail_provider',
      placement: { kind: 'resource_detail', resource_requirement_key: 'campaign' },
      input_bindings: [
        {
          input_key: 'to',
          source: {
            kind: 'selected_relation_field',
            source_resource_requirement_key: 'campaign',
            relation_field_key: 'contacts',
            target_resource_requirement_key: 'contact',
            target_field_key: 'email',
            selection: 'one',
          },
        },
        {
          input_key: 'subject',
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'subject' },
        },
        {
          input_key: 'body_text',
          source: { kind: 'resource_field', resource_requirement_key: 'campaign', field_key: 'body' },
        },
      ],
    }],
  };
  await writeJson(resolve(cwd, modulePath), moduleManifest);
  await writeJson(manifestPath, manifest);
  await writeFile(resolve(cwd, 'APP_BRIEF.md'), [
    '# App brief',
    '',
    'Describe the connected workspace outcome, the resources it relates, and why each requested authority is needed.',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(cwd, 'AGENTS.md'), [
    '# Connected Deft App',
    '',
    '- Build only through the published `@deft/app-kit` manifest, Module, and package contracts.',
    '- Keep staging at zero authority. A workspace owner or admin reviews, binds, and activates requests.',
    '- Never add credentials, provider endpoints, executable code, arbitrary mapping, policy overrides, or Deft core edits.',
    '- Keep Contacts as an exact dependency and reference its records; do not copy them into Campaigns.',
    '- The sandbox email action is single-recipient, human-initiated, and always requires host review.',
    '- App Protocol v1 does not provide automation, custom UI, runtime, sync, or public ingress.',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(cwd, '.gitignore'), '.deft/\n', 'utf8');
  console.log(`Initialized ${manifest.name} in ${cwd}`);
}

async function initialize(template: AppTemplate): Promise<void> {
  if (template === 'connected') return initializeConnected();
  return initializeDeclarative();
}

async function buildProject(writeOutput: boolean) {
  const source = JSON.parse(await readFile(resolve(cwd, 'deft.app.json'), 'utf8')) as DeftAppManifestInput;
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
      schema: `deft.app.lock.v${manifest.schema_version}`,
      app_id: manifest.id,
      version: manifest.version,
      package_digest: built.digest,
      manifest_digest: built.package.manifest_digest,
      artifacts: built.package.artifacts.map(({ path, digest, byte_length, media_type }) => ({ path, digest, byte_length, media_type })),
      permissions: [],
    });
    await writeFile(
      resolve(cwd, DEFT_APP_REQUESTED_AUTHORITY_REPORT_PATH),
      `${canonicalDeftAppRequestedAuthorityReportJson(manifest)}\n`,
      'utf8',
    );
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

type DeveloperStatus = {
  app_protocol?: string;
  audience?: string;
  single_use_install?: boolean;
  compatibility?: unknown;
};

async function readDeveloperStatus(url: string): Promise<DeveloperStatus> {
  const response = await fetch(`${url}/api/app-developer/status`);
  if (!response.ok) throw new Error(`Deft App developer pairing is unavailable at ${url} (${response.status})`);
  const status = await response.json() as DeveloperStatus;
  if (
    status.app_protocol !== '0'
    || status.audience !== 'app-developer'
    || status.single_use_install !== true
  ) {
    throw new Error('Host does not implement the Deft App developer pairing contract');
  }
  return status;
}

async function compatibleFlow(url: string, built: Awaited<ReturnType<typeof buildProject>>) {
  const status = await readDeveloperStatus(url);
  const protocol = built.package.manifest.compatibility.app_protocol;
  const flow = status.compatibility === undefined
    ? (() => {
        if (protocol !== '0') throw new Error('Host supports only App Protocol v0 developer installs');
        return { package_format: DEFT_APP_PACKAGE_FORMAT, install_mode: 'stage_and_activate' as const };
      })()
    : (await checkDeftAppDeveloperContract({
        package_json: built.json,
        host_compatibility: status.compatibility,
      })).install_flow;
  if (flow.package_format !== built.package.package_format) {
    throw new Error(`Host advertises an incompatible package format for App Protocol v${protocol}`);
  }
  return flow;
}

async function doctor(): Promise<void> {
  const built = await buildProject(false);
  const url = await hostUrl();
  const flow = await compatibleFlow(url, built);
  const protocol = built.package.manifest.compatibility.app_protocol;
  console.log(`Compatible App Protocol v${protocol} ${flow.install_mode} host: ${url}`);
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
  const flow = await compatibleFlow(url, built);
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
  console.log(flow.install_mode === 'stage_only'
    ? `Staged ${result.app.name} (${result.app.state}) for workspace review.`
    : `Installed ${result.app.name} (${result.app.state})`);
}

async function main(): Promise<void> {
  const [domain, command] = process.argv.slice(2);
  if (domain !== 'app') throw new Error('Usage: deft app <init|check|build|doctor|install-local>');
  if (command === 'init') return initialize(parseInitTemplate());
  if (command === 'check') {
    const built = await buildProject(false);
    const protocol = built.package.manifest.compatibility.app_protocol;
    console.log(protocol === '0'
      ? `Valid App Protocol v0 package ${built.digest}; connected permissions: none`
      : `Valid App Protocol v1 connected package ${built.digest}; staging grants zero authority; review and activation are explicit; execution is rollout-gated`);
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
