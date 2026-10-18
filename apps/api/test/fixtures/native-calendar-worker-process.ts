// A separate warmed process runs the real leased worker. It reports only
// lifecycle metadata; no credential, input, result or raw error is sent.
const url = process.env.DATABASE_URL ?? '';
if (!/^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c14_native_calendar_test(?:_v[0-9]+)?$/.test(url)
  || process.env.DEFT_TEST_DATABASE_URL !== url || !process.send) process.exit(2);

void (async () => {
  const { getAppRunRuntime } = await import('../../src/lib/app-run-runtime.js');
  const runtime = await getAppRunRuntime();
  const { _processDequeuedJobForTest } = await import('../../src/workers/index.js');
  const queues = await import('../../src/lib/queues.js');
  process.on('message', async (message: { org_id: string; run_id: string; hold_after_commit?: boolean }) => {
    try {
      if (message.hold_after_commit) {
        const inspect = runtime.repository.inspect.bind(runtime.repository);
        runtime.repository.inspect = async (org, id) => {
          const run = await inspect(org, id);
          if (org === message.org_id && id === message.run_id && run?.state === 'succeeded') {
            process.send!({ type: 'committed' });
            // Simulates lost worker delivery after the real native COMMIT.
            // No SQL or effect continues after this barrier.
            await new Promise<void>(() => {});
          }
          return run;
        };
      }
      const job = await queues.dequeueJob(queues.QUEUE_NAMES.AGENT_JOBS,
        { orgId: message.org_id, jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: message.run_id } });
      if (!job) throw new Error('NO_JOB');
      process.send!({ type: 'leased' });
      await _processDequeuedJobForTest(queues.QUEUE_NAMES.AGENT_JOBS, job);
      process.send!({ type: 'completed' });
    } catch (error) {
      process.send!({ type: 'failed', name: error instanceof Error ? error.name : 'Unknown' });
    }
  });
  process.send!({ type: 'ready' });
})().catch(error => {
  process.send!({ type: 'failed', name: error instanceof Error ? error.name : 'Unknown' });
  process.exitCode = 1;
});
