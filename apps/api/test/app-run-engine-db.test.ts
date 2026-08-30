import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { APP_RUN_CONTRACT_VERSIONS } from '@deft/shared';
import { AppRunAttemptRunner } from '../src/lib/app-run-attempt-runner.js';
import type {
  AppRunProviderExecutionRequest,
  AppRunProviderExecutionResult,
  AppRunProviderExecutor,
} from '../src/lib/app-run-provider-executor.js';
import { PostgresAppRunRepository } from '../src/lib/app-run-repository.js';
import { AppRunSecretRepository } from '../src/lib/app-run-secret-repository.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { AppRunService } from '../src/lib/app-run-service.js';
import { createAppRunAttemptJobHandler } from '../src/lib/app-run-worker-handler.js';
import { parseEnvironmentAppRunKeyrings, type EnvironmentAppRunKeyProvider } from '../src/lib/app-run-keyrings.js';
import { closeDb } from '../src/lib/db.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL
  ?? (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!DATABASE_URL) throw new Error('App Run engine DB tests require DEFT_TEST_DATABASE_URL');
if (process.env.CI !== 'true' && !/phase3|test|ci|acceptance/i.test(new URL(DATABASE_URL).pathname)) {
  throw new Error('App Run engine DB tests require an explicitly disposable database');
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ORG_ID = `app-run-org-${suffix}`;
const SNAPSHOT_ID = `app-run-snapshot-${suffix}`;
const PROVIDER_ID = `app-run-provider-${suffix}`;
const USER_ID = `app-run-user-${suffix}`;
const digest = `sha256:${'a'.repeat(64)}`;
const { Client } = pg;
let client: pg.Client;
const providers: EnvironmentAppRunKeyProvider[] = [];

function key(seed: number): string {
  return Buffer.alloc(32, seed).toString('base64');
}

function keyProvider(
  fingerprintCurrent: 'fp-v1' | 'fp-old' = 'fp-v1',
  includeOld = true,
): EnvironmentAppRunKeyProvider {
  const provider = parseEnvironmentAppRunKeyrings(JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key(1) } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key(2) } },
    fingerprint: {
      current: fingerprintCurrent,
      keys: includeOld ? { 'fp-v1': key(3), 'fp-old': key(4) } : { 'fp-v1': key(3) },
    },
  }));
  providers.push(provider);
  return provider;
}

const allowAll = { async authorize() { return true; } };

function service(
  now: () => Date = () => new Date(),
  allow = allowAll,
  keyOptions: Readonly<{ current?: 'fp-v1' | 'fp-old'; includeOld?: boolean }> = {},
) {
  const keys = keyProvider(keyOptions.current, keyOptions.includeOld);
  const secrets = new AppRunSecretService(keys);
  const repository = new PostgresAppRunRepository();
  const secretRepository = new AppRunSecretRepository(secrets);
  return {
    service: new AppRunService(repository, secretRepository, secrets, keys, allow, now),
    repository,
    secretRepository,
    secrets,
  };
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: APP_RUN_CONTRACT_VERSIONS.run,
    org_id: ORG_ID,
    initiating_actor: { actor_type: 'human', user_id: USER_ID },
    execution_actor: { actor_type: 'human', user_id: USER_ID },
    origin: { origin_kind: 'legacy_connector', connection_id: PROVIDER_ID },
    operation: {
      provider: { org_id: ORG_ID, provider_kind: 'mcp', provider_instance_id: PROVIDER_ID },
      operation_name: 'send_email',
    },
    provider_snapshot_digest: digest,
    policy: {
      risk_class: 'external_write',
      review_requirement: 'always',
      review_scope: 'per_invocation',
      retry_class: 'unsafe_or_unknown',
    },
    retention_class: 'standard',
    idempotency_key: `retry-${suffix}`,
    input: { body: `raw-marker-${suffix}`, recipient: 'person@example.test' },
    authorization_snapshot: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      authenticated_subject: { actor_type: 'human', user_id: USER_ID },
      authority_refs: [
        { authority_kind: 'membership', authority_id: USER_ID, version: '1' },
        { authority_kind: 'connector', authority_id: PROVIDER_ID, version: '1' },
      ],
    },
    safe_preview: {
      schema_version: APP_RUN_CONTRACT_VERSIONS.run,
      title: 'Send one email',
      resource_refs: [],
    },
    ...overrides,
  };
}

const trusted = {
  org_id: ORG_ID,
  initiating_actor: { actor_type: 'human' as const, user_id: USER_ID },
  execution_actor: { actor_type: 'human' as const, user_id: USER_ID },
};

before(async () => {
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [ORG_ID, 'App Run Test', ORG_ID]);
  await client.query(
    `INSERT INTO capability_provider_snapshots
      (id, org_id, provider_kind, provider_instance_id, adapter_contract_version,
       snapshot_digest, safe_snapshot, captured_at)
     VALUES ($1, $2, 'mcp', $3, 'deft.capability.v1', $4, $5::jsonb, now())`,
    [SNAPSHOT_ID, ORG_ID, PROVIDER_ID, digest, JSON.stringify({ operation: 'send_email' })],
  );
});

after(async () => {
  if (client) {
    await client.query('DELETE FROM orgs WHERE id = $1', [ORG_ID]);
    await client.end();
  }
  for (const provider of providers) provider.destroy();
  await closeDb();
});

test('submission is atomic, rotation-safe, tenant-scoped, and replay-conflict aware', async () => {
  const { service: runs } = service();
  const parallel = await Promise.all(Array.from({ length: 20 }, () => runs.submit(trusted, submission())));
  assert.equal(new Set(parallel.map((run) => run.id)).size, 1);
  const runId = parallel[0]!.id;

  const counts = await client.query<{
    runs: string; inputs: string; created_events: string;
  }>(
    `SELECT
       (SELECT count(*) FROM app_runs WHERE org_id = $1 AND id = $2) AS runs,
       (SELECT count(*) FROM app_run_secret_payloads WHERE org_id = $1 AND run_id = $2 AND payload_kind = 'input') AS inputs,
       (SELECT count(*) FROM app_run_events WHERE org_id = $1 AND run_id = $2 AND event_type = 'run_created') AS created_events`,
    [ORG_ID, runId],
  );
  assert.deepEqual(counts.rows[0], { runs: '1', inputs: '1', created_events: '1' });

  await assert.rejects(
    runs.submit(trusted, submission({ input: { body: 'different', recipient: 'person@example.test' } })),
    (error: any) => error?.code === 'APP_RUN_IDEMPOTENCY_CONFLICT',
  );
  const residue = await client.query<{ row: string }>(
    `SELECT row_to_json(safe)::text AS row FROM (
       SELECT id, org_id, state, safe_preview, safe_outcome, idempotency_fingerprint, input_fingerprint
       FROM app_runs WHERE id = $1
     ) safe`,
    [runId],
  );
  assert.doesNotMatch(residue.rows[0]!.row, new RegExp(`raw-marker-${suffix}|retry-${suffix}`));

  const cancelled = await runs.cancel(ORG_ID, runId, trusted.initiating_actor);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await runs.cancel(ORG_ID, runId, trusted.initiating_actor)).state, 'cancelled');

  const oldKeys = service(() => new Date(), allowAll, { current: 'fp-old' });
  const rotationSubmission = submission({ idempotency_key: `rotation-${suffix}` });
  const beforeRotation = await oldKeys.service.submit(trusted, rotationSubmission);
  const rotated = service();
  assert.equal((await rotated.service.submit(trusted, rotationSubmission)).id, beforeRotation.id);
  const missingOld = service(() => new Date(), allowAll, { includeOld: false });
  await assert.rejects(
    missingOld.service.assertReferencedKeysAvailable(),
    (error: any) => error?.code === 'APP_RUN_KEY_VERSION_UNAVAILABLE',
  );
});

class CountingExecutor implements AppRunProviderExecutor {
  calls: AppRunProviderExecutionRequest[] = [];
  results: AppRunProviderExecutionResult[] = [];
  entered: (() => void) | null = null;
  wait: Promise<void> | null = null;

  async execute(request: AppRunProviderExecutionRequest): Promise<AppRunProviderExecutionResult> {
    this.calls.push(request);
    this.entered?.();
    if (this.wait) await this.wait;
    return this.results.shift() ?? { status: 'succeeded', output: { message_id: 'message-1' } };
  }
}

test('concurrent runners call once, commit the call boundary, and replay retained output with authorization', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `runner-${suffix}` }));
  const executor = new CountingExecutor();
  let release!: () => void;
  executor.wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { executor.entered = resolve; });
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor,
  );

  const firstExecution = runner.run(ORG_ID, created.id, 'worker-0');
  await entered;
  const competitors = Array.from({ length: 15 }, (_, index) =>
    runner.run(ORG_ID, created.id, `worker-${index + 1}`));
  await Promise.all(competitors);
  const boundary = await client.query<{ state: string; run_state: string }>(
    `SELECT a.state, r.state AS run_state
       FROM app_run_attempts a JOIN app_runs r ON r.org_id = a.org_id AND r.id = a.run_id
      WHERE a.org_id = $1 AND a.run_id = $2`,
    [ORG_ID, created.id],
  );
  assert.deepEqual(boundary.rows[0], { state: 'provider_call_started', run_state: 'running' });
  assert.equal(executor.calls.length, 1);
  const claim = await client.query<{ id: string; claim_token: string }>(
    'SELECT id, claim_token FROM app_run_attempts WHERE org_id = $1 AND run_id = $2',
    [ORG_ID, created.id],
  );
  assert.equal(await runner.renewLease(ORG_ID, claim.rows[0]!.id, randomUUID()), false);
  assert.equal(await runner.renewLease(ORG_ID, claim.rows[0]!.id, claim.rows[0]!.claim_token), true);
  const requested = await setup.service.cancel(ORG_ID, created.id, trusted.initiating_actor);
  assert.equal(requested.state, 'running');
  assert.ok(requested.cancel_requested_at);
  release();
  await firstExecution;

  const finished = await setup.service.inspect(ORG_ID, created.id, trusted.initiating_actor);
  assert.equal(finished.state, 'succeeded');
  assert.deepEqual((await setup.service.result(ORG_ID, created.id, trusted.initiating_actor)).value, {
    message_id: 'message-1',
  });
  const attemptCounts = await client.query<{ attempts: string; outputs: string }>(
    `SELECT
       (SELECT count(*) FROM app_run_attempts WHERE org_id = $1 AND run_id = $2) AS attempts,
       (SELECT count(*) FROM app_run_secret_payloads WHERE org_id = $1 AND run_id = $2 AND payload_kind = 'output') AS outputs`,
    [ORG_ID, created.id],
  );
  assert.deepEqual(attemptCounts.rows[0], { attempts: '1', outputs: '1' });

  const denied = service(() => new Date(), { async authorize() { return false; } });
  let touchedSecret = false;
  denied.secretRepository.readOutput = async () => {
    touchedSecret = true;
    throw new Error('secret read should not happen');
  };
  await assert.rejects(
    denied.service.result(ORG_ID, created.id, trusted.initiating_actor),
    (error: any) => error?.code === 'APP_RUN_ACCESS_DENIED',
  );
  assert.equal(touchedSecret, false);
});

test('unsafe indeterminate effects never retry while safe and idempotent effects use new attempts', async () => {
  const unsafeSetup = service();
  const unsafe = await unsafeSetup.service.submit(trusted, submission({ idempotency_key: `unsafe-${suffix}` }));
  const unsafeExecutor = new CountingExecutor();
  unsafeExecutor.results.push({ status: 'indeterminate' });
  const unsafeRunner = new AppRunAttemptRunner(
    unsafeSetup.repository, unsafeSetup.secretRepository, unsafeSetup.secrets, unsafeExecutor,
  );
  assert.equal((await unsafeRunner.run(ORG_ID, unsafe.id, 'unsafe-1')).state, 'unknown_outcome');
  await unsafeRunner.run(ORG_ID, unsafe.id, 'unsafe-2');
  assert.equal(unsafeExecutor.calls.length, 1);

  const idempotentSetup = service();
  const idempotent = await idempotentSetup.service.submit(trusted, submission({
    idempotency_key: `idempotent-${suffix}`,
    policy: {
      risk_class: 'external_write', review_requirement: 'always',
      review_scope: 'per_invocation', retry_class: 'idempotent_with_key',
    },
  }));
  const idempotentExecutor = new CountingExecutor();
  idempotentExecutor.results.push(
    { status: 'indeterminate' },
    { status: 'succeeded', output: { delivered: true } },
  );
  const idempotentRunner = new AppRunAttemptRunner(
    idempotentSetup.repository, idempotentSetup.secretRepository, idempotentSetup.secrets,
    idempotentExecutor,
  );
  assert.equal((await idempotentRunner.run(ORG_ID, idempotent.id, 'idempotent-1')).state, 'running');
  assert.equal((await idempotentRunner.run(ORG_ID, idempotent.id, 'idempotent-2')).state, 'succeeded');
  assert.equal(idempotentExecutor.calls.length, 2);
  assert.equal(idempotentExecutor.calls[0]!.provider_idempotency_key, idempotentExecutor.calls[1]!.provider_idempotency_key);
  const attempts = await client.query<{ attempt_number: number; retry_of_attempt_id: string | null }>(
    `SELECT attempt_number, retry_of_attempt_id FROM app_run_attempts
      WHERE org_id = $1 AND run_id = $2 ORDER BY attempt_number`,
    [ORG_ID, idempotent.id],
  );
  assert.equal(attempts.rows.length, 2);
  assert.equal(attempts.rows[0]!.retry_of_attempt_id, null);
  assert.ok(attempts.rows[1]!.retry_of_attempt_id);
});

test('retention purge is one-way, audited, and leaves only safe terminal residue', async () => {
  const past = new Date('2020-01-01T00:00:00.000Z');
  const setup = service(() => past);
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `expired-${suffix}` }));
  assert.equal(await setup.service.purgeExpiredSecrets(new Date('2021-01-01T00:00:00.000Z')), 1);
  const rows = await client.query<{ secrets: string; state: string; input_purged_at: Date | null; events: string }>(
    `SELECT
       (SELECT count(*) FROM app_run_secret_payloads WHERE org_id = $1 AND run_id = $2) AS secrets,
       r.state, r.input_purged_at,
       (SELECT count(*) FROM app_run_events WHERE org_id = $1 AND run_id = $2 AND event_type = 'secrets_purged') AS events
     FROM app_runs r WHERE r.org_id = $1 AND r.id = $2`,
    [ORG_ID, created.id],
  );
  assert.equal(rows.rows[0]!.secrets, '0');
  assert.equal(rows.rows[0]!.state, 'expired');
  assert.ok(rows.rows[0]!.input_purged_at);
  assert.equal(rows.rows[0]!.events, '1');
  assert.equal(await setup.service.purgeExpiredSecrets(new Date('2021-01-01T00:00:00.000Z')), 0);
});

test('a hard crash after the call boundary recovers unsafe work as unknown and fences the late result', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `hard-crash-${suffix}` }));
  const executor = new CountingExecutor();
  let release!: () => void;
  executor.wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { executor.entered = resolve; });
  let clock = new Date();
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor, () => clock, 1_000,
  );
  const inFlight = runner.run(ORG_ID, created.id, 'crash-worker');
  await entered;
  clock = new Date(clock.getTime() + 2_000);
  assert.equal(await runner.recoverRun(ORG_ID, created.id), 1);
  assert.equal((await setup.repository.inspect(ORG_ID, created.id))?.state, 'unknown_outcome');
  release();
  await inFlight;
  assert.equal((await setup.repository.inspect(ORG_ID, created.id))?.state, 'unknown_outcome');
  assert.equal(executor.calls.length, 1);
});

test('a durable known result survives finalization failure and repair never recalls the provider', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `repair-${suffix}` }));
  const executor = new CountingExecutor();
  const originalTransition = setup.repository.transition.bind(setup.repository);
  let failFinalization = true;
  setup.repository.transition = async (tx, input) => {
    if (failFinalization && input.state === 'succeeded') {
      failFinalization = false;
      throw new Error('injected finalization failure');
    }
    return originalTransition(tx, input);
  };
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor,
  );
  await assert.rejects(runner.run(ORG_ID, created.id, 'repair-worker'), /injected finalization failure/);
  assert.equal(executor.calls.length, 1);
  const marker = await client.query<{ state: string; provider_call_finished_at: Date | null }>(
    'SELECT state, provider_call_finished_at FROM app_run_attempts WHERE org_id = $1 AND run_id = $2',
    [ORG_ID, created.id],
  );
  assert.equal(marker.rows[0]!.state, 'provider_call_started');
  assert.ok(marker.rows[0]!.provider_call_finished_at);

  setup.repository.transition = originalTransition;
  const repairExecutor: AppRunProviderExecutor = {
    async execute() { throw new Error('provider must not be recalled'); },
  };
  const future = new Date(Date.now() + 2 * 60_000);
  const repairRunner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, repairExecutor, () => future,
  );
  assert.equal(await repairRunner.recoverRun(ORG_ID, created.id), 1);
  assert.equal((await setup.repository.inspect(ORG_ID, created.id))?.state, 'succeeded');
  assert.equal(executor.calls.length, 1);
});

test('oversized post-effect output remains known success without exact result or a second call', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `oversized-${suffix}` }));
  const executor = new CountingExecutor();
  executor.results.push({ status: 'succeeded', output: { value: 'x'.repeat(1024 * 1024 + 1) } });
  const runner = new AppRunAttemptRunner(
    setup.repository, setup.secretRepository, setup.secrets, executor,
  );
  const finished = await runner.run(ORG_ID, created.id, 'oversized-worker');
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.safe_outcome?.result_status, 'unavailable');
  await runner.run(ORG_ID, created.id, 'oversized-worker-2');
  assert.equal(executor.calls.length, 1);
  await assert.rejects(
    setup.service.result(ORG_ID, created.id, trusted.initiating_actor),
    (error: any) => error?.code === 'APP_RUN_RESULT_EXPIRED',
  );
});

test('database fencing rejects a second active attempt and mutable ownership', async () => {
  const setup = service();
  const created = await setup.service.submit(trusted, submission({ idempotency_key: `fencing-${suffix}` }));
  const attemptId = randomUUID();
  await client.query(
    `INSERT INTO app_run_attempts
      (id, org_id, run_id, attempt_number, state)
     VALUES ($1, $2, $3, 1, 'pending')`,
    [attemptId, ORG_ID, created.id],
  );
  await assert.rejects(
    client.query(
      `UPDATE app_run_attempts SET claim_owner = 'owner-0', claim_token = $1,
         claimed_at = now(), lease_expires_at = now() + interval '1 minute'
       WHERE id = $2`,
      [randomUUID(), attemptId],
    ),
    /APP_RUN_ILLEGAL_TRANSITION/,
  );
  await client.query(
    `UPDATE app_run_attempts SET state = 'claimed', claim_owner = 'owner-1',
       claim_token = $1, claimed_at = now(), lease_expires_at = now() + interval '1 minute'
     WHERE id = $2`,
    [randomUUID(), attemptId],
  );
  await assert.rejects(
    client.query('UPDATE app_run_attempts SET claim_owner = $1 WHERE id = $2', ['owner-2', attemptId]),
    /APP_RUN_IMMUTABLE_FIELD/,
  );
  await assert.rejects(
    client.query(
      `INSERT INTO app_run_attempts
        (id, org_id, run_id, attempt_number, retry_of_attempt_id, state)
       VALUES ($1, $2, $3, 2, $4, 'pending')`,
      [randomUUID(), ORG_ID, created.id, attemptId],
    ),
    /app_run_attempts_one_active_unique/,
  );
});

test('the worker adapter accepts ID-only jobs and remains dependency injected', async () => {
  const calls: unknown[] = [];
  const runner = {
    async run(orgId: string, runId: string, workerId: string, signal?: AbortSignal) {
      calls.push({ orgId, runId, workerId, signal });
      return {} as never;
    },
  } as AppRunAttemptRunner;
  const handler = createAppRunAttemptJobHandler(runner);
  const signal = new AbortController().signal;
  await handler({ id: 'job-1', name: 'app-run-attempt', data: { orgId: ORG_ID, runId: 'run-1' }, attempts: 1, signal });
  assert.deepEqual(calls, [{ orgId: ORG_ID, runId: 'run-1', workerId: 'job:job-1', signal }]);
  await assert.rejects(
    handler({ id: 'job-2', name: 'app-run-attempt', data: { orgId: ORG_ID, runId: 'run-1', input: 'secret' }, attempts: 1 }),
  );
});
