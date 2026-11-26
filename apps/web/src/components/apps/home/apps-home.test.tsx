import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppsHomeLists, BuildYourOwnPanel, type AppsHomeHandlers } from './apps-home';
import { ModuleUploadReview } from './module-upload-review';
import { buildAppsHome } from '@/lib/app-upload-routing';
import { previewModuleManifestJson, type BundledModule, type ModuleInstallation } from '@/lib/modules';
import type { AppInstallation } from '@/lib/apps';

const noop = () => {};
const handlers: AppsHomeHandlers = { onUpload: noop, onInstallBundled: noop, onToggleModule: noop, onAgentAccess: noop, onUploadVersion: noop, onBundledUpdate: noop };

const manifest = { schemaVersion: '1', moduleId: 'workspace.hiring', slug: 'hiring', name: 'Hiring pipeline', description: 'Roles and candidates.', version: '1.0.0', icon: null, collections: [], navigation: null, raw: {} };
const hiring: ModuleInstallation = { id: 'i1', slug: 'hiring', moduleId: 'workspace.hiring', source: 'sideloaded', enabled: true, agentAccess: 'none', activeVersionId: 'v1', manifestDigest: 'sha256:a', owningAppInstallationId: null, manifest };
const contacts: BundledModule = { slug: 'contacts', moduleId: 'com.deft.contacts', name: 'Contacts', description: 'People and companies.', version: '1.0.0', icon: 'users', installed: false, installedVersion: null, updateAvailable: false };
const pkg = { id: 'app-1', app_id: 'io.example.notes', name: 'Field notes', version: '0.1.0', state: 'staged', manifest: { description: null, modules: [{}], compatibility: { app_protocol: '0' } } } as unknown as AppInstallation;

test('Pair Codex is hidden unless pairing is available, and members get no upload', () => {
  const hidden = renderToStaticMarkup(<BuildYourOwnPanel canManage busy={false} pairingAvailable={false} onUpload={noop} onPair={noop} />);
  assert.match(hidden, /Upload an app/);
  assert.doesNotMatch(hidden, /Pair Codex/);
  const shown = renderToStaticMarkup(<BuildYourOwnPanel canManage busy={false} pairingAvailable onUpload={noop} onPair={noop} />);
  assert.match(shown, /Pair Codex/);
  const member = renderToStaticMarkup(<BuildYourOwnPanel canManage={false} busy={false} pairingAvailable onUpload={noop} onPair={noop} />);
  assert.doesNotMatch(member, /Upload an app|Pair Codex/);
  assert.match(member, /Owners and admins add apps/);
});

test('one list holds both formats, bundled apps install in one click, and the page says apps are turned off, not deleted', () => {
  const html = renderToStaticMarkup(<AppsHomeLists home={buildAppsHome({ modules: [hiring], bundled: [contacts], apps: [pkg] })} query="" canManage busyKey={null} handlers={handlers} />);
  const installed = html.slice(html.indexOf('aria-label="Installed apps"'), html.indexOf('Comes with Deft'));
  assert.match(installed, /Field notes.*Needs review.*Review and turn on/);
  assert.match(installed, /Hiring pipeline.*On.*Built in this workspace/);
  assert.match(installed, /aria-label="What Defty and agents can do in Hiring pipeline"/);
  assert.match(installed, /Upload new version/);
  assert.match(html, /aria-label="Install Contacts"/);
  assert.match(html, /can be turned off, but not deleted/);
});

test('members see the list without controls; an empty workspace gets a clear empty state', () => {
  const member = renderToStaticMarkup(<AppsHomeLists home={buildAppsHome({ modules: [hiring], bundled: [contacts], apps: [] })} query="" canManage={false} busyKey={null} handlers={handlers} />);
  assert.doesNotMatch(member, /Turn off|Upload new version|Defty and agents/);
  assert.match(member, /Owners and admins install apps/);
  const empty = renderToStaticMarkup(<AppsHomeLists home={buildAppsHome({ modules: [], bundled: [], apps: [] })} query="" canManage busyKey={null} handlers={handlers} />);
  assert.match(empty, /No apps installed yet/);
  const noMatch = renderToStaticMarkup(<AppsHomeLists home={buildAppsHome({ modules: [hiring], bundled: [], apps: [], query: 'zzz' })} query="zzz" canManage busyKey={null} handlers={handlers} />);
  assert.match(noMatch, /No app matches/);
});

test('the install confirm names the record types and what installing means', async () => {
  const preview = await previewModuleManifestJson(JSON.stringify({ schema_version: '1', id: 'workspace.hiring', slug: 'hiring', version: '1.1.0', name: 'Hiring pipeline', collections: [{ key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text' }] }] }));
  const install = renderToStaticMarkup(<ModuleUploadReview preview={preview} decision={{ mode: 'install', target: null }} busy={false} onCancel={noop} onConfirm={noop} />);
  assert.match(install, /Candidates.*1 field · 0 views/);
  assert.match(install, /Guests can’t.*turn an app off later, but not delete it/);
  assert.match(install, /Install Hiring pipeline/);
  const upgrade = renderToStaticMarkup(<ModuleUploadReview preview={preview} decision={{ mode: 'upgrade', target: hiring }} busy={false} onCancel={noop} onConfirm={noop} />);
  assert.match(upgrade, /v1\.0\.0 → v1\.1\.0/);
  assert.match(upgrade, /Every record is kept/);
  assert.match(upgrade, /Update to v1\.1\.0/);
});

test('Settings → Modules redirects to the Apps page', () => {
  const source = readFileSync(new URL('../../../app/(app)/settings/modules/page.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const redirected: string[] = [];
  const loaded = { exports: {} as { default?: () => void } };
  vm.runInNewContext(code, { module: loaded, exports: loaded.exports, require: (name: string) => {
    assert.equal(name, 'next/navigation');
    return { redirect: (href: string) => { redirected.push(href); } };
  } });
  loaded.exports.default!();
  assert.deepEqual(redirected, ['/settings/apps']);
});

test('App Kit parts keep their agent access picker; a part shown alone cannot be turned off or re-uploaded', () => {
  const part: ModuleInstallation = { ...hiring, id: 'p1', slug: 'inbox', moduleId: 'io.example.inbox', owningAppInstallationId: 'app-1', manifest: { ...manifest, name: 'Inbox' } };
  const withPackage = renderToStaticMarkup(<AppsHomeLists home={buildAppsHome({ modules: [part], bundled: [], apps: [{ ...pkg, id: 'app-1' } as AppInstallation] })} query="" canManage busyKey={null} handlers={handlers} />);
  assert.match(withPackage, /aria-label="What Defty and agents can do in Inbox"/);
  const alone = renderToStaticMarkup(<AppsHomeLists home={buildAppsHome({ modules: [part], bundled: [], apps: [] })} query="" canManage busyKey={null} handlers={handlers} />);
  assert.match(alone, /Part of an App Kit package/);
  assert.match(alone, /aria-label="What Defty and agents can do in Inbox"/);
  assert.doesNotMatch(alone, /Turn off|Upload new version/);
});

test('while any action runs, every tile control waits', () => {
  const html = renderToStaticMarkup(<AppsHomeLists home={buildAppsHome({ modules: [hiring], bundled: [contacts], apps: [] })} query="" canManage busyKey="something-else" handlers={handlers} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Turn off Hiring pipeline"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Install Contacts"/);
  assert.match(html, /<select[^>]*disabled=""/);
});

test('an open review cannot be confirmed while another action runs', async () => {
  const preview = await previewModuleManifestJson(JSON.stringify({ schema_version: '1', id: 'workspace.hiring', slug: 'hiring', version: '1.0.0', name: 'Hiring pipeline', collections: [{ key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text' }] }] }));
  const html = renderToStaticMarkup(<ModuleUploadReview preview={preview} decision={{ mode: 'install', target: null }} busy={false} locked onCancel={noop} onConfirm={noop} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*>.*Install Hiring pipeline/);
});

test('the Defty question cannot change while the install runs', async () => {
  const preview = await previewModuleManifestJson(JSON.stringify({ schema_version: '1', id: 'workspace.hiring', slug: 'hiring', version: '1.0.0', name: 'Hiring pipeline', collections: [{ key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text' }] }] }));
  const summary = <label><input type="radio" name="agent-read" /> Yes</label>;
  const busy = renderToStaticMarkup(<ModuleUploadReview preview={preview} decision={{ mode: 'install', target: null }} busy onCancel={noop} onConfirm={noop} summary={summary} />);
  assert.match(busy, /<fieldset disabled=""[^>]*>.*Yes<\/label><\/fieldset>/);
  const idle = renderToStaticMarkup(<ModuleUploadReview preview={preview} decision={{ mode: 'install', target: null }} busy={false} onCancel={noop} onConfirm={noop} summary={summary} />);
  assert.doesNotMatch(idle, /<fieldset disabled=""/);
});
