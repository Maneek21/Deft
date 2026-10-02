import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { z } from 'zod';

const databaseUrl = process.env.DATABASE_URL;
const allowed = /^gate_g_20260926_restore_(?:source|target(?:_[a-z0-9]{1,16})?)$/;
if (!process.send || databaseUrl !== process.env.DEFT_TEST_DATABASE_URL || !databaseUrl
  || new URL(databaseUrl).hostname !== '127.0.0.1' || new URL(databaseUrl).port !== '55435'
  || !allowed.test(new URL(databaseUrl).pathname.slice(1))
  || !process.env.DEFT_SYNC_RESTORE_CONFIG) throw new Error('Dedicated restore child profile required');

const config = z.strictObject({ schema_version: z.literal('deft.synthetic_restore_config.v1'),
  keyring: z.string(), flags: z.strictObject({ DEFT_APPS_ENABLED: z.literal('true'),
    DEFT_APP_RUNS_ENABLED: z.literal('true'), DEFT_APP_RUN_APP_ORIGIN_ENABLED: z.literal('true'),
    DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: z.literal('true') }) })
  .parse(JSON.parse(await readFile(process.env.DEFT_SYNC_RESTORE_CONFIG, 'utf8')));
Object.assign(process.env, config.flags, { DEFT_APP_RUN_KEYRINGS: config.keyring });

type Command = { action: 'bootstrap' | 'next' | 'verify' | 'replay' | 'recover' | 'revoke';
  state_path: string; ledger_path: string; pause?: 'after_commit' | 'after_observation'; revision?: number };
type Saved = {
  org_id: string; owner_user_id: string; operator_user_id: string; binding_id: string;
  checkpoint_id: string; foreign_org_id: string; foreign_user_id: string;
  projection_id?: string; ref?: unknown; settled_runs: string[];
  latest?: { run_id: string; attempt_id: string; lease_expires_at: string;
    starting_sequence: number; result: Record<string, unknown>; admitted_at: string };
};
async function durableWrite(path: string, value: unknown, append = false) {
  const file = await open(path, append ? 'a' : 'w');
  try { await file.write(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
}
async function emit(value: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => process.send!(value, (error: Error | null) => error ? reject(error) : resolve()));
}
async function pause() { await new Promise<never>(() => { setInterval(() => {}, 1_000); }); }

process.once('message', (raw: Command) => {
  void run(raw).then(async () => { await emit({ phase: 'done' }); process.exit(0); }, async (error) => {
    await emit({ phase: 'error', code: error?.code, message: error?.message ?? String(error),
      cause: error?.cause?.message }); process.exit(1);
  });
});

async function run(command: Command) {
  const [{ db, closeDb }, schema, { and, eq }, runtimeModule, readerModule, fixture,
    managementModule, modules] = await Promise.all([
    import('../../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../../src/lib/app-run-runtime.js'), import('../../src/lib/app-resource-private-read.js'),
    import('./resource-sync-v5.js'), import('../../src/lib/app-resource-sync-management.js'),
    import('../../src/lib/module-service.js'),
  ]);
  try {
    const runtime = await runtimeModule.getAppRunRuntime();
    const reader = new readerModule.AppResourcePrivateReadService(runtime.keys);
    let state: Saved;
    if (command.action === 'bootstrap') {
      const owned = await fixture.createReviewedResourceSyncFixture({ keys: runtime.keys, clock: () => new Date() });
      const foreignOrg = randomUUID();
      const foreignUser = randomUUID();
      await db.insert(schema.orgs).values({ id: foreignOrg, name: 'Restore foreign workspace', slug: `restore-${randomUUID()}` });
      await db.insert(schema.users).values({ id: foreignUser, name: 'Restore foreign owner', email: `${foreignUser}@example.test` });
      await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: foreignOrg,
        user_id: foreignUser, role: 'owner', is_active: true });
      state = { org_id: owned.org_id, owner_user_id: owned.owner_user_id,
        operator_user_id: owned.operator_user_id, binding_id: owned.binding_id,
        checkpoint_id: owned.checkpoint_id, foreign_org_id: foreignOrg, foreign_user_id: foreignUser,
        settled_runs: [] };
    } else { state = JSON.parse(await readFile(command.state_path, 'utf8')); }
    const subject = { kind: 'human' as const, org_id: state.org_id, user_id: state.owner_user_id };
    const target = { resource_binding_id: state.binding_id };
    const denied = (error: unknown) => (error as { code?: string }).code === 'APP_RESOURCE_PRIVATE_UNAVAILABLE';
    const verify = async () => {
      const page = await reader.listOwnerPrivateResourcePage(subject, target);
      assert.equal(page.items.length, 1);
      if (state.projection_id) assert.equal(page.items[0]!.projection_id, state.projection_id);
      if (state.ref) assert.deepEqual(page.items[0]!.ref, state.ref);
      const one = await reader.getOwnerPrivateResource(subject, { ...target, projection_id: page.items[0]!.projection_id });
      assert.deepEqual(one.item, page.items[0]);
      await assert.rejects(reader.listOwnerPrivateResourcePage({ ...subject,
        user_id: state.operator_user_id }, target), denied);
      await assert.rejects(reader.getOwnerPrivateResource({ kind: 'human', org_id: state.foreign_org_id,
        user_id: state.foreign_user_id }, { ...target, projection_id: page.items[0]!.projection_id }), denied);
      let terminalReceipts = 0;
      for (const runId of state.settled_runs) {
        const receipts = await runtime.receiptReader.readVerified(state.org_id, runId);
        assert.ok(receipts.some((receipt) => receipt.verified && receipt.receipt_kind === 'attempt_terminal'));
        terminalReceipts += receipts.filter((receipt) => receipt.verified && receipt.receipt_kind === 'attempt_terminal').length;
      }
      return { cursor_sequence: page.checkpoint.cursor_sequence, projection_id: page.items[0]!.projection_id,
        ref: page.items[0]!.ref, revision: page.items[0]!.revision, terminal_receipts: terminalReceipts,
        owner_read: true, foreign_denied: true, nonowner_denied: true };
    };
    if (command.action === 'verify') { await emit({ phase: 'verified', ...await verify() }); return; }
    if (command.action === 'replay') {
      assert.ok(state.latest);
      assert.ok(await runtime.resourceSyncChannel.complete(state.latest.result));
      await emit({ phase: 'replayed', ...await verify() }); return;
    }
    if (command.action === 'recover') {
      assert.ok(state.latest);
      assert.equal(await runtime.attemptRunner.recoverRun(state.org_id, state.latest.run_id, state.latest.attempt_id), 1);
      assert.equal(await runtime.attemptRunner.recoverRun(state.org_id, state.latest.run_id, state.latest.attempt_id), 0);
      const [run] = await db.select().from(schema.appRuns).where(and(eq(schema.appRuns.org_id, state.org_id),
        eq(schema.appRuns.id, state.latest.run_id)));
      assert.equal(run?.state, 'unknown_outcome');
      const attempts = await db.select().from(schema.appRunAttempts).where(and(
        eq(schema.appRunAttempts.org_id, state.org_id), eq(schema.appRunAttempts.run_id, state.latest.run_id)));
      assert.equal(attempts.length, 1);
      const [checkpoint] = await db.select().from(schema.appSyncCheckpoints)
        .where(eq(schema.appSyncCheckpoints.id, state.checkpoint_id));
      assert.equal(checkpoint?.cursor_sequence, state.latest.starting_sequence);
      assert.equal(checkpoint?.generation, 1);
      assert.equal(await runtime.secretRepository.readOutput(state.org_id, state.latest.run_id, state.latest.attempt_id), null);
      for (let i = 0; i < 2; i += 1) assert.deepEqual(await runtime.resourceSyncAdmission.admitDue({
        org_id: state.org_id, resource_binding_id: state.binding_id }),
      { state: 'blocked', reason: 'cursor_requires_recovery' });
      assert.equal(await runtime.resourceSyncChannel.complete(state.latest.result), null);
      const receipts = await runtime.receiptReader.readVerified(state.org_id, state.latest.run_id);
      assert.ok(receipts.some((receipt) => receipt.verified && receipt.receipt_kind === 'attempt_terminal'));
      await emit({ phase: 'recovered', ...await verify(), state: run?.state, attempts: attempts.length,
        admission_blocked: true, late_result_denied: true, retained_generation: checkpoint?.generation });
      return;
    }
    if (command.action === 'revoke') {
      const manager = new managementModule.AppResourceSyncManagement(runtime.keys);
      await manager.revokeConsent(modules.humanModuleActor({ orgId: state.org_id,
        userId: state.owner_user_id, role: 'owner', source: 'rest' }), state.binding_id);
      await assert.rejects(reader.listOwnerPrivateResourcePage(subject, target), denied);
      await emit({ phase: 'revoked', read_denied: true }); return;
    }
    const admissions = await Promise.all([runtime.resourceSyncAdmission.admitDue({ org_id: state.org_id,
      resource_binding_id: state.binding_id }), runtime.resourceSyncAdmission.admitDue({ org_id: state.org_id,
      resource_binding_id: state.binding_id })]);
    assert.deepEqual(admissions.map((item) => item.state).sort(), ['created', 'existing']);
    const created = admissions.find((item) => item.state === 'created');
    assert.ok(created && created.state === 'created');
    assert.ok(admissions.every((item) => 'run_id' in item && item.run_id === created.run_id));
    const manager = new managementModule.AppResourceSyncManagement(runtime.keys);
    const issued = await manager.issueOperatorSession(modules.humanModuleActor({ orgId: state.org_id,
      userId: state.operator_user_id, role: 'member', source: 'rest' }), state.binding_id);
    const base = { schema_version: 'deft.app_runtime_channel.v2' as const, audience: 'app_resource_sync' as const,
      session_id: issued.session_id, session_token: issued.session_token };
    const claim = await runtime.resourceSyncChannel.claim({ ...base, max_claims: 1 });
    assert.ok(claim);
    assert.equal(claim.run_id, created.run_id);
    const attempt = { ...base, run_id: claim.run_id, attempt_id: claim.attempt_id,
      claim_token: claim.claim_token, sequence: claim.sequence };
    const started = await runtime.resourceSyncChannel.start(attempt);
    assert.ok(started);
    assert.equal(await runtime.resourceSyncChannel.start(attempt), null);
    const [checkpoint] = await db.select().from(schema.appSyncCheckpoints)
      .where(eq(schema.appSyncCheckpoints.id, state.checkpoint_id));
    assert.ok(checkpoint);
    const [run] = await db.select().from(schema.appRuns).where(eq(schema.appRuns.id, created.run_id));
    assert.ok(run);
    const revision = command.revision ?? 1;
    const result = { ...attempt, status: 'returned', provider_succeeded: true,
      page: { schema_version: 'deft.app_sync_page.v1', upserts: [{ id: 'restore-provider-record',
        revision: `revision-${revision}`, data: { subject: `Synthetic restored record ${revision}` } }],
      tombstones: [], next_cursor: `restore-cursor-${revision}`, has_more: false } };
    state.latest = { run_id: created.run_id, attempt_id: created.attempt_id,
      lease_expires_at: claim.lease_expires_at, starting_sequence: checkpoint.cursor_sequence,
      result, admitted_at: run.created_at.toISOString() };
    await durableWrite(command.ledger_path, { observation: 'synthetic_source_read', run_id: claim.run_id,
      attempt_id: claim.attempt_id, process_id: process.pid, input_cursor: started.input.cursor }, true);
    await durableWrite(command.state_path, state);
    if (command.pause === 'after_observation') {
      await emit({ phase: 'observed', run_id: claim.run_id, attempt_id: claim.attempt_id,
        lease_expires_at: claim.lease_expires_at, cursor_sequence: checkpoint.cursor_sequence, process_id: process.pid });
      await pause();
    }
    assert.ok(await runtime.resourceSyncChannel.complete(result));
    const page = await reader.listOwnerPrivateResourcePage(subject, target);
    assert.equal(page.items.length, 1);
    if (state.projection_id) assert.equal(page.items[0]!.projection_id, state.projection_id);
    state.projection_id = page.items[0]!.projection_id;
    state.ref = page.items[0]!.ref;
    state.settled_runs.push(created.run_id);
    await durableWrite(command.state_path, state);
    await emit({ phase: 'settled', ...await verify(), run_id: created.run_id,
      admitted_at: run.created_at.toISOString(), process_id: process.pid });
    if (command.pause === 'after_commit') await pause();
  } finally {
    await runtimeModule.shutdownAppRunRuntime();
    await closeDb();
  }
}
