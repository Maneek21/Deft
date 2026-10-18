import './app-run-enabled-env.js';
import pg from 'pg';
import { runAppAutomationScan } from '../../src/lib/app-automation-runtime.js';
import { dequeueJob, QUEUE_NAMES } from '../../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../../src/workers/index.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
if (!target || target !== process.env.DATABASE_URL
  || !/^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c09_a05_catalog_test(?:_v[0-9]+)?$/.test(target)) {
  throw new Error('Scanner interruption child requires its dedicated synthetic database');
}
process.once('message', async (raw: { mode: 'before-progress' | 'after-progress'; policy_at: string }) => {
  const original = pg.Client.prototype.query;
  const progressClients = new WeakSet<pg.Client>();
  let domainWorkObserved = false;
  let paused = false;
  const pause = async (jobId: string) => {
    paused = true;
    await new Promise<void>((resolve, reject) => process.send!({ phase: raw.mode, job_id: jobId },
      error => error ? reject(error) : resolve()));
    // Parent SIGKILLs this process. No implementation clock/domain lease is changed.
    return new Promise<never>(() => {});
  };
  try {
    const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan', leaseMs: 1_000 });
    if (!job) throw new Error('No scan delivery to interrupt');
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      const value = args[0];
      const text = typeof value === 'string' ? value : (value as { text?: string })?.text ?? '';
      if (/insert into "app_automation_fires"/i.test(text)) domainWorkObserved = true;
      const progressWrite = domainWorkObserved && /update "?job_queue"?/i.test(text)
        && /set "?data"?/i.test(text);
      if (!paused && progressWrite && raw.mode === 'before-progress') return pause(job.id);
      if (progressWrite) progressClients.add(this);
      const result = Reflect.apply(original, this, args);
      if (!paused && /^commit$/i.test(text) && progressClients.has(this) && raw.mode === 'after-progress') {
        return (result as Promise<unknown>).then(() => pause(job.id));
      }
      return result;
    } as typeof original;
    await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, job, {
      resolveHandler: async () => async value => runAppAutomationScan(new Date(raw.policy_at), value.signal,
        { id: value.id, lockToken: value.lockToken! }),
    });
    process.send!({ phase: 'error', message: 'Requested boundary was not reached' });
  } catch (error) {
    process.send!({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
process.send!({ phase: 'ready' });
