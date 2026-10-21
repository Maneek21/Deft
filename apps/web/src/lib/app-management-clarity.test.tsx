import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppInstallationStatus, ConnectionSyncSummary, SavedResourceUnavailable, UpgradeTrustState } from '../components/apps/app-management-summary';

const source = readFileSync(new URL('../app/(app)/settings/apps/apps-client.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('apps-client.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && ['AppCard', 'Fact'].includes(node.name?.text ?? '')).map(node => node.getText(tree)).join('\n');
const code = ts.transpileModule(functions + '\nglobalThis.AppCard=AppCard;', { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const empty = () => null;
const app = { id: 'app', name: 'Example app', app_id: 'io.example.app', version: '1.2.3', state: 'active', manifest: { schema_version: '7', compatibility: { app_protocol: '7' }, modules: [], license: 'AGPL-3.0-only', experiences: [{ key: 'home', label: 'Home' }], sync_descriptors: [{}], runtime_actions: [{}] } };
function card(canManage: boolean, state = 'active') {
  const context = { globalThis: {} as { AppCard?: React.ElementType }, React, AppInstallationStatus, AppWindow: empty, ShieldCheck: empty, Power: empty, Loader2: empty, FileUp: empty,
    Link: ({ children, ...props }: any) => <a {...props}>{children}</a>, RuntimeAppSetup: () => <p>Action setup</p>, AttachmentAppUpgrade: () => <p>Update review</p>, AttachmentAppReview: () => <p>Access review</p>, ResourceAppReview: empty, ConnectedAppManagement: empty,
    isConnectedAppManifest: () => false, canStageConnectedUpgrade: () => false, canEnableAppWithoutReview: () => false, APP_ATTACHMENT_BROKER_ENABLED: true, APP_RESOURCE_SYNC_ENABLED: true };
  vm.runInNewContext(code, context);
  return renderToStaticMarkup(React.createElement(context.globalThis.AppCard!, { app: { ...app, state }, canManage, busy: false }));
}

test('admin card leads with installation state and keeps technical and management controls collapsed', () => {
  const html = card(true);
  assert.ok(html.indexOf('Enabled · approved for use') < html.indexOf('Open Home'));
  assert.ok(html.indexOf('Open Home') < html.indexOf('App administration'));
  assert.match(html, /Manage connections/u);
  assert.doesNotMatch(html, /Declarative workspace App|Reviewed Runtime App|0 Modules|<details[^>]*\bopen/u);
  assert.match(html, /<summary[^>]*>App administration<\/summary>.*Stage upgrade.*Disable.*Action setup.*Update review/u);
  assert.match(html, /<summary[^>]*>Package details<\/summary>/u);
});

test('admin presentation retains owner gates and staged access review', () => {
  const member = card(false);
  assert.match(member, /Open Home/u);
  assert.doesNotMatch(member, /Stage upgrade|Disable<\/button>|Action setup|Update review|Manage connections/u);
  const staged = card(true, 'staged');
  assert.match(staged, /Needs review · approve access before use.*Access review/u);
  assert.doesNotMatch(staged, /Open Home|Action setup|Update review/u);
});

test('installation status distinguishes disabled, failed and staged without claiming connection health', () => {
  assert.match(renderToStaticMarkup(<AppInstallationStatus state="disabled" />), /app access is paused/u);
  assert.match(renderToStaticMarkup(<AppInstallationStatus state="failed" />), /setup did not finish/u);
  assert.match(renderToStaticMarkup(<AppInstallationStatus state="staged" />), /approve access before use/u);
});

test('compatible update trust renders explicit on, off and loading states', () => {
  assert.match(renderToStaticMarkup(<UpgradeTrustState trusted />), /On: compatible updates keep your approvals/u);
  assert.match(renderToStaticMarkup(<UpgradeTrustState trusted={false} />), /Off: updates need your review/u);
  assert.match(renderToStaticMarkup(<UpgradeTrustState trusted={null} />), /Checking update trust/u);
});

test('successful sync explains saved-copy freshness without contradicting success', () => {
  const html = renderToStaticMarkup(<ConnectionSyncSummary status={{ checkpoint: { retained_record_count: 112, last_applied_at: '2026-10-22T10:00:00Z' }, latest_run: { state: 'succeeded', terminal_at: '2026-10-22T10:00:00Z' } }} />);
  assert.match(html, /Latest sync to Deft.*succeeded.*latest sync finished successfully.*changes made at the source afterward/u);
  assert.match(html, /112/u);
  assert.doesNotMatch(html, /unverified|not been verified|unknown/u);
  const emptyStatus = renderToStaticMarkup(<ConnectionSyncSummary status={{ checkpoint: null, latest_run: null }} />);
  assert.match(emptyStatus, /Not started/u);
  assert.doesNotMatch(emptyStatus, /finished successfully/u);
});

test('unavailable saved item explains recovery with one connection link and no operator jargon', () => {
  const html = renderToStaticMarkup(<SavedResourceUnavailable />);
  assert.match(html, /This saved item isn’t available/u);
  assert.match(html, /access may have ended/u);
  assert.match(html, /href="\/settings\/apps\/private-resources"[^>]*>Check connection/u);
  assert.equal((html.match(/<a /gu) ?? []).length, 1);
  assert.doesNotMatch(html, /operator|owner session|source freshness|token/u);
});

function renderFunction(file: string, name: string, values: unknown[], extra: Record<string, unknown>, props: Record<string, unknown> = {}) {
  const text = readFileSync(new URL(file, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('fixture.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const js = ts.transpileModule(declaration.getText(parsed) + `\nglobalThis.Component=${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  let index = 0;
  const context = { globalThis: {} as { Component?: React.ElementType }, React, useState: (initial: unknown) => [index < values.length ? values[index++] : initial, () => {}], useRef: (initial: unknown) => ({ current: initial }), useCallback: (callback: unknown) => callback, useEffect: () => {}, useLayoutEffect: () => {}, ...extra };
  vm.runInNewContext(js, context);
  return renderToStaticMarkup(React.createElement(context.globalThis.Component!, props));
}

test('mobile connection details come before the list and setup remains collapsed', () => {
  const binding = { binding_id: 'binding', installation_id: 'app', resource_key: 'Records', state: 'active', channel: 'attachment' };
  const html = renderFunction('../app/(app)/settings/apps/private-resources/private-resources-client.tsx', 'PrivateResourceWorkspace', [[binding], null, null, { binding, checkpoint: null, latest_run: null }, null, null, false, false, false, 0], {
    useApps: () => ({ apps: [app] }), styles: { workspace: '' }, PageHeader: empty, Link: ({ children, ...props }: any) => <a {...props}>{children}</a>, RefreshCw: empty, LockKeyhole: empty, PrivateResourceSetup: empty, OperatorAssignments: empty, ConnectionSyncSummary, bindingDeadline: () => Infinity, bindingStateLabel: () => 'Active',
  });
  assert.match(html, /aria-label="Connection details" class="order-first[^"]*lg:order-none/u);
  assert.ok(html.indexOf('Connection details') < html.indexOf('Add a connection'));
  assert.doesNotMatch(html, /<details[^>]*\bopen/u);
});

test('unavailable saved-page state renders the recovery panel without loading jargon or duplicate actions', () => {
  const html = renderFunction('../components/apps/attachment-parent-view.tsx', 'OwnerView', [null, null, false, 'Saved item unavailable', null, null, '', false], {
    useRouter: () => ({}), PageHeader: empty, SavedResourceUnavailable, tap: { minHeight: 44 }, button: 'deft-pill',
  }, { bindingId: 'binding', projectionId: 'item', compact: false });
  assert.match(html, /Check connection/u);
  assert.doesNotMatch(html, /Reload saved item|Your connections|owner session|Source freshness/u);
  assert.equal((html.match(/<a /gu) ?? []).length, 1);
});
