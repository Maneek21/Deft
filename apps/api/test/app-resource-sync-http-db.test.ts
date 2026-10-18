import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import * as ts from 'typescript';
import type {
  ResourceSyncClaim, ResourceSyncStart, SyncPageV1,
} from '@deft/app-kit/experimental/resource-sync';

const target = process.env.DEFT_TEST_DATABASE_URL;
const assigned = target && target === process.env.DATABASE_URL
  && new URL(target).hostname === '127.0.0.1'
  && new URL(target).port === '55435'
  && new URL(target).pathname === '/gate_g_phase5_test_s05_sync_http';

type ChildEvent = Record<string, unknown> & { type: string };

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const packageRoot = resolve(repositoryRoot, 'packages', 'app-kit');
const fixtureSource = fileURLToPath(new URL('./fixtures/app-resource-sync-provider-child.ts',
  import.meta.url));

function runPnpm(args: string[]) {
  const invokedThroughPnpm = process.env.npm_execpath;
  const completed = spawnSync(invokedThroughPnpm ? process.execPath : 'pnpm',
    invokedThroughPnpm ? [invokedThroughPnpm, ...args] : args, {
    cwd: repositoryRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true,
    shell: !invokedThroughPnpm && process.platform === 'win32',
  });
  assert.equal(completed.status, 0,
    [completed.error?.message, completed.stdout, completed.stderr].filter(Boolean).join('\n'));
}

async function packedProviderChild(root: string) {
  const artifacts = resolve(root, 'artifacts');
  const consumer = resolve(root, 'consumer');
  await mkdir(artifacts, { recursive: true });
  await mkdir(consumer, { recursive: true });
  runPnpm(['--dir', packageRoot, 'pack', '--pack-destination', artifacts, '--json']);
  const archives = (await readdir(artifacts)).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  const tarball = resolve(artifacts, archives[0]!);
  await writeFile(resolve(consumer, 'package.json'), JSON.stringify({
    name: 'deft-sync-http-external-consumer', version: '1.0.0', private: true,
    type: 'module', dependencies: { '@deft/app-kit': `file:${tarball.replace(/\\/gu, '/')}` },
  }), 'utf8');
  runPnpm(['--dir', consumer, 'install', '--ignore-workspace', '--offline']);
  const installed = await realpath(resolve(consumer, 'node_modules', '@deft', 'app-kit'));
  assert.ok(installed.startsWith(await realpath(consumer)));
  const compiled = ts.transpileModule(await readFile(fixtureSource, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const script = resolve(consumer, 'provider-child.mjs');
  await writeFile(script, compiled, 'utf8');
  return { script, consumer, tarball };
}

function providerChild(kit: Readonly<{ script: string; consumer: string }>) {
  const child = fork(kit.script, [], {
    cwd: kit.consumer, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    env: { ...process.env, DEFT_RESOURCE_SYNC_PROVIDER_FIXTURE: 'true' },
  });
  const events: ChildEvent[] = [];
  child.on('message', (value: unknown) => {
    if (value && typeof value === 'object' && 'type' in value
      && typeof value.type === 'string') events.push(value as ChildEvent);
  });
  const wait = async (type: string): Promise<ChildEvent> => {
    const failed = events.find((event) => event.type === 'error');
    if (failed) throw new Error(`Provider child failed: ${String(failed.code)}`);
    const found = events.find((event) => event.type === type);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup(); reject(new Error(`Provider child timed out waiting for ${type}`));
      }, 20_000);
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== 'object' || !('type' in value)) return;
        if (value.type === 'error') {
          cleanup(); reject(new Error(`Provider child failed: ${String((value as ChildEvent).code)}`));
        } else if (value.type === type) { cleanup(); resolve(value as ChildEvent); }
      };
      const onExit = (code: number | null) => {
        cleanup(); reject(new Error(`Provider child exited ${code} before ${type}`));
      };
      function cleanup() {
        clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit);
      }
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
  };
  return { child, events, wait };
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('v2 SDK over HTTP commits one private page and survives provider crash/replay',
  { skip: !assigned, timeout: 300_000 }, async () => {
    process.env.DEFT_APPS_ENABLED = 'true';
    process.env.DEFT_APP_RUNS_ENABLED = 'true';
    process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
    process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
    const material = (purpose: string) => createHash('sha256')
      .update(`sync-http:${purpose}`).digest('base64');
    process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
      schema_version: 'deft.app_run_keyring.v1',
      run_encryption: { current: 'enc-v1', keys: { 'enc-v1': material('enc') } },
      receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': material('sig') } },
      fingerprint: { current: 'fp-v1', keys: { 'fp-v1': material('fp') } },
    });
    const [{ db, closeDb }, schema, keyringModule, serverModule, drizzle] = await Promise.all([
      import('../src/lib/db.js'), import('@deft/db/schema'),
      import('../src/lib/app-run-keyrings.js'), import('@hono/node-server'),
      import('drizzle-orm'),
    ]);
    const ring = { keys: keyringModule.parseEnvironmentAppRunKeyrings(
      process.env.DEFT_APP_RUN_KEYRINGS) };
    const [{ app }, runtimeModule, fixture] =
      await Promise.all([
        import('../src/index.js'), import('../src/lib/app-run-runtime.js'),
        import('./fixtures/resource-sync-v5.js'),
      ]);
    const children: ChildProcess[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'deft-resource-sync-http-'));
    assert.ok(dir.startsWith(tmpdir()));
    let server: ReturnType<typeof serverModule.serve> | undefined;
    try {
      const packed = await packedProviderChild(dir);
      const port = await new Promise<number>((resolve) => {
        server = serverModule.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
          (info) => resolve(info.port));
      });
      const base = `http://127.0.0.1:${port}`;
      const runtime = await runtimeModule.getAppRunRuntime();
      const admission = runtime.resourceSyncAdmission;
      const page: SyncPageV1 = { schema_version: 'deft.app_sync_page.v1',
        upserts: [{ id: 'synthetic-record-1', revision: 'rev-1',
          data: { subject: 'synthetic private title' } }],
        tombstones: [], next_cursor: 'synthetic-cursor-1', has_more: false };
      const sourcePath = join(dir, 'source-page.json');
      const ledgerPath = join(dir, 'source-observations.jsonl');
      await writeFile(sourcePath, JSON.stringify(page), 'utf8');

      const reviewed = await fixture.createReviewedResourceSyncFixture({
        keys: ring.keys, clock: () => new Date() });
      const admitted = await admission.admitDue({ org_id: reviewed.org_id,
        resource_binding_id: reviewed.binding_id });
      assert.equal(admitted.state, 'created');
      if (admitted.state !== 'created') return;
      const session = await reviewed.management.issueOperatorSession(
        reviewed.operator_actor, reviewed.binding_id);
      const credential = { session_id: session.session_id,
        session_token: session.session_token };
      const first = providerChild(packed);
      children.push(first.child);
      first.child.send({ type: 'start', channel_url: `${base}/api/app-resource-sync/channel`,
        credential, source_path: sourcePath, ledger_path: ledgerPath, mode: 'normal' });
      const observed = await first.wait('observed');
      assert.equal(observed.run_id, admitted.run_id);
      assert.equal((await first.wait('result')).run_id, admitted.run_id);
      await stopChild(first.child);
      const claim = observed.claim as ResourceSyncClaim;
      const started = observed.started as ResourceSyncStart;
      const observedPage = observed.page as SyncPageV1;
      assert.deepEqual(observedPage, page);
      const ledger = (await readFile(ledgerPath, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { run_id: string; observation: string });
      assert.deepEqual(ledger, [{ run_id: admitted.run_id,
        attempt_id: admitted.attempt_id, observation: 'synthetic_source_page_read' }]);
      const [checkpoint] = await db.select().from(schema.appSyncCheckpoints)
        .where(drizzle.eq(schema.appSyncCheckpoints.id, reviewed.checkpoint_id));
      const projections = await db.select().from(schema.appResourceProjections)
        .where(drizzle.eq(schema.appResourceProjections.checkpoint_id,
          reviewed.checkpoint_id));
      assert.equal(checkpoint?.cursor_sequence, 1);
      assert.equal(checkpoint?.cursor_state, 'value');
      assert.ok(checkpoint?.cursor_ciphertext_b64);
      assert.equal(projections.length, 1);
      assert.ok(projections[0]?.body_ciphertext_b64);
      assert.equal(JSON.stringify({ checkpoint, projections }).includes('synthetic private title'), false);
      assert.equal(JSON.stringify({ checkpoint, projections }).includes('synthetic-cursor-1'), false);
      const output = await runtime.secretRepository.readOutput(reviewed.org_id,
        admitted.run_id, admitted.attempt_id);
      assert.deepEqual(output, { schema_version: 'deft.app_run_provider_result.v1',
        provider_succeeded: true, output: page });
      const verified = await runtime.receiptReader.readVerified(reviewed.org_id, admitted.run_id);
      assert.ok(verified.some((row) => row.receipt_kind === 'attempt_terminal' && row.verified));
      const [terminal] = await db.select().from(schema.appRuns)
        .where(drizzle.eq(schema.appRuns.id, admitted.run_id));
      assert.equal(terminal?.state, 'succeeded');

      const replay = providerChild(packed);
      children.push(replay.child);
      replay.child.send({ type: 'replay', channel_url: `${base}/api/app-resource-sync/channel`,
        credential, claim, started, page: observedPage });
      assert.equal((await replay.wait('replayed')).run_id, admitted.run_id);
      await stopChild(replay.child);
      const [afterReplay] = await db.select().from(schema.appSyncCheckpoints)
        .where(drizzle.eq(schema.appSyncCheckpoints.id, reviewed.checkpoint_id));
      assert.equal(afterReplay?.cursor_sequence, 1);
      assert.equal((await db.select().from(schema.appResourceProjections)
        .where(drizzle.eq(schema.appResourceProjections.checkpoint_id,
          reviewed.checkpoint_id))).length, 1);
      assert.equal((await readFile(ledgerPath, 'utf8')).trim().split('\n').length, 1);

      const crashed = await fixture.createReviewedResourceSyncFixture({
        keys: ring.keys, clock: () => new Date() });
      const crashAdmission = await admission.admitDue({ org_id: crashed.org_id,
        resource_binding_id: crashed.binding_id });
      assert.equal(crashAdmission.state, 'created');
      if (crashAdmission.state !== 'created') return;
      const crashSession = await crashed.management.issueOperatorSession(
        crashed.operator_actor, crashed.binding_id);
      const crashCredential = { session_id: crashSession.session_id,
        session_token: crashSession.session_token };
      const killed = providerChild(packed);
      children.push(killed.child);
      killed.child.send({ type: 'start', channel_url: `${base}/api/app-resource-sync/channel`,
        credential: crashCredential, source_path: sourcePath,
        ledger_path: ledgerPath, mode: 'pause_after_observe' });
      assert.equal((await killed.wait('observed')).run_id, crashAdmission.run_id);
      await stopChild(killed.child);
      const [crashAttempt] = await db.select().from(schema.appRunAttempts)
        .where(drizzle.eq(schema.appRunAttempts.id, crashAdmission.attempt_id));
      assert.ok(crashAttempt?.lease_expires_at);
      const leaseWait = crashAttempt.lease_expires_at.getTime() - Date.now() + 250;
      assert.ok(leaseWait > 0 && leaseWait <= 65_000);
      await sleep(leaseWait);
      assert.equal(await runtime.attemptRunner.recoverRun(crashed.org_id,
        crashAdmission.run_id, crashAdmission.attempt_id), 1);
      const [unknown] = await db.select().from(schema.appRuns)
        .where(drizzle.eq(schema.appRuns.id, crashAdmission.run_id));
      assert.equal(unknown?.state, 'unknown_outcome');
      assert.equal((await db.select().from(schema.appResourceProjections)
        .where(drizzle.eq(schema.appResourceProjections.checkpoint_id,
          crashed.checkpoint_id))).length, 0);
      const [crashCheckpoint] = await db.select().from(schema.appSyncCheckpoints)
        .where(drizzle.eq(schema.appSyncCheckpoints.id, crashed.checkpoint_id));
      assert.equal(crashCheckpoint?.cursor_sequence, 0);
      assert.equal(await runtime.secretRepository.readOutput(crashed.org_id,
        crashAdmission.run_id, crashAdmission.attempt_id), null);
      assert.equal((await db.select().from(schema.appRunAttempts)
        .where(drizzle.eq(schema.appRunAttempts.run_id, crashAdmission.run_id))).length, 1,
      'an observed but unacknowledged source read must not auto-retry');
      assert.deepEqual(await admission.admitDue({ org_id: crashed.org_id,
        resource_binding_id: crashed.binding_id }),
      { state: 'blocked', reason: 'cursor_requires_recovery' });
      assert.ok((await runtime.receiptReader.readVerified(crashed.org_id,
        crashAdmission.run_id)).some((row) => row.receipt_kind === 'attempt_terminal'
          && row.verified));

      // A v2 token cannot be presented to the enabled v1 action channel.
      const v1 = await fetch(`${base}/api/app-runtime/channel/claim`, { method: 'POST',
        headers: { authorization: `AppRuntime ${session.session_token}`,
          'content-type': 'application/json' },
        body: JSON.stringify({ schema_version: 'deft.app_runtime_channel.v1',
          session_id: session.session_id, max_claims: 1 }) });
      assert.equal(v1.status, 200);
      assert.deepEqual(await v1.json(), { claim: null });

      const revoked = await fixture.createReviewedResourceSyncFixture({
        keys: ring.keys, clock: () => new Date() });
      const revokeAdmission = await admission.admitDue({ org_id: revoked.org_id,
        resource_binding_id: revoked.binding_id });
      assert.equal(revokeAdmission.state, 'created');
      const revokeSession = await revoked.management.issueOperatorSession(
        revoked.operator_actor, revoked.binding_id);
      await revoked.management.revokeConsent(revoked.owner_actor, revoked.binding_id);
      const claimBody = { schema_version: 'deft.app_runtime_channel.v2',
        audience: 'app_resource_sync', session_id: revokeSession.session_id, max_claims: 1 };
      const denied = await fetch(`${base}/api/app-resource-sync/channel/claim`, {
        method: 'POST', headers: { authorization: `AppRuntime ${revokeSession.session_token}`,
          'content-type': 'application/json' }, body: JSON.stringify(claimBody) });
      assert.equal(denied.status, 200);
      assert.equal((await denied.json() as { claim: unknown }).claim, null);

      const sourceObservations = (await readFile(ledgerPath, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as {
          run_id: string; attempt_id: string; observation: string;
        });
      assert.equal(sourceObservations.length, 2);
      assert.equal(sourceObservations[1]?.run_id, crashAdmission.run_id);
      const evidenceDir = process.env.DEFT_SYNC_HTTP_EVIDENCE_DIR;
      if (evidenceDir) {
        const resolved = resolve(evidenceDir);
        const fromRepo = relative(repositoryRoot, resolved);
        assert.ok(fromRepo.startsWith('..') || isAbsolute(fromRepo),
          'Evidence must be outside the repository');
        await mkdir(resolved, { recursive: true });
        await writeFile(resolve(resolved, 'checkpoint06-v2-http-evidence.json'),
          JSON.stringify({ schema_version: 'deft.gate_g.sync_http_evidence.v1',
            packed_tarball_sha256: createHash('sha256')
              .update(await readFile(packed.tarball)).digest('hex'),
            source_observations: sourceObservations,
            happy: { state: terminal?.state, cursor_sequence: afterReplay?.cursor_sequence,
              projection_count: projections.length, replayed: true,
              signed_terminal_receipt: true },
            crash: { state: unknown?.state, cursor_sequence: crashCheckpoint?.cursor_sequence,
              projection_count: 0, attempts: 1, admission_blocked: true },
            cross_audience_denied: true, revoked_consent_denied: true,
          }, null, 2), 'utf8');
      }
    } finally {
      await Promise.allSettled(children.map(stopChild));
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await runtimeModule.shutdownAppRunRuntime();
      ring.keys.destroy();
      await closeDb();
      await rm(dir, { recursive: true, force: true });
    }
  });
