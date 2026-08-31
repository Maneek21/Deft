import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = resolve(import.meta.dirname, '..', 'dist', 'cli.js');

function run(project: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'app', ...args], { cwd: project, encoding: 'utf8' });
}

test('external authoring loop initializes and builds deterministically without credentials', async () => {
  const project = await mkdtemp(resolve(tmpdir(), 'deft-app-kit-'));
  const initialized = run(project, 'init');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal((await readFile(resolve(project, 'AGENTS.md'), 'utf8')).includes('Do not edit Deft core'), true);

  const checked = run(project, 'check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /connected permissions: none/);
  assert.match(checked.stdout, /sha256:b0525cf946a4069079630a472b78b2d4ea425fd1b02a567eac47face4e202790/);

  const first = run(project, 'build');
  assert.equal(first.status, 0, first.stderr);
  const firstPackage = await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8');
  const firstLock = await readFile(resolve(project, 'deft.app.lock.json'), 'utf8');
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
  assert.match(checked.stdout, /Protocol v1 authoring package/);
  assert.match(checked.stdout, /host activation unavailable/);

  const first = run(project, 'build');
  assert.equal(first.status, 0, first.stderr);
  const firstPackage = await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8');
  const firstLock = await readFile(resolve(project, 'deft.app.lock.json'), 'utf8');
  assert.equal((JSON.parse(firstLock) as { schema: string }).schema, 'deft.app.lock.v1');
  const second = run(project, 'build');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8'), firstPackage);
  assert.equal(await readFile(resolve(project, 'deft.app.lock.json'), 'utf8'), firstLock);
});
