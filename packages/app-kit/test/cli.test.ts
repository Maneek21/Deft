import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = resolve(import.meta.dirname, '..', 'dist', 'cli.js');

function run(project: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'app', ...args], { cwd: project, encoding: 'utf8' });
}

async function runAsync(project: string, input: string, ...args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, 'app', ...args], { cwd: project, stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (status) => resolveRun({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(input);
  });
}

test('external authoring loop initializes and builds deterministically without credentials', async () => {
  const project = await mkdtemp(resolve(tmpdir(), 'deft-app-kit-'));
  const initialized = run(project, 'init');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal((await readFile(resolve(project, 'AGENTS.md'), 'utf8')).includes('Do not edit Deft core'), true);

  const explicitProject = await mkdtemp(resolve(tmpdir(), 'deft-app-kit-explicit-'));
  const explicit = run(explicitProject, 'init', '--template', 'declarative');
  assert.equal(explicit.status, 0, explicit.stderr);
  for (const filename of [
    'deft.app.json',
    'modules/hello-workspace/deft.module.json',
    'APP_BRIEF.md',
    'AGENTS.md',
    '.gitignore',
  ]) {
    assert.equal(
      await readFile(resolve(explicitProject, filename), 'utf8'),
      await readFile(resolve(project, filename), 'utf8'),
      `${filename} must remain byte-identical for the compatibility default`,
    );
  }
  const invalidTemplate = run(await mkdtemp(resolve(tmpdir(), 'deft-app-kit-invalid-')), 'init', '--template', 'runtime');
  assert.notEqual(invalidTemplate.status, 0);
  assert.equal(invalidTemplate.stderr.trim(), 'Usage: deft app init [--template declarative|connected]');

  const checked = run(project, 'check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /connected permissions: none/);
  assert.match(checked.stdout, /sha256:b0525cf946a4069079630a472b78b2d4ea425fd1b02a567eac47face4e202790/);

  const first = run(project, 'build');
  assert.equal(first.status, 0, first.stderr);
  const firstPackage = await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8');
  const firstLock = await readFile(resolve(project, 'deft.app.lock.json'), 'utf8');
  const requestedAuthority = JSON.parse(
    await readFile(resolve(project, '.deft', 'requested-authority.json'), 'utf8'),
  ) as any;
  assert.equal(requestedAuthority.schema, 'deft.app.requested_authority.v1');
  assert.deepEqual(requestedAuthority.requested_authority.requirements, {
    actions: [], capabilities: [], connectors: [], dependencies: [], resources: [],
  });
  assert.deepEqual(requestedAuthority.requested_authority.resource_rights, []);
  assert.deepEqual(requestedAuthority.requested_authority.classification.actions, []);
  assert.equal(requestedAuthority.requested_authority.classification.executable, false);
  assert.equal(requestedAuthority.requested_authority.classification.provider_access, false);
  const second = run(project, 'build');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8'), firstPackage);
  assert.equal(await readFile(resolve(project, 'deft.app.lock.json'), 'utf8'), firstLock);

  for (const filename of await readdir(project, { recursive: true })) {
    const path = resolve(project, filename);
    if (filename.includes('.deft') && !filename.endsWith('.json')) continue;
    try {
      const contents = await readFile(path, 'utf8');
      assert.equal(contents.includes('deft_app_dev_'), false, filename);
    } catch {
      // Directories are intentionally ignored.
    }
  }
});

test('connected template emits a Module v2 dependency App and requested authority without a grant', async () => {
  const project = await mkdtemp(resolve(tmpdir(), 'deft-connected-template-'));
  const initialized = run(project, 'init', '--template', 'connected');
  assert.equal(initialized.status, 0, initialized.stderr);

  const moduleManifest = JSON.parse(
    await readFile(resolve(project, 'modules', 'connected-campaigns', 'deft.module.json'), 'utf8'),
  ) as any;
  const manifest = JSON.parse(await readFile(resolve(project, 'deft.app.json'), 'utf8')) as any;
  assert.equal(moduleManifest.schema_version, '2');
  assert.deepEqual(moduleManifest.collections[0].fields.find((field: any) => field.key === 'contacts').target, {
    module_id: 'org.deft.reference.resource-contacts',
    resource_type: 'contacts',
  });
  assert.deepEqual(manifest.dependencies, [{
    key: 'contacts_app',
    app_id: 'org.deft.reference.resource-contacts-app',
    version: '1.0.0',
  }]);
  assert.equal(manifest.actions[0].input_bindings[0].source.kind, 'selected_relation_field');
  assert.match(await readFile(resolve(project, 'AGENTS.md'), 'utf8'), /staging at zero authority/i);

  const checked = run(project, 'check');
  assert.equal(checked.status, 0, checked.stderr);
  const first = run(project, 'build');
  assert.equal(first.status, 0, first.stderr);
  const firstPackage = await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8');
  const firstLock = await readFile(resolve(project, 'deft.app.lock.json'), 'utf8');
  const firstReport = await readFile(resolve(project, '.deft', 'requested-authority.json'), 'utf8');
  assert.deepEqual((JSON.parse(firstLock) as any).permissions, []);
  const report = JSON.parse(firstReport) as any;
  assert.equal(report.app.protocol_version, '1');
  assert.equal(report.requested_authority.classification.authority_state, 'requested_only');
  assert.equal(report.requested_authority.classification.executable, false);
  assert.equal(report.requested_authority.classification.provider_access, false);
  assert.equal(report.requested_authority.classification.review_required, true);
  assert.equal(report.requested_authority.resource_rights.every((right: any) => right.right === 'read'), true);
  assert.equal(JSON.stringify(report).includes('organization_id'), false);
  assert.equal(JSON.stringify(report).includes('connector_id'), false);
  assert.equal(JSON.stringify(report).includes('token'), false);

  const second = run(project, 'build');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8'), firstPackage);
  assert.equal(await readFile(resolve(project, 'deft.app.lock.json'), 'utf8'), firstLock);
  assert.equal(await readFile(resolve(project, '.deft', 'requested-authority.json'), 'utf8'), firstReport);

  const requests: Array<{ url: string; authorization?: string; body: string }> = [];
  const host = createServer((request, response) => {
    if (request.url === '/api/app-developer/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        app_protocol: '0',
        audience: 'app-developer',
        single_use_install: true,
        compatibility: {
          schema: 'deft.app_developer.compatibility.v1',
          app_kit: { package: '@deft/app-kit', versions: ['0.1.0-alpha.1'] },
          protocol_flows: {
            '0': { package_format: 'deft.app.package.v0', install_mode: 'stage_and_activate' },
            '1': { package_format: 'deft.app.package.v1', install_mode: 'stage_only' },
          },
        },
      }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requests.push({
        url: request.url ?? '',
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (request.url === '/api/app-developer/pair/exchange') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ token: 'deft_app_dev_test' }));
      } else {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ app: { name: 'Connected Campaigns', state: 'staged' } }));
      }
    });
  });
  await new Promise<void>((resolveListen) => host.listen(0, '127.0.0.1', resolveListen));
  const address = host.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  try {
    const hostUrl = `http://127.0.0.1:${address.port}`;
    const diagnosed = await runAsync(project, '', 'doctor', '--url', hostUrl);
    assert.equal(diagnosed.status, 0, diagnosed.stderr);
    assert.equal(
      diagnosed.stdout.trim(),
      `Compatible App Kit package @deft/app-kit version 0.1.0-alpha.1; App Protocol v1; `
      + `package format deft.app.package.v1; install mode stage_only; host ${hostUrl}`,
    );
    assert.doesNotMatch(diagnosed.stdout, /registry|signature|signed|trusted|verified/i);

    const installed = await runAsync(
      project,
      'one-time-code\n',
      'install-local',
      '--url',
      hostUrl,
    );
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout.trim(), 'Staged Connected Campaigns (staged) for workspace review.');
    assert.deepEqual(requests.map((request) => request.url), [
      '/api/app-developer/pair/exchange',
      '/api/app-developer/install',
    ]);
    assert.deepEqual(JSON.parse(requests[0]!.body), { code: 'one-time-code' });
    assert.equal(requests[1]!.authorization, 'Bearer deft_app_dev_test');
    assert.equal((JSON.parse(requests[1]!.body) as any).package_format, 'deft.app.package.v1');
  } finally {
    await new Promise<void>((resolveClose, reject) => host.close((error) => error ? reject(error) : resolveClose()));
  }
});

test('external authoring loop checks and builds Protocol v1 deterministically without authority', async () => {
  const project = await mkdtemp(resolve(tmpdir(), 'deft-connected-app-kit-'));
  const moduleDirectory = resolve(project, 'modules', 'campaigns');
  await mkdir(moduleDirectory, { recursive: true });
  const moduleManifest = {
    schema_version: '1',
    id: 'community.deft.campaigns',
    slug: 'campaigns',
    version: '1.0.0',
    name: 'Campaigns',
    collections: [{
      key: 'campaigns',
      name: 'Campaigns',
      fields: [
        { key: 'subject', label: 'Subject', type: 'text', required: true },
        { key: 'body', label: 'Body', type: 'long_text', required: true },
      ],
      views: [{ key: 'detail', name: 'Campaign', type: 'detail', fields: ['subject', 'body'] }],
    }],
  };
  await writeFile(
    resolve(moduleDirectory, 'deft.module.json'),
    `${JSON.stringify(moduleManifest, null, 2)}\n`,
    'utf8',
  );
  const manifest = {
    schema_version: '1',
    id: 'community.deft.campaigns-app',
    version: '1.0.0',
    name: 'Campaigns',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '1' },
    modules: [{
      module_id: moduleManifest.id,
      version: moduleManifest.version,
      manifest_path: 'modules/campaigns/deft.module.json',
      manifest_digest: `sha256:${'0'.repeat(64)}`,
    }],
    navigation: [{
      key: 'campaigns',
      label: 'Campaigns',
      module_id: moduleManifest.id,
      collection_key: 'campaigns',
      view_key: 'detail',
    }],
    dependencies: [{ key: 'contacts_app', app_id: 'community.deft.contacts-app', version: '1.0.0' }],
    resource_requirements: [
      {
        key: 'campaign',
        source: { kind: 'included_module', module_id: moduleManifest.id, version: moduleManifest.version },
        resource_type: 'campaigns',
        fields: ['subject', 'body'],
      },
      {
        key: 'contact',
        source: {
          kind: 'dependency_module',
          dependency_key: 'contacts_app',
          module_id: 'community.deft.contacts',
          version: '1.0.0',
        },
        resource_type: 'contacts',
        fields: ['email'],
      },
    ],
    capability_requirements: [{
      key: 'send_email',
      interface: { kind: 'private', namespace: 'app_lineage', key: 'sandbox_email_send', version: '1' },
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
          source: { kind: 'user_input', input_type: 'email', label: 'Recipient', required: true },
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
  await writeFile(resolve(project, 'deft.app.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const checked = run(project, 'check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /Protocol v1 connected package/);
  assert.match(checked.stdout, /staging grants zero authority/);
  assert.match(checked.stdout, /review and activation are explicit/);
  assert.match(checked.stdout, /execution is rollout-gated/);

  const first = run(project, 'build');
  assert.equal(first.status, 0, first.stderr);
  const firstPackage = await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8');
  const firstLock = await readFile(resolve(project, 'deft.app.lock.json'), 'utf8');
  assert.equal((JSON.parse(firstLock) as { schema: string }).schema, 'deft.app.lock.v1');
  const second = run(project, 'build');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8'), firstPackage);
  assert.equal(await readFile(resolve(project, 'deft.app.lock.json'), 'utf8'), firstLock);

  let nonStatusRequests = 0;
  const host = createServer((request, response) => {
    if (request.url === '/api/app-developer/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        app_protocol: '0',
        audience: 'app-developer',
        single_use_install: true,
      }));
      return;
    }
    nonStatusRequests += 1;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolveListen) => host.listen(0, '127.0.0.1', resolveListen));
  const address = host.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server');
  try {
    const installLocal = await runAsync(
      project,
      'pairing-code-must-not-be-read\n',
      'install-local',
      '--url',
      `http://127.0.0.1:${address.port}`,
    );
    assert.notEqual(installLocal.status, 0);
    assert.equal(installLocal.stderr.trim(), 'Host supports only App Protocol v0 developer installs');
    assert.equal(nonStatusRequests, 0, 'Compatibility refusal must happen before pairing exchange');
    assert.doesNotMatch(installLocal.stderr, /Pairing failed|fetch failed|one-time pairing code/i);
  } finally {
    await new Promise<void>((resolveClose, reject) => host.close((error) => error ? reject(error) : resolveClose()));
  }
});
