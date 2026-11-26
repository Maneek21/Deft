import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_UPLOAD_MAX_BYTES,
  buildAppsHome,
  checkAppUploadFile,
  classifyAppUpload,
  developerPairingAvailable,
  moduleUploadRequest,
  planModuleUpload,
  readableManifestError,
  uniqueAppName,
} from './app-upload-routing';
import { MODULE_MANIFEST_MAX_BYTES, previewModuleManifestJson, type BundledModule, type ModuleInstallation } from './modules';
import type { AppInstallation } from './apps';

const hiring = {
  schema_version: '1',
  id: 'workspace.hiring',
  slug: 'hiring',
  version: '1.0.0',
  name: 'Hiring pipeline',
  collections: [{ key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] }],
};
const hiringSource = JSON.stringify(hiring, null, 2);

function installed(overrides: Partial<ModuleInstallation> = {}): ModuleInstallation {
  return {
    id: 'inst-hiring', slug: 'hiring', moduleId: 'workspace.hiring', source: 'sideloaded', enabled: true, agentAccess: 'none',
    activeVersionId: 'v1', manifestDigest: 'sha256:active', owningAppInstallationId: null,
    manifest: { schemaVersion: '1', moduleId: 'workspace.hiring', slug: 'hiring', name: 'Hiring pipeline', description: null, version: '1.0.0', icon: null, collections: [], navigation: null, raw: {} },
    ...overrides,
  };
}

const contacts: BundledModule = { slug: 'contacts', moduleId: 'com.deft.contacts', name: 'Contacts', description: 'People and companies.', version: '1.0.0', icon: 'users', installed: false, installedVersion: null, updateAvailable: false };

function appPackage(overrides: Partial<AppInstallation> = {}): AppInstallation {
  return {
    id: 'app-1', version_id: 'ver-1', app_id: 'io.example.notes', name: 'Field notes', version: '0.1.0', state: 'staged', lifecycle_epoch: 1, grant_epoch: 1,
    active_version_id: null, package_digest: 'sha256:p', manifest_digest: 'sha256:m', created_at: '', updated_at: '',
    manifest: { description: 'Notes from the field.', modules: [{}], compatibility: { app_protocol: '0' } } as unknown as AppInstallation['manifest'],
    ...overrides,
  };
}

test('a module manifest goes to sideload, whatever the file is called', () => {
  const upload = classifyAppUpload(hiringSource, { appPackagesEnabled: true });
  assert.equal(upload.kind, 'module');
  assert.doesNotThrow(() => checkAppUploadFile({ name: 'my-hiring-app.json', size: hiringSource.length }));
  assert.deepEqual(moduleUploadRequest({ mode: 'install', target: null }), { path: '/api/modules/sideload', headers: { 'Content-Type': 'application/json' } });
});

test('an App Kit package goes to inspect, and only when packages are on', () => {
  const source = JSON.stringify({ package_format: 'deft.app.package.v0', manifest: {}, modules: [] });
  assert.equal(classifyAppUpload(source, { appPackagesEnabled: true }).kind, 'app_package');
  assert.throws(() => classifyAppUpload(source, { appPackagesEnabled: false }), /not available on this workspace/);
});

test('wrong file kinds get readable refusals, never raw JSON', () => {
  const cases: Array<[string, RegExp]> = [
    ['{"name": "x",}', /isn't valid JSON \(line 1, column \d+\)/],
    ['[1, 2, 3]', /one JSON object/],
    ['"hello"', /one JSON object/],
    ['{"hello": "world"}', /can't tell what this file is/],
    [JSON.stringify({ schema_version: '1', id: 'io.example.app', compatibility: { app_protocol: '0' }, modules: [] }), /App Kit source file \(deft\.app\.json\)/],
  ];
  for (const [source, expected] of cases) {
    assert.throws(() => classifyAppUpload(source, { appPackagesEnabled: true }), (error: Error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /\[\{|"code"/);
      return true;
    });
  }
  const multiLine = '{\n  "slug": "hiring",\n  "name": "x"\n  "version": "1.0.0"\n}';
  assert.throws(() => classifyAppUpload(multiLine, { appPackagesEnabled: true }), /line 4/);
});

test('file checks refuse other extensions, empty files and huge files before reading', () => {
  assert.throws(() => checkAppUploadFile({ name: 'hiring.yaml', size: 10 }), /Choose a \.json file/);
  assert.throws(() => checkAppUploadFile({ name: 'hiring.json', size: 0 }), /empty/);
  assert.throws(() => checkAppUploadFile({ name: 'huge.json', size: APP_UPLOAD_MAX_BYTES + 1 }), /1 MB or smaller/);
  const big = JSON.stringify({ ...hiring, description: 'x'.repeat(MODULE_MANIFEST_MAX_BYTES) });
  assert.throws(() => classifyAppUpload(big, { appPackagesEnabled: true }), /128 KB or smaller/);
});

test('the same button upgrades an app that is already installed, with If-Match', async () => {
  const preview = await previewModuleManifestJson(JSON.stringify({ ...hiring, version: '1.1.0' }));
  const decision = planModuleUpload(preview, [installed()]);
  assert.equal(decision.mode, 'upgrade');
  assert.deepEqual(moduleUploadRequest(decision), {
    path: '/api/modules/hiring/upgrade',
    headers: { 'Content-Type': 'application/json', 'If-Match': 'sha256:active' },
  });
  assert.equal(planModuleUpload(preview, [installed()], 'inst-hiring').mode, 'upgrade');
});

test('uploads that cannot be applied say why in plain words', async () => {
  const preview = await previewModuleManifestJson(hiringSource);
  assert.throws(() => planModuleUpload(preview, [installed({ owningAppInstallationId: 'app-1' })]), /part of an App Kit package/);
  assert.throws(() => planModuleUpload(preview, [installed({ source: 'bundled' })]), /comes with Deft.*new "id" and "slug"/);
  assert.throws(() => planModuleUpload(preview, [installed({ moduleId: 'workspace.other' })]), /already uses the slug "hiring"/);
  assert.throws(() => planModuleUpload(preview, [installed({ slug: 'other' })]), /already uses the id "workspace.hiring"/);
  assert.throws(() => planModuleUpload(preview, [installed({ id: 'x', slug: 'other', moduleId: 'workspace.other' })], 'x'), /not .*must stay the same/);
  assert.equal(planModuleUpload(preview, []).mode, 'install');
});

test('both formats appear in one list; bundled apps not yet installed are offered', () => {
  const ownedByApp = installed({ id: 'inner', slug: 'notes', moduleId: 'io.example.notes.main', owningAppInstallationId: 'app-1', manifest: { ...installed().manifest, name: 'Inner notes' } });
  const home = buildAppsHome({ modules: [installed(), ownedByApp], bundled: [contacts], apps: [appPackage()] });
  assert.deepEqual(home.installed.map((item) => `${item.kind}:${item.name}`), ['package:Field notes', 'module:Hiring pipeline']);
  assert.deepEqual(home.available.map((module) => module.slug), ['contacts']);
  assert.equal(home.total, 3);

  const withContacts = buildAppsHome({ modules: [installed({ id: 'c', slug: 'contacts', moduleId: 'com.deft.contacts', source: 'bundled', manifest: { ...installed().manifest, name: 'Contacts' } })], bundled: [contacts], apps: [] });
  assert.equal(withContacts.available.length, 0);
  const first = withContacts.installed[0];
  assert.equal(first?.kind === 'module' ? first.bundled?.slug : null, 'contacts');

  const searched = buildAppsHome({ modules: [installed()], bundled: [contacts], apps: [appPackage()], query: 'FIELD' });
  assert.deepEqual(searched.installed.map((item) => item.name), ['Field notes']);
  assert.equal(searched.available.length, 0);
});

test('Pair Codex shows only when GET /api/apps says pairing is available', () => {
  assert.equal(developerPairingAvailable({ apps: [], developer_pairing: { available: true } }), true);
  assert.equal(developerPairingAvailable({ apps: [], developer_pairing: { available: false } }), false);
  assert.equal(developerPairingAvailable({ apps: [] }), false);
  assert.equal(developerPairingAvailable(undefined), false);
});

test('a manifest the browser check refuses reads as at most three where-and-what lines', async () => {
  const bad = JSON.stringify({ ...hiring, collections: [{ ...hiring.collections[0], views: [{ key: 'board', name: 'Board', type: 'board', group_by: 'name' }] }] });
  const error = await previewModuleManifestJson(bad).then(() => null, (reason: unknown) => reason);
  const text = readableManifestError(error, bad);
  assert.doesNotMatch(text, /\[\{|"code"/);
  assert.match(text, /^(collections → )?Candidates → (views → )?Board → fields: (expected array|is required)$/m);
  assert.ok(text.split('\n').length <= 3);
  const withLines = Object.assign(new Error('x'), { lines: ['one', 'two', 'three', 'four'] });
  assert.equal(readableManifestError(withLines), 'one\ntwo\nthree');
  assert.equal(readableManifestError(new Error('Plain words.')), 'Plain words.');
});

test('review fixes: size wording, BOM, app files win over a stray package_format, App Kit parts stay reachable', () => {
  assert.throws(() => checkAppUploadFile({ name: 'big.json', size: APP_UPLOAD_MAX_BYTES + 1 }), (error: Error) => {
    assert.doesNotMatch(error.message, /This file is 1 MB\./);
    assert.match(error.message, /This file is 1\.1 MB\. App files must be 1 MB or smaller/);
    return true;
  });
  assert.equal(classifyAppUpload(`﻿${hiringSource}`, { appPackagesEnabled: true }).kind, 'module');
  assert.equal(classifyAppUpload(JSON.stringify({ ...hiring, package_format: 'deft.app.package.v1' }), { appPackagesEnabled: false }).kind, 'module');
  assert.doesNotMatch((() => { try { classifyAppUpload(JSON.stringify({ compatibility: {}, modules: [] }), { appPackagesEnabled: true }); return ''; } catch (error) { return (error as Error).message; } })(), /`/);

  const part = installed({ id: 'part', slug: 'inbox', moduleId: 'io.example.inbox', owningAppInstallationId: 'app-1', manifest: { ...installed().manifest, name: 'Inbox' } });
  const withPackage = buildAppsHome({ modules: [part], bundled: [], apps: [appPackage()] });
  assert.deepEqual(withPackage.installed.map((item) => item.kind), ['package']);
  const first = withPackage.installed[0];
  assert.deepEqual(first?.kind === 'package' ? first.parts.map((module) => module.slug) : null, ['inbox']);
  const packagesOff = buildAppsHome({ modules: [part], bundled: [], apps: [] });
  assert.deepEqual(packagesOff.installed.map((item) => `${item.kind}:${item.name}`), ['module:Inbox']);
});

test('module sizes just over the limit round up to whole kilobytes', () => {
  const big = JSON.stringify({ ...hiring, description: 'x'.repeat(MODULE_MANIFEST_MAX_BYTES) });
  assert.throws(() => classifyAppUpload(big, { appPackagesEnabled: true }), /This app file is \d+ KB\. App files must be 128 KB or smaller/);
});

test('a template name already shown by an installed app gets a number', () => {
  const named = (name: string) => installed({ id: name, slug: name.toLowerCase().replace(/\s+/g, '-'), moduleId: `workspace.${name}`, manifest: { ...installed().manifest, name } });
  assert.equal(uniqueAppName('Hiring pipeline', [installed()]), 'Hiring pipeline 2');
  assert.equal(uniqueAppName('  hiring   PIPELINE ', [installed(), named('Hiring pipeline 2')]), 'hiring PIPELINE 3');
  assert.equal(uniqueAppName('Suppliers', [installed()]), 'Suppliers');
});

test('a numbered template name stays within the 80-character limit', () => {
  const long = 'A'.repeat(80);
  const taken = installed({ manifest: { ...installed().manifest, name: long } });
  const result = uniqueAppName(long, [taken]);
  assert.equal(result.length, 80);
  assert.match(result, / 2$/);
});
