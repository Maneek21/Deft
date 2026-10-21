import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appConsentDeadline } from '../../../../packages/app-kit/src/consent-lifetime';
import { finishInitialConnectConsent, finishAcknowledgedInitialConnection, initialConnectChoice, initialConnectPlan } from './app-initial-connect-consent';

const hash = 'sha256:' + 'a'.repeat(64), future = () => new Date(Date.now() + 86400000).toISOString();
function fixture(finite = false) {
  const scope = { org_id: randomUUID(), owner_user_id: randomUUID(), installation_id: randomUUID(), app_version_id: randomUUID(),
    grant_snapshot_id: randomUUID(), package_digest: hash, grant_snapshot_digest: hash, lifecycle_epoch: 1, grant_epoch: 1,
    target_key: 'personal', resource_key: 'records', resource_binding_id: randomUUID(), runtime_registration_id: randomUUID(),
    operator_user_id: randomUUID(), runtime_epoch: 1, profile_digest: hash,
    ...(finite ? { consent_expires_at: future() } : { consent_expires_at: null, consent_lifetime: 'until_revoked' as const }) };
  const account = { account_ref: 'owned_account', label: 'Synthetic account' };
  const target = { target_key: scope.target_key, scope, session: { schema_version: 'deft.app_connection_session.v1' as const,
    session_id: randomUUID(), state: 'connected' as const, scope, account, expires_at: scope.consent_expires_at } };
  let plan = initialConnectPlan({ schema_version: 'deft.initial_connect_consent.v1', org_id: scope.org_id, owner_user_id: scope.owner_user_id,
    installation_id: scope.installation_id, session_tag: 'a'.repeat(64), target_key: scope.target_key, resource_key: scope.resource_key,
    resource_binding_id: scope.resource_binding_id, app_version_id: scope.app_version_id, grant_snapshot_id: scope.grant_snapshot_id,
    choice: finite ? { expires_at: scope.consent_expires_at } : { expires_at: null, consent_lifetime: 'until_revoked' },
    completed_stores: [], pending_store: null, observation: null, phase: 'permissions' });
  const declarations = ['drafts', 'preferences'].map(key => ({ schema_version: 'deft.app_record_store.v1' as const, key,
    resource_key: scope.resource_key, runtime_requirement_key: 'provider', max_record_bytes: 8192, max_files: 1,
    max_file_bytes: 2048, max_total_file_bytes: 2048 }));
  const grants = new Map<string, any>(), reviews = new Map<string, any>();
  let observed: any, observationState = 'proposed';
  const calls: { path: string; body: any }[] = [], abort = new AbortController();
  let live = true, intercept: (path: string, body: any, result: any) => any = (_p, _b, result) => result;
  const context = () => ({ schema_version: 'deft.app_data_context.v1', installation_id: scope.installation_id,
    targets: [{ session_id: target.session.session_id, target_key: target.target_key, account, resource_key: scope.resource_key,
      identities: [], ...(finite ? {} : { allow_until_revoked: true }), stores: declarations.map(declaration => ({ declaration, consent: grants.get(declaration.key) ?? null })) }] });
  const request = async (path: string, body?: any) => {
    calls.push({ path, body }); let result: any;
    if (path.startsWith('/api/app-data/installations/')) result = context();
    else if (path.startsWith('/api/app-data/') && path.endsWith('/review')) {
      const snapshot = { schema_version: 'deft.app_data_consent.v1', consent_id: randomUUID(), scope,
        connection: { session_id: target.session.session_id, session_revision: 2, runtime_session_ref: 'runtime_ref', account_ref: account.account_ref },
        store: declarations.find(d => d.key === body.store_key), data_policy_digest: hash, purpose: 'human_record_write', ...plan.choice,
        ...('consent_lifetime' in plan.choice ? { review_expires_at: new Date(Date.now() + 300000).toISOString() } : {}) };
      result = { snapshot, review_digest: hash }; reviews.set(body.store_key, snapshot);
    } else if (path.startsWith('/api/app-data/') && path.endsWith('/activate')) {
      result = { consent_id: body.consent_id, consent_digest: hash, expires_at: body.expires_at,
        ...(body.consent_lifetime ? { consent_lifetime: body.consent_lifetime } : {}) }; grants.set(body.store_key, result);
    } else if (path.startsWith('/api/app-resource-observations/')) {
      if (path.endsWith('/context')) result = { schema_version: 'deft.app_resource_observation_context.v1', installation_id: scope.installation_id,
        org_id: scope.org_id, owner_user_id: scope.owner_user_id, targets: [{ target_key: target.target_key, scope,
          connection_session_id: target.session.session_id, account, min_interval_seconds: 900, attachment_mode: 'unsupported',
          ...(finite ? {} : { allow_until_revoked: true }), consent: observed ? { consent_id: observed.consent_id, state: observationState } : null }] };
      else if (path.endsWith('/review')) {
        observed = { schema_version: 'deft.app_resource_observation_review.v1', consent_id: body.request_id, review_digest: hash,
          scope, connection_session_id: target.session.session_id, account, expected_custody_generation: null,
          interval_seconds: body.interval_seconds, attachment_mode: 'unsupported', ...plan.choice,
          ...('consent_lifetime' in plan.choice ? { review_expires_at: new Date(Date.now() + 300000).toISOString() } : {}) }; result = observed;
      } else { if (path.endsWith('/activate')) observationState = 'active';
        result = { schema_version: 'deft.app_resource_observation_status.v1', consent_id: observed.consent_id, state: observationState, review: observed }; }
    } else if (path.endsWith('/background-access')) result = { installed: [{ kind: 'observation', runtime_registration_id: scope.runtime_registration_id,
      session_id: randomUUID(), expires_at: future() }], skipped: [] };
    else assert.fail('Unexpected request: ' + path);
    return intercept(path, body, structuredClone(result));
  };
  const ports = { target, org: scope.org_id, owner: scope.owner_user_id, installation: scope.installation_id,
    sessionTag: 'a'.repeat(64), current: () => live, signal: abort.signal, load: () => plan,
    save: (value: typeof plan) => { plan = structuredClone(value); }, request };
  return { scope, target, grants, reviews, calls, ports, abort, context, plan: () => plan, live: (value: boolean) => { live = value; },
    intercept: (fn: typeof intercept) => { intercept = fn; }, finish: () => finishInitialConnectConsent(ports) };
}

test('initial selection is one until-revoked choice with an explicit finite alternative', () => {
  assert.deepEqual(initialConnectChoice(true, future()), { expires_at: null, consent_lifetime: 'until_revoked' });
  const date = future(); assert.deepEqual(initialConnectChoice(true, date, true), { expires_at: date });
  assert.deepEqual(initialConnectChoice(false, date), { expires_at: date });
  for (const choice of [{ expires_at: null }, { expires_at: date, consent_lifetime: 'until_revoked' }]) {
    const f = fixture(); assert.throws(() => initialConnectPlan({ ...f.plan(), choice }));
  }
});

test('acknowledged initial connection applies private records and observation before installing background access', async () => {
  const f = fixture(); await f.finish(); assert.equal(f.plan().phase, 'complete');
  assert.equal(f.grants.size, 2);
  for (const grant of f.grants.values()) assert.equal(appConsentDeadline(grant.expires_at, grant.consent_lifetime), Infinity);
  const writes = f.calls.filter(call => call.path.endsWith('/review'));
  assert.equal(writes.length, 3); assert.ok(writes.every(call => call.body.expires_at === null && call.body.consent_lifetime === 'until_revoked'));
  const install = f.calls.findIndex(call => call.path.endsWith('/background-access'));
  assert.ok(install > f.calls.findIndex(call => call.path === '/api/app-resource-observations/consent/activate'));
  assert.deepEqual(f.calls[install]!.body, { target_key: f.target.target_key });
  assert.ok(f.calls.every(call => !/actions|mirror|grants/u.test(call.path)));
  assert.doesNotMatch(JSON.stringify(f.plan()), /runtime_ref|session_token|authorization|access_token/u);
});

test('durable consent remains selected after 24 hours and seven days without more reviews', async t => {
  const f = fixture(), now = Date.now(); await f.finish(); const count = f.calls.length;
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const days of [1, 7]) { t.mock.timers.setTime(now + days * 86400000); await f.finish();
    assert.equal(f.calls.length, count); for (const grant of f.grants.values()) assert.equal(appConsentDeadline(grant.expires_at, grant.consent_lifetime), Infinity); }
});

test('finite permissions remain finite and are not silently converted to renewable channels', async () => {
  const f = fixture(true); await assert.rejects(f.finish(), /Finite private-record and observation permissions are saved/);
  for (const grant of f.grants.values()) { assert.equal(grant.expires_at, f.scope.consent_expires_at); assert.equal(grant.consent_lifetime, undefined); }
  assert.equal(f.calls.some(call => call.path.endsWith('/background-access')), false);
});

test('existing finite record permissions are retained byte-for-byte', async () => {
  const f = fixture(), grant = { consent_id: randomUUID(), consent_digest: hash, expires_at: future() };
  f.grants.set('drafts', structuredClone(grant)); await f.finish(); assert.deepEqual(f.grants.get('drafts'), grant);
  assert.equal(f.calls.some(call => call.body?.store_key === 'drafts'), false);
});

test('no new permission is released before connection acknowledgement or for changed scope/session', async () => {
  for (const field of ['state', 'owner', 'binding', 'version', 'session', 'abort', 'current']) {
    const f = fixture();
    if (field === 'state') (f.target.session as any).state = 'awaiting_callback';
    if (field === 'owner') f.ports.owner = randomUUID();
    if (field === 'binding') f.target.scope.resource_binding_id = randomUUID();
    if (field === 'version') f.target.scope.app_version_id = randomUUID();
    if (field === 'session') f.ports.sessionTag = 'b'.repeat(64);
    if (field === 'abort') f.abort.abort();
    if (field === 'current') f.live(false);
    await assert.rejects(f.finish()); assert.equal(f.calls.length, 0, field);
  }
});

test('lost private-record activation ACK is reconciled from context, never repeated', async () => {
  const f = fixture(); let lost = false;
  f.intercept((path, _body, result) => { if (!lost && path.startsWith('/api/app-data/') && path.endsWith('/activate')) { lost = true; throw Error('Lost ACK'); } return result; });
  await assert.rejects(f.finish(), /Lost ACK/); await f.finish();
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/app-data/') && call.path.endsWith('/activate') && call.body.store_key === 'drafts').length, 1);
  assert.equal(f.plan().phase, 'complete');
});

test('lost private-record review ACK stays fenced, and a foreign review cannot activate', async () => {
  const f = fixture(); f.intercept((path, _body, result) => { if (path.startsWith('/api/app-data/') && path.endsWith('/review')) throw Error('Lost review'); return result; });
  await assert.rejects(f.finish()); await assert.rejects(f.finish(), /not confirmed/);
  assert.equal(f.calls.filter(call => call.path.endsWith('/review')).length, 1);
  assert.equal(f.calls.some(call => call.path.endsWith('/activate')), false);
  const foreign = fixture(); foreign.intercept((path, _body, result) => path.startsWith('/api/app-data/') && path.endsWith('/review')
    ? { ...result, snapshot: { ...result.snapshot, scope: { ...result.snapshot.scope, owner_user_id: randomUUID() } } } : result);
  await assert.rejects(foreign.finish()); assert.equal(foreign.calls.some(call => call.path.endsWith('/activate')), false);
});

test('lost observation ACK uses status and never activates it twice', async () => {
  const f = fixture(); let lost = false;
  f.intercept((path, _body, result) => { if (!lost && path === '/api/app-resource-observations/consent/activate') { lost = true; throw Error('Lost ACK'); } return result; });
  await assert.rejects(f.finish()); await f.finish();
  assert.equal(f.calls.filter(call => call.path === '/api/app-resource-observations/consent/activate').length, 1);
  assert.equal(f.plan().phase, 'complete');
});

test('lost background installation ACK remains fenced rather than repeating installation', async () => {
  const f = fixture(); f.intercept((path, _body, result) => { if (path.endsWith('/background-access')) throw Error('Lost install ACK'); return result; });
  await assert.rejects(f.finish()); await assert.rejects(f.finish(), /installation acknowledgement/);
  assert.equal(f.calls.filter(call => call.path.endsWith('/background-access')).length, 1);
});

test('an existing connected account without an explicit initial Allow journal performs no setup', async () => {
  const f = fixture(); assert.equal(await finishAcknowledgedInitialConnection({ ...f.ports,
    storage: { getItem: () => null, setItem: () => assert.fail('unexpected journal') }, fetch: async () => assert.fail('unexpected request') }), false);
  assert.equal(f.calls.length, 0);
});

test('the actual initial consent screen selects one durable lifetime, discloses purposes, and keeps finite existing accounts out', () => {
  const path = new URL('../components/apps/experience-initial-connect-consent.tsx', import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ExperienceInitialConnectConsent')!;
  const program = ts.transpileModule('(' + declaration.getText().replace(/^export /u, '') + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const request = { admission_id: randomUUID(), admission_digest: hash, target_key: 'personal', consent_expires_at: future(),
    limits: { max_records_per_page: 25, max_page_bytes: 65536, max_retained_records: 1000, max_retained_bytes: 1048576, min_interval_seconds: 900 },
    attachment_policy: { allowed_media_types: ['application/pdf'], max_attachment_bytes: 2048, max_attachments_per_record: 1,
      max_attachments_per_run: 1, max_attachment_bytes_per_run: 2048, retention_days: 7 } };
  const render = (finite: boolean, existing: boolean) => {
    const policy = { record_store_keys: ['drafts','preferences'], policy: { key: 'provider', resource_key: 'records', action_keys: ['send', 'organize', 'mirror'], max_consent_seconds: 86400, allow_until_revoked: true },
      admission: { ...request, operator_label: 'Approved operator', resource_request: request },
      bindings: existing ? [{ target_key: 'personal', consent_expires_at: future() }] : [] };
    const states = [[policy], 'provider', finite, '2030-01-01T12:00', null, '', false]; let index = 0;
    const Component = runInNewContext(program, { React, localDate: () => '2030-01-01T12:00', useEffect: () => {}, useRef: (current: unknown) => ({ current }),
      useState: () => [states[index++], () => {}] });
    return renderToStaticMarkup(Component({ installationId: randomUUID(), ownerId: randomUUID(), orgId: randomUUID(),
      sessionScope: 'scope', disabled: false, onBusy: () => {}, onConfigured: () => {} }));
  };
  const html = render(false, false);
  assert.match(html, /value="until_revoked" selected=""/u);
  assert.equal((html.match(/Permission lifetime/gu) ?? []).length, 1);
  assert.match(html, /private records and drafts/u); assert.match(html, /background metadata refresh/u);
  assert.match(html, /provider draft mirroring/u); assert.match(html, /require their own permissions/u);
  assert.doesNotMatch(html, /datetime-local|24 hours/u);
  assert.match(render(true, false), /datetime-local/u);
  assert.equal(render(false, true), '', 'loading an existing finite account never offers implicit initial permission');
});
