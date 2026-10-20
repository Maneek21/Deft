import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExperienceBackgroundRefresh} from '../components/apps/experience-background-refresh';
import type {AppConnectionTarget} from './app-connection-session-flow';
import {normalizeInstalledExperienceSession} from './app-experience-session';

const target = {
  target_key: 'workspace',
  scope: {installation_id: 'installation'},
  session: {state: 'connected', session_id: 'session', account: {account_ref: 'account'}},
} as AppConnectionTarget;
const props = {target, ownerId: 'owner', orgId: 'org', disabled: false, onBusy: () => {}};

test('background refresh defaults to app-neutral copy', () => {
  const html = renderToStaticMarkup(<ExperienceBackgroundRefresh {...props}/>);
  assert.ok(html.includes('Keep this app&#x27;s data current while it is closed.'));
});

test('background refresh renders the supplied experience description as text', () => {
  const html = renderToStaticMarkup(<ExperienceBackgroundRefresh {...props}
    description={'Keep project updates current & ready.'}/>);
  assert.ok(html.includes('Keep project updates current &amp; ready.'));
  assert.ok(!html.includes('Keep this app&#x27;s data current'));
});

test('session loading preserves optional background refresh copy and rejects invalid values', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const session = {
    pin: {org_id: id, user_id: id, app_installation_id: id, app_version_id: id,
      grant_snapshot_id: id, lifecycle_epoch: 1, grant_epoch: 1, session_id: id, session_epoch: 1},
    experience: {key: 'workspace', label: 'Workspace', artifact_digest: 'sha256:' + 'a'.repeat(64),
      bridge_version: 'deft.experience_bridge.v1', renderer_version: 'deft.trusted_renderer.v1'},
    bundle: {schema_version: 'deft.experience_bundle.v1', worker_source: 'self.onmessage=()=>{}',
      entry_view: 'workspace', resource_keys: ['records'], action_keys: []},
    expires_at: '2030-01-01T00:00:00Z',
  };
  assert.deepEqual(normalizeInstalledExperienceSession(session), session);
  const description = 'Keep project updates current & ready.';
  const normalized = normalizeInstalledExperienceSession({...session,
    bundle: {...session.bundle, background_refresh_description: description}});
  const html = renderToStaticMarkup(<ExperienceBackgroundRefresh {...props}
    description={normalized.bundle.background_refresh_description}/>);
  assert.ok(html.includes('Keep project updates current &amp; ready.'));
  for (const invalid of ['', ' ', 'x'.repeat(501), 42, null, 'bad\u0000text']) {
    assert.throws(() => normalizeInstalledExperienceSession({...session,
      bundle: {...session.bundle, background_refresh_description: invalid}}));
  }
});
