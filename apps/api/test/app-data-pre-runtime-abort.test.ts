import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mock, test } from 'node:test';

Object.assign(process.env, { DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/deft_test',
  DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true', DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
  DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
  DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_OWNER_CONNECTIONS_ENABLED: 'true' });
const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`synthetic-abort-${id}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('enc'), receipt_signing: ring('sign'), fingerprint: ring('fp') });

test('actual App data route distinguishes client cancellation from authority and backend failures without replaying journals', async t => {
  const id = randomUUID, digest = `sha256:${'a'.repeat(64)}`, expiry = Date.now() + 60_000;
  const who = { org_id: id(), user_id: id(), sid: id() };
  const auth = await import('../src/lib/app-resource-sync-web-authority.js');
  const guard = Object.assign(async () => {}, { current_web_session_expires_at: () => new Date(expiry) });
  mock.module(new URL('../src/lib/app-resource-sync-web-authority.ts', import.meta.url).href, { namedExports: {
    ...auth, resourceSyncWebAuthority: async () => ({ actor: { org_id: who.org_id, actor_id: who.user_id },
      web_session: { sid: who.sid, expires_at: expiry }, guard }),
  } });
  const [{ AppDataService }, { PostgresAppDataStore }, { measureAppDataPhase }, { createAppDataRoutes },
    { AppConnectionSessionRegistry }, { AppError }] = await Promise.all([
    import('../src/lib/app-data-service.js'), import('../src/lib/app-data-store.js'),
    import('../src/lib/app-data-diagnostics.js'), import('../src/routes/app-data.js'),
    import('../src/lib/app-connection-session-registry.js'), import('../src/lib/app-errors.js'),
  ]);
  const scope = { org_id: who.org_id, owner_user_id: who.user_id,
    installation_id: id(), app_version_id: id(), grant_snapshot_id: id(), package_digest: digest,
    grant_snapshot_digest: digest, lifecycle_epoch: 1, grant_epoch: 1, target_key: 'primary',
    resource_key: 'inbox', resource_binding_id: id(), runtime_registration_id: id(), operator_user_id: id(),
    runtime_epoch: 1, profile_digest: digest, consent_expires_at: new Date(expiry).toISOString() };
  const scenarios = [
    { name: 'client cancellation before dispatch', abort: 'before', status: 499, code: 'APP_REQUEST_ABORTED', kind: 'request_aborted', dispatched: 0 },
    { name: 'client cancellation after dispatch retains indeterminate journal', abort: 'after', status: 499, code: 'APP_REQUEST_ABORTED', kind: 'request_aborted', dispatched: 1 },
    { name: 'internal abort with a live client is still a backend failure', failure: 'internal_abort', status: 503, code: 'APP_PROVIDER_UNAVAILABLE', kind: 'request_aborted', dispatched: 0 },
    { name: 'authority denial remains forbidden even after client cancellation', abort: 'before', failure: 'deny', status: 403, code: 'APP_ACCESS_DENIED', kind: 'authority_denied', dispatched: 0 },
    { name: 'unrelated backend failure is not hidden by client cancellation', abort: 'before', failure: 'unexpected', status: 503, code: 'APP_PROVIDER_UNAVAILABLE', kind: 'unclassified', dispatched: 0 },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async sub => {
  const controller = new AbortController(); let checks = 0, dispatches = 0;
  const sessionId = id();
  const authority = { scope, connection: { session_id: sessionId, session_revision: 1,
    runtime_session_ref: 'synthetic_runtime', account_ref: 'synthetic_account' },
    store: { key: 'drafts', resource_key: 'inbox' }, expires_at: expiry,
    consent: { consent_id: id(), consent_digest: digest, expires_at: new Date(expiry) }, data_policy_digest: digest };
  const begun: unknown[] = [], finished: unknown[] = [], events: Array<Record<string, unknown>> = [];
  sub.mock.method(PostgresAppDataStore.prototype, 'begin', async (value: unknown) => { begun.push(value); return true; });
  sub.mock.method(PostgresAppDataStore.prototype, 'finish', async (...value: unknown[]) => { finished.push(value); return true; });
  sub.mock.method(AppDataService.prototype, 'current', async () => measureAppDataPhase('current', async () => {
    if (++checks === 2) {
      if (scenario.abort === 'before') controller.abort();
      if (scenario.failure === 'internal_abort') throw new DOMException('Synthetic internal deadline', 'AbortError');
      if (scenario.failure === 'deny') throw new AppError('Synthetic authority denial', 'APP_ACCESS_DENIED', 403);
      if (scenario.failure === 'unexpected') throw new Error('Synthetic backend failure');
    }
    return authority as never;
  }));
  sub.mock.method(AppConnectionSessionRegistry.prototype, 'dataRuntime', () => ({ request: async () => {
    dispatches++; if (scenario.abort === 'after') controller.abort(); return {} as never;
  } }));
  sub.mock.method(console, 'info', (value: string) => { const parsed = JSON.parse(value); if (parsed.event === 'app_data_timing') events.push(parsed); });
  const requestId = id();
  const response = await createAppDataRoutes().fetch(new Request(`http://synthetic.test/connections/${sessionId}/requests`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
    signal: controller.signal, body: JSON.stringify({ schema_version: 'deft.app_data_request.v1', request_id: requestId,
      operation: 'record_read', input: { store_key: 'drafts', record_id: id() } }),
  }));
  assert.equal(checks, 2); assert.equal(begun.length, 1); assert.equal(dispatches, scenario.dispatched);
  assert.deepEqual(finished, [[requestId, 'indeterminate', null]]);
  assert.equal(events.length, 1); assert.equal(events[0]!.failure_kind, scenario.kind);
  const timings = events[0]!.timings as Record<string, { calls: number }>;
  assert.equal(timings.current!.calls, 2); assert.equal(timings.runtime_request?.calls ?? 0, scenario.dispatched);
  assert.equal(response.status, scenario.status);
  const body = await response.json() as { code: string; output?: unknown };
  assert.equal(body.code, scenario.code); assert.equal(body.output, undefined);
  });
});
