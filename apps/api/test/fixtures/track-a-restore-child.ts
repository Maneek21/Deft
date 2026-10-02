import { mcpClientManager } from '@deft/mcp';
import { appRuns } from '@deft/db/schema';
import { and, eq } from 'drizzle-orm';

type Command = Readonly<{
  action: 'scan' | 'fire' | 'attempt' | 'recover' | 'verify' | 'cleanup';
  org_id: string;
  definition_id: string;
  connection_id: string;
  now?: string;
  run_id?: string;
  pause_before_dispatch?: boolean;
  pause_after_receipt?: boolean;
}>;

function send(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) { reject(new Error('Track A child requires IPC')); return; }
    process.send(value, (error) => error ? reject(error) : resolve());
  });
}

async function waitForContinue(): Promise<void> {
  await new Promise<void>((resolve) => process.once('message', (value) => {
    if ((value as { action?: string }).action === 'continue') resolve();
  }));
}

async function run(command: Command): Promise<void> {
  const [{ runAppAutomationScan, runAppAutomationFire }, queues,
    { handleAppRunAttempt }, { getAppRunRuntime }, { db }] = await Promise.all([
    import('../../src/lib/app-automation-runtime.js'),
    import('../../src/lib/queues.js'),
    import('../../src/lib/app-run-worker-handler.js'),
    import('../../src/lib/app-run-runtime.js'),
    import('../../src/lib/db.js'),
  ]);
  if (command.action === 'scan') {
    await runAppAutomationScan(new Date(command.now!));
    await send({ phase: 'done' });
    return;
  }
  if (command.action === 'cleanup') {
    await send({ phase: 'done', recovered_jobs: await queues.cleanupStaleJobs() });
    return;
  }
  if (command.action === 'fire') {
    const job = await queues.dequeueJob(queues.QUEUE_NAMES.SCHEDULED_JOBS, {
      lockedBy: 'track-a-restore-fire', orgId: command.org_id,
      jobName: 'app-automation-fire', leaseMs: command.pause_before_dispatch ? 1_000 : 60_000,
      dataMatch: { key: 'definition_id', value: command.definition_id },
    });
    if (!job) throw new Error('No due automation fire job');
    await send({ phase: 'fire_claimed', job_id: job.id, fire_id: job.data.fire_id });
    if (command.pause_before_dispatch) await waitForContinue();
    await runAppAutomationFire({ id: job.id, name: job.name, data: job.data,
      attempts: job.attempts, leaseExpiresAt: job.lockExpiresAt },
    new Date(command.now!));
    await queues.completeJob(job.id, job.lockToken);
    await send({ phase: 'done', fire_id: job.data.fire_id });
    return;
  }
  if (command.action === 'attempt') {
    const job = await queues.dequeueJob(queues.QUEUE_NAMES.AGENT_JOBS, {
      lockedBy: 'track-a-restore-attempt', orgId: command.org_id,
      jobName: 'app-run-attempt', leaseMs: command.pause_after_receipt ? 10_000 : 60_000,
      dataMatch: { key: 'runId', value: command.run_id! },
    });
    if (!job) throw new Error('No due App Run attempt job');
    await send({ phase: 'attempt_claimed', job_id: job.id,
      attempt_id: job.data.attemptId });
    await handleAppRunAttempt({ id: job.id, name: job.name, data: job.data,
      attempts: job.attempts, leaseExpiresAt: job.lockExpiresAt });
    await send({ phase: 'receipt_committed', job_id: job.id });
    if (command.pause_after_receipt) await waitForContinue();
    await queues.completeJob(job.id, job.lockToken);
    await send({ phase: 'done', job_id: job.id });
    return;
  }
  if (command.action === 'recover') {
    const runtime = await getAppRunRuntime();
    // Deterministic clock crosses the provider lease without waiting a minute.
    const { AppRunAttemptRunner } = await import('../../src/lib/app-run-attempt-runner.js');
    const { AppRunSecretService } = await import('../../src/lib/app-run-secrets.js');
    const { PinnedMcpAppRunProviderExecutor } = await import('../../src/lib/app-run-provider-executor.js');
    const { PostgresAppRunReceiptWriter } = await import('../../src/lib/app-run-receipts.js');
    const { PostgresAppRunAttentionProjector } = await import('../../src/lib/app-run-attention.js');
    const { postgresAppRunAttemptQueue } = await import('../../src/lib/app-run-scheduler.js');
    const secrets = new AppRunSecretService(runtime.keys);
    const runner = new AppRunAttemptRunner(runtime.repository,
      runtime.secretRepository, secrets, new PinnedMcpAppRunProviderExecutor(),
      runtime.liveAuthorization, () => new Date(Date.now() + 120_000),
      60_000, 20_000,
      new PostgresAppRunReceiptWriter(secrets, runtime.secretRepository),
      new PostgresAppRunAttentionProjector(), postgresAppRunAttemptQueue);
    const recovered = await runner.recoverRun(command.org_id, command.run_id!);
    await send({ phase: 'done', recovered });
    return;
  }
  const runtime = await getAppRunRuntime();
  const receipts = await runtime.receiptReader.readVerified(command.org_id, command.run_id!);
  const [row] = await db.select({ state: appRuns.state }).from(appRuns).where(and(
    eq(appRuns.org_id, command.org_id), eq(appRuns.id, command.run_id!),
  ));
  await send({ phase: 'done', run_state: row?.state ?? null,
    verified_receipts: receipts.length });
}

process.once('message', async (message) => {
  const command = message as Command;
  try {
    await run(command);
    process.exitCode = 0;
  } catch (error) {
    await send({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    await mcpClientManager.disconnect(command.connection_id).catch(() => undefined);
    const { shutdownAppRunRuntime } = await import('../../src/lib/app-run-runtime.js');
    const { closeDb } = await import('../../src/lib/db.js');
    await shutdownAppRunRuntime();
    await closeDb();
    if (process.connected) process.disconnect();
  }
});
