import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { beginAppConnection } from './app-connection-session-flow';
import { readFileSync } from 'node:fs';

const installation = randomUUID();
const org = randomUUID();
const owner = randomUUID();
const session = randomUUID();
const nonce = 'n'.repeat(43);
const expiry = new Date(Date.now() + 600_000).toISOString();
const scope = {
  org_id: org, owner_user_id: owner, installation_id: installation, target_key: 'sender',
  app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), package_digest: 'sha256:' + 'a'.repeat(64),
  grant_snapshot_digest: 'sha256:' + 'b'.repeat(64), lifecycle_epoch: 1, grant_epoch: 1,
  resource_key: 'inbox', resource_binding_id: randomUUID(), runtime_registration_id: randomUUID(),
  operator_user_id: randomUUID(), runtime_epoch: 1, profile_digest: 'sha256:' + 'c'.repeat(64),
  consent_expires_at: expiry,
};
const profile = { key: 'primary_readonly', label: 'Primary', authorization_origin: 'https://accounts.example.com' };
const notConnectedSession = {
  schema_version: 'deft.app_connection_session.v1', session_id: session, state: 'not_connected',
  scope, expires_at: expiry, account: null,
};
const begun = {
  schema_version: 'deft.app_connection_session.v1', session_id: session, state: 'awaiting_callback',
  scope, expires_at: expiry, account: null, callback_state: nonce,
  authorization_url: `https://accounts.example.com/o/oauth2/v2/auth?state=${nonce}`,
};
const identity = { installationId: installation, experienceKey: 'main', orgId: org, ownerId: owner, sessionTag: 'd'.repeat(64) };
const baseContextWithTarget = {
  schema_version: 'deft.app_connection_context.v1', installation_id: installation, org_id: org,
  owner_user_id: owner, targets: [{ target_key: 'sender', profile, scope, runtime_ready: true, session: notConnectedSession }],
};
const emptyBaseContext = {
  schema_version: 'deft.app_connection_context.v1', installation_id: installation, org_id: org,
  owner_user_id: owner, targets: [],
};
const upgradeContext = {
  schema_version: 'deft.app_connection_upgrade_context.v1', installation_id: installation, org_id: org,
  owner_user_id: owner, targets: [{ target_key: 'sender', profile, scope, runtime_ready: true, session: notConnectedSession, upgrade: { candidate: null, pending: null } }],
};

function storage() {
  const rows = new Map<string, string>();
  return { getItem: (k: string) => rows.get(k) ?? null, setItem: (k: string, v: string) => { rows.set(k, v); }, removeItem: (k: string) => { rows.delete(k); } };
}

test('beginAppConnection posts v2/begin when includeUpgrades is true and returns the URL without navigating', async () => {
  const s = storage();
  const calls: string[] = [];
  const assignCalls: string[] = [];
  (globalThis as any).window = { location: { assign: (url: string) => { assignCalls.push(url); } } };
  const fetch = async (path: string, init: RequestInit) => {
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path.includes('/upgrade-context')) return Response.json(upgradeContext);
    if (path.includes('/context')) return Response.json(emptyBaseContext);
    if (path.includes('/v2/begin')) return Response.json(begun);
    throw new Error(path);
  };
  const ports = { identity, storage: s, current: () => true, fetch, includeUpgrades: true };
  const url = await beginAppConnection(ports as any, 'sender');
  assert.equal(url, begun.authorization_url);
  assert.ok(calls.some(c => c.includes('POST') && c.includes('/v2/begin')));
  assert.equal(assignCalls.length, 0);
  delete (globalThis as any).window;
});

test('beginAppConnection posts begin when includeUpgrades is false and returns the URL without navigating', async () => {
  const s = storage();
  const calls: string[] = [];
  const assignCalls: string[] = [];
  (globalThis as any).window = { location: { assign: (url: string) => { assignCalls.push(url); } } };
  const fetch = async (path: string, init: RequestInit) => {
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path.includes('/context')) return Response.json(baseContextWithTarget);
    if (path.includes('/begin')) return Response.json(begun);
    throw new Error(path);
  };
  const ports = { identity, storage: s, current: () => true, fetch, includeUpgrades: false };
  const url = await beginAppConnection(ports as any, 'sender');
  assert.equal(url, begun.authorization_url);
  assert.ok(calls.some(c => c.includes('POST') && /\/begin$/.test(c.split(' ')[1])));
  assert.ok(!calls.some(c => c.includes('v2/begin')));
  assert.equal(assignCalls.length, 0);
  delete (globalThis as any).window;
});

test('beginAppConnection request bodies carry installation_id and target_key', async () => {
  const s = storage();
  let body: any = null;
  const fetch = async (path: string, init: RequestInit) => {
    if (path.includes('/context')) return Response.json(baseContextWithTarget);
    if (path.includes('/begin')) { body = JSON.parse(init.body as string); return Response.json(begun); }
    throw new Error(path);
  };
  const ports = { identity, storage: s, current: () => true, fetch, includeUpgrades: false };
  await beginAppConnection(ports as any, 'sender');
  assert.equal(body.installation_id, installation);
  assert.equal(body.target_key, 'sender');
});

test('installed-app and settings port builders agree on includeUpgrades for the same installation', () => {
  const installed = readFileSync(new URL('../components/apps/installed-app-experience.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../components/apps/experience-connection-settings.tsx', import.meta.url), 'utf8');
  assert.ok(installed.includes('includeUpgrades:!!session?.bundle?.record_store_keys?.length'));
  assert.ok(settings.includes('includeUpgrades:props.appOwnedRecords===true'));
  assert.match(installed, /appOwnedRecords=\{\!\!session\.bundle\.record_store_keys\?\.length\}/);
});

test('dispatcher reconnect path checks current before navigating and falls back to settings on failure', () => {
  const installed = readFileSync(new URL('../components/apps/installed-app-experience.tsx', import.meta.url), 'utf8');
  assert.match(installed, /if\(!locallyCurrent\(\)\)return;/);
  assert.match(installed, /await showSettings\(true\);/);
});