import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { appRuntimeBindings, appVersions } from '@deft/db/schema';
import { createExperienceExposureDatabase } from '../src/lib/app-experience-exposure-db.js';
import { ExperienceExposureBusyError } from '../src/lib/app-experience-exposure-db-error.js';
import type { HumanActionAuthorityPort } from '../src/lib/app-experience-human-action-service.js';
import type { AppRunKeyProvider } from '../src/lib/app-run-keyrings.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target !== undefined && target === process.env.DATABASE_URL
  && ['127.0.0.1', 'localhost'].includes(new URL(target).hostname)
  && /^\/(?:exposure_pool_test|deft_test)$/.test(new URL(target).pathname);
const keys: AppRunKeyProvider = {
  current: () => ({ key_id: 'fixture', key: Buffer.alloc(32, 7) }),
  read: () => ({ key_id: 'fixture', key: Buffer.alloc(32, 7) }), keyIds: () => ['fixture'],
};
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Real service orchestration, target guards, ticket preparation and PostgreSQL
// admission. Reviewed metadata and external Runtime delivery are fixture seams:
// no application tables or provider credentials are needed in this disposable DB.
test('record, resource, batch and integration review preflights reserve capacity through the complete service path', { skip: !safe }, async t => {
  // Register module seams before loading the service graph: the ticket contract
  // also imports authority modules, so late mocks would leave cached real IO.
  const unexpected = () => { throw Error('unexpected fixture operation'); };
  mock.module(new URL('../src/lib/app-experience-service.ts', import.meta.url).href, { namedExports: {
    verifiedExperienceBundle: async () => ({ bundle: { schema_version: 'deft.experience_bundle.v3', record_store_keys: ['records'] } }),
    assertExperienceWeb: unexpected, assertExperienceMember: unexpected, appExperienceService: {},
  } });
  mock.module(new URL('../src/lib/app-experience-exposure.ts', import.meta.url).href, { namedExports: {
    AppExperienceExposureService: class { constructor() { return authority; } },
  } });
  mock.module(new URL('../src/lib/app-run-runtime.ts', import.meta.url).href, { namedExports: {
    getAppRunRuntime: async () => runtime, shutdownAppRunRuntime: async () => {},
  } });
  mock.module(new URL('../src/lib/app-connection-upgrade-fence.ts', import.meta.url).href, { namedExports: { appConnectionUpgradeSourceIsAvailable: async () => true } });
  mock.module(new URL('../src/lib/app-resource-batch-data-fence.ts', import.meta.url).href, { namedExports: {
    captureResourceBatchDataFence: async () => ({ expires_at: expiry.getTime() }), assertResourceBatchDataFence: async () => {},
  } });
  mock.module(new URL('../src/lib/app-integration-tool-prepared.ts', import.meta.url).href, { namedExports: {
    readOriginalPrepared: async () => ({ prepared: recordPrepared, provenance, row }),
    guardOriginalPrepared: async () => ({ action: { action_binding_id: binding } }), linkOriginalPrepared: unexpected,
    authorizeReleasedIntegrationTool: unexpected,
  } });
  mock.module(new URL('../src/lib/app-integration-tool-store.ts', import.meta.url).href, { namedExports: { readIntegrationTool: async () => row } });
  const { humanActionDigest, openHumanActionTicket } = await import('../src/lib/app-experience-human-action-contract.js');
  const { captureAppIntegrationPreparedProvenance } = await import('../src/lib/app-integration-prepared-provenance.js');
  const database = createExperienceExposureDatabase(target!);
  const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() };
  const session = randomUUID(), connection = randomUUID(), record = randomUUID(), account = randomUUID();
  const installation = randomUUID(), version = randomUUID(), grant = randomUUID(), binding = randomUUID(), resourceBinding = randomUUID(), exposure = randomUUID();
  const hash = humanActionDigest('fixture'), expiry = new Date(Date.now() + 300_000);
  const current = {
    scope: { installation_id: installation, app_version_id: version, grant_snapshot_id: grant,
      owner_user_id: caller.user_id, resource_binding_id: resourceBinding, target_key: 'primary', resource_key: 'records' },
    store: { key: 'records' }, connection: { session_id: connection, session_revision: 1, account_ref: account },
    consent: { consent_id: randomUUID(), consent_digest: hash }, expires_at: expiry.getTime(),
  };
  const recordPrepared = { schema_version: 'deft.app_prepared_record_action.v1', snapshot_id: randomUUID(), snapshot_digest: hash,
    record_id: record, revision: 1, action_key: 'write_record', input: { snapshot_id: '', account_ref: account },
    preview: { title: 'Reviewed record' }, expires_at: expiry.toISOString() };
  recordPrepared.input.snapshot_id = recordPrepared.snapshot_id;
  const sources = [{ resource_key: 'records', record_id: record, content_digest: hash }];
  const resourcePrepared = { schema_version: 'deft.app_prepared_resource_action.v1', snapshot_id: randomUUID(), snapshot_digest: hash,
    account_ref: account, action_key: 'organize_records', operation_key: 'archive', resource_key: 'records',
    source_manifest_digest: humanActionDigest(sources), item_count: 1,
    input: { snapshot_id: '', account_ref: account, operation_key: 'archive', source_manifest_digest: humanActionDigest(sources), item_count: 1, plan_digest: hash },
    preview: { title: 'Archive record', count: 1, items: [{ record_id: record, label: 'Reviewed record', before: 'Visible', after: 'Archived' }] },
    expires_at: expiry.toISOString() };
  resourcePrepared.input.snapshot_id = resourcePrepared.snapshot_id;
  const data = { caller, current: async () => current,
    prepare: async () => ({ prepared: recordPrepared, authority: current }),
    readPrepared: async () => ({ prepared: recordPrepared, authority: current }),
    prepareResource: async () => ({ prepared: resourcePrepared, authority: current }),
    readPreparedResource: async () => ({ prepared: resourcePrepared, authority: current }),
  };
  const releasedInput = (action: string) => {
    const isRecord = action === 'write_record', prepared = isRecord ? recordPrepared : resourcePrepared;
    return { ...prepared.input, [isRecord ? 'record_action_version' : 'resource_action_version']: prepared.schema_version,
      [isRecord ? 'record_store_key' : 'resource_store_key']: 'records', connection_session_id: connection,
      connection_revision: 1, data_consent_id: current.consent.consent_id, data_consent_digest: hash, prepared_digest: hash };
  };
  const transactionActions = new WeakMap<object, string>();
  const dialect = new PgDialect();
  let existingBatch: Record<string, unknown> | undefined;
  const purposes: Array<Parameters<HumanActionAuthorityPort['withHumanAction']>[7]> = [];
  let finalChecks = 0, revoked = false;
  let rendezvous: { entered: number; ready: ReturnType<typeof latch> } | undefined;
  const authority: HumanActionAuthorityPort = {
    async withHumanAction(_caller, _session, action, use, signal, _draft, supplied, purpose) {
      purposes.push(purpose);
      const run = async (real: any) => {
        await real.execute(sql`SELECT 1`);
        if (rendezvous && rendezvous.entered < 2) {
          const pair = rendezvous;
          if (++pair.entered === 2) pair.ready.resolve();
          await Promise.race([pair.ready.promise, delay(1500).then(() => { throw Error('two reviews must enter concurrently'); })]);
        }
        const tx = new Proxy(real, { get(object, property) {
          if (property === 'execute') return (query: any) => {
            const text = dialect.sqlToQuery(query).sql;
            if (text.startsWith('SELECT * FROM app_action_batches')) return Promise.resolve({ rows: existingBatch ? [existingBatch] : [] });
            if (text.startsWith('SELECT i.ordinal')) return Promise.resolve({ rows: [{ ordinal: 0, run_id: record, state: 'succeeded' }] });
            return real.execute(query);
          };
          if (property !== 'select') return Reflect.get(object, property);
          return () => { let table: unknown;
            const rows = () => table === appRuntimeBindings ? [{ id: binding, owner_resource_binding_id: resourceBinding,
              action_key: action, reviewed_by_user_id: caller.user_id }] : table === appVersions ? [{}] : [];
            const query = { from: (value: unknown) => { table = value; return query; }, where: () => query, limit: () => query,
              for: async () => rows(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows()).then(resolve) };
            return query;
          };
        } });
        transactionActions.set(tx, action);
        return use(tx, {
          session: { id: session, app_installation_id: installation, app_version_id: version, grant_snapshot_id: grant,
            resource_target_key: 'primary', experience_key: 'workspace', artifact_digest: hash, expires_at: expiry },
          runtime_binding_id: binding, action_label: 'Reviewed action', current_authority_expires_at: expiry,
          authorization_identity: { consent_grant_id: current.consent.consent_id, consent_epoch: 1, exposure_id: exposure, exposure_epoch: 1 },
        }, async (_tx, check) => {
          await real.execute(sql`SELECT 1`); finalChecks++;
          if (revoked) throw Error('fixture authority revoked');
          check?.();
        });
      };
      return supplied ? run(supplied) : database.transaction(run, signal, undefined, undefined, purpose);
    },
  };
  const runtime = { keys, liveAuthorization: {
    withPreparedResourceBatchCapture: async (_tx: unknown, _capture: unknown, use: () => Promise<unknown>) => use(),
    captureReviewedRuntimeInTransaction: async (tx: object) => {
    const input = releasedInput(transactionActions.get(tx)!);
    return { protocol_version: '7', binding: { id: binding, app_installation_id: installation, app_version_id: version,
      grant_snapshot_id: grant, owner_resource_binding_id: resourceBinding }, action: {
      input_schema: { type: 'object', properties: Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
        typeof value === 'number' ? { type: 'number', minimum: 0, maximum: 100 } : { type: 'string', maxLength: 512 }])),
        required: Object.keys(input), additionalProperties: false }, contract_digest: hash },
      authorization_snapshot: {}, provider_snapshot_digest: hash, installation_lifecycle_epoch: 1, installation_grant_epoch: 1 };
  } } };
  const invocation = randomUUID();
  const provenance = captureAppIntegrationPreparedProvenance({ invocation_id: invocation, invocation_digest: hash, prepared_kind: 'record',
    snapshot_id: recordPrepared.snapshot_id, snapshot_digest: hash, action_key: recordPrepared.action_key, installation_id: installation,
    account_ref: account, resource_binding_id: resourceBinding, store_key: 'records', expires_at: expiry.toISOString() });
  const row = { prepared: recordPrepared, metadata: { caller, target: { installation_id: installation, store_key: 'records' },
    envelope: { scope: { app_version_id: version, grant_snapshot_id: grant, target_key: 'primary' }, connection: current.connection },
    grant: { id: current.consent.consent_id, digest: hash } } };
  const { AppExperienceHumanActionService } = await import('../src/lib/app-experience-human-action-service.js');
  const { AppDataActionService } = await import('../src/lib/app-data-action-service.js');
  const { AppDataResourceActionService } = await import('../src/lib/app-data-resource-action-service.js');
  const { AppDataResourceBatchService } = await import('../src/lib/app-data-resource-batch-service.js');
  const { integrationToolReviewService } = await import('../src/lib/app-integration-tool-review.js');
  // Provider submission is outside this pool regression. Preserve a genuine
  // confirmation transaction at that final seam; contract tests cover release.
  const confirm = async (_caller: any, sid: string, request: any, signal?: AbortSignal) => {
    const ticket = openHumanActionTicket(keys, request.ticket);
    return authority.withHumanAction(caller, sid, ticket.action_key, async (tx, _human, final) => {
      await final(tx); return { run: { id: randomUUID(), state: 'succeeded' } };
    }, signal, undefined, undefined, 'human_action_confirmation');
  };
  mock.method(AppExperienceHumanActionService.prototype, 'confirm', confirm);
  mock.method(AppExperienceHumanActionService.prototype, 'confirmPreparedIntegration', confirm);
  mock.method(AppExperienceHumanActionService.prototype, 'confirmPreparedRecordAction', (c: any, s: string, r: any, _retain: any, signal?: AbortSignal) => confirm(c, s, r, signal));
  const human = new AppExperienceHumanActionService(authority, runtime as any);
  const recordService = new AppDataActionService(data as any, human, authority, keys);
  const resourceService = new AppDataResourceActionService(data as any, human, authority, keys);
  const batchService = new AppDataResourceBatchService(data as any, human, authority, keys, runtime as any);
  const integrationService = await integrationToolReviewService(caller);
  const recordRequest = { connection_session_id: connection, store_key: 'records', record_id: record,
    expected_revision: 1, content_digest: hash, idempotency_key: randomUUID() };
  const resourceRequest = { connection_session_id: connection, store_key: 'records', resource_key: 'records', operation_key: 'archive', sources, idempotency_key: randomUUID() };
  const confirmation = (review: { ticket: string; input_digest: string }) => ({ ticket: review.ticket, expected_input_digest: review.input_digest });
  async function saturated(use: () => Promise<void>) {
    const release = latch(), started = [latch(), latch()];
    const occupied = started.map(ready => database.transaction(async tx => { await tx.execute(sql`SELECT 1`); ready.resolve(); await release.promise; }));
    try {
      await Promise.race([Promise.all(started.map(ready => ready.promise)), Promise.all(occupied)]);
      await use();
    } finally { release.resolve(); await Promise.allSettled(occupied); rendezvous?.ready.resolve(); rendezvous = undefined; }
  }
  try {
    // Establish both review connections before holding ordinary capacity, so
    // the regression measures queued admission rather than cold TCP startup.
    const warmed = [latch(), latch()];
    const warming = warmed.map(ready => database.transaction(async tx => {
      await tx.execute(sql`SELECT 1`); ready.resolve(); await Promise.all(warmed.map(slot => slot.promise));
    }, undefined, undefined, undefined, 'human_action_preparation'));
    try { await Promise.all(warming); }
    finally { warmed.forEach(slot => slot.resolve()); await Promise.allSettled(warming); }
    for (const [name, prepare, confirmReview] of [
      ['record', () => recordService.prepare(session, 'primary', 'write_record', recordRequest), (review: any) => recordService.confirm(session, 'primary', confirmation(review))],
      ['resource', () => resourceService.prepareResource(session, 'primary', 'organize_records', resourceRequest), (review: any) => resourceService.confirmResource(session, 'primary', confirmation(review))],
      ['integration', () => integrationService.prepare(session, invocation), (review: any) => integrationService.confirm(session, confirmation(review))],
    ] as const) await t.test(`${name} preparation and confirmation succeed while ordinary capacity is occupied`, async () => saturated(async () => {
      const start = purposes.length;
      const review = await prepare();
      assert.ok(purposes.length > start);
      assert.ok(purposes.slice(start).every(purpose => purpose === 'human_action_preparation'));
      const prepared = purposes.length;
      const result = await confirmReview(review);
      assert.equal(result.run.state, 'succeeded');
      assert.ok(purposes.length > prepared);
      assert.ok(purposes.slice(prepared).every(purpose => purpose === 'human_action_confirmation'));
    }));
    await t.test('two complete reviews advance together while ordinary status cannot enter the reserved pool', async () => saturated(async () => {
      const status = assert.rejects(integrationService.status(session, invocation), error => error instanceof ExperienceExposureBusyError && error.reason === 'acquisition');
      rendezvous = { entered: 0, ready: latch() };
      const reviews = await Promise.all([recordService.prepare(session, 'primary', 'write_record', recordRequest),
        resourceService.prepareResource(session, 'primary', 'organize_records', resourceRequest)]);
      assert.equal(rendezvous.entered, 2); assert.equal(reviews.length, 2);
      await status;
    }));
    await t.test('batch preparation and confirmation retain reserved capacity through every child preflight', async () => saturated(async () => {
      const start = purposes.length;
      const { connection_session_id: _connection, idempotency_key: _id, ...child } = resourceRequest;
      const review = await batchService.prepareBatch(session, 'primary', 'organize_records', {
        connection_session_id: connection, idempotency_key: randomUUID(), children: [{ ...child, action_key: 'organize_records' }],
      });
      assert.ok(purposes.slice(start).every(purpose => purpose === 'human_action_preparation'));
      const prepared = purposes.length;
      existingBatch = { id: review.batch_id, owner_user_id: caller.user_id, release_mode: 'prepared_resource_sequential',
        experience_session_id: session, connection_session_id: connection, content_digest: review.review_digest, state: 'approved' };
      const confirmed = await batchService.confirmBatch(session, 'primary', { review, expected_input_digest: review.input_digest });
      assert.equal(confirmed.batch.id, review.batch_id);
      assert.ok(purposes.slice(prepared).every(purpose => purpose === 'human_action_confirmation'));
    }));
    await t.test('reserved admission still denies a newly revoked authority', async () => saturated(async () => {
      revoked = true;
      try { await assert.rejects(recordService.prepare(session, 'primary', 'write_record', recordRequest), /fixture authority revoked/); }
      finally { revoked = false; }
    }));
    assert.ok(finalChecks >= 20, 'fresh guards execute throughout preparation and confirmation');
  } finally { mock.restoreAll(); await database.close(); }
});
