import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { DEFT_EXPERIENCE_BRIDGE_VERSION, DEFT_EXPERIENCE_RENDERER_VERSION } from '../dist/index.js';

const cli = resolve(import.meta.dirname, '..', 'dist', 'cli.js');
const descriptor = { schema_version: 'deft.app_sync_descriptor.v1', key: 'mail', runtime_requirement_key: 'mail_sync',
  resource_type: 'email_message', requested_visibility: 'user_private', label_field: 'subject',
  record_schema: { type: 'object', properties: { subject: { type: 'string', maxLength: 200 } },
    required: ['subject'], additionalProperties: false } };
const source = { schema_version: '5', id: 'community.example.email-lite', version: '1.0.0', name: 'Email Lite',
  license: 'AGPL-3.0-only', compatibility: { app_protocol: '5' }, modules: [], navigation: [],
  runtime_requirements: [{ key: 'mail_sync', protocol_version: 'deft.app_runtime_channel.v2' }],
  private_capabilities: [], runtime_actions: [], sync_descriptors: [descriptor], public_actions: [],
  experiences: [{ key: 'inbox', label: 'Inbox', artifact_path: 'experiences/inbox.json',
    artifact_digest: `sha256:${'0'.repeat(64)}`, bridge_version: DEFT_EXPERIENCE_BRIDGE_VERSION,
    renderer_version: DEFT_EXPERIENCE_RENDERER_VERSION }] };
const bundle = { schema_version: 'deft.experience_bundle.v1', entry_view: 'inbox',
  worker_source: 'self.onmessage=()=>postMessage({kind:"view"});', resource_keys: ['mail'], action_keys: [] };

function run(cwd: string, command: string) {
  return spawnSync(process.execPath, [cli, 'app', command], { cwd, encoding: 'utf8' });
}

test('v5 CLI packs external sync-only source deterministically and rejects unknown executable fields', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'deft-v5-source-'));
  try {
    await mkdir(resolve(dir, 'experiences'));
    await writeFile(resolve(dir, 'deft.app.json'), JSON.stringify(source));
    await writeFile(resolve(dir, 'experiences/inbox.json'), JSON.stringify(bundle));
    const check = run(dir, 'check');
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /v5 resource Runtime authoring package/);
    const first = run(dir, 'build');
    assert.equal(first.status, 0, first.stderr);
    const packed = await readFile(resolve(dir, '.deft/app.deftapp.json'), 'utf8');
    const lock = await readFile(resolve(dir, 'deft.app.lock.json'), 'utf8');
    const second = run(dir, 'build');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(resolve(dir, '.deft/app.deftapp.json'), 'utf8'), packed);
    assert.equal(await readFile(resolve(dir, 'deft.app.lock.json'), 'utf8'), lock);
    assert.deepEqual((JSON.parse(packed) as {manifest:{runtime_actions:unknown[],sync_descriptors:unknown[]}}).manifest.runtime_actions, []);
    await writeFile(resolve(dir, 'experiences/inbox.json'), JSON.stringify({ ...bundle, install_script: 'node bad.js' }));
    const invalid = run(dir, 'build');
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Unrecognized key|unrecognized_keys|install_script/i);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir(), 'deft-v5-source-')));
    await rm(dir, { recursive: true, force: true });
  }
});
