import { open, readFile } from 'node:fs/promises';
import { createAppRuntimeClient, type AppRuntimeClaim } from '@deft/app-kit';

type Start = Readonly<{
  type: 'start';
  channel_url: string;
  session_id: string;
  session_token: string;
  ledger_path: string;
  mode: 'normal' | 'pause_before_effect' | 'pause_after_effect';
}>;

function send(message: Record<string, unknown>) {
  process.send?.(message);
}

async function durableSyntheticEffect(path: string, claim: AppRuntimeClaim, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('INVALID_REVIEWED_INPUT');
  }
  const itemId = (input as Record<string, unknown>).item_id
    ?? (input as Record<string, unknown>).shipment_id;
  if (typeof itemId !== 'string' || itemId.length < 1 || itemId.length > 120) {
    throw new Error('INVALID_REVIEWED_INPUT');
  }
  // This file is an external-effect *fixture*, not a Deft production ledger.
  // Append and fsync are deliberately in this worker process so SIGKILL after
  // the notification leaves a durable effect while the host lacks a result.
  const prior = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (prior.split('\n').filter(Boolean).some((line) => {
    const row = JSON.parse(line) as { run_id?: string };
    return row.run_id === claim.run_id;
  })) return;
  const handle = await open(path, 'a');
  try {
    await handle.write(`${JSON.stringify({ run_id: claim.run_id,
      item_id: itemId, effect: 'synthetic_carrier_label' })}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

async function run(config: Start) {
  const client = createAppRuntimeClient({
    channel_url: config.channel_url,
    credential: { session_id: config.session_id, session_token: config.session_token },
  });
  const claim = await client.claim();
  if (!claim) { send({ type: 'idle' }); return; }
  send({ type: 'claimed', run_id: claim.run_id, attempt_id: claim.attempt_id });
  const started = await client.start(claim);
  send({ type: 'started', run_id: claim.run_id });
  if (config.mode === 'pause_before_effect') {
    await new Promise<never>(() => { setInterval(() => {}, 1000); });
  }
  await durableSyntheticEffect(config.ledger_path, claim, started.input);
  send({ type: 'effect_committed', run_id: claim.run_id });
  if (config.mode === 'pause_after_effect') {
    await new Promise<never>(() => { setInterval(() => {}, 1000); });
  }
  const settled = await client.result(claim, { status: 'returned', provider_succeeded: true,
    output: { label_id: `synthetic-${claim.run_id}` } });
  send({ type: 'result', run_id: claim.run_id,
    state: settled && typeof settled === 'object' && 'state' in settled
      ? (settled as { state: unknown }).state : 'unknown' });
}

if (!process.send || process.env.DEFT_RUNTIME_PROVIDER_FIXTURE !== 'true'
  || !process.env.DEFT_TEST_DATABASE_URL
  || process.env.DEFT_TEST_DATABASE_URL !== process.env.DATABASE_URL) {
  throw new Error('Runtime provider child requires explicit disposable test process');
}
process.once('message', (value: unknown) => {
  if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'start') {
    send({ type: 'error', code: 'INVALID_FIXTURE_CONFIG' });
    process.exitCode = 1;
    return;
  }
  void run(value as Start).then(() => { process.exitCode = 0; }, (error: unknown) => {
    send({ type: 'error', code: error instanceof Error ? error.message : 'FIXTURE_FAILED' });
    process.exitCode = 1;
  });
});
