import { open, readFile } from 'node:fs/promises';
import {
  createResourceSyncClient, SyncPageV1Schema,
  type ResourceSyncClaim, type ResourceSyncStart, type SyncPageV1,
} from '@deft/app-kit/experimental/resource-sync';

type Credential = Readonly<{ session_id: string; session_token: string }>;
type Start = Readonly<{
  type: 'start'; channel_url: string; credential: Credential;
  source_path: string; ledger_path: string;
  mode: 'normal' | 'pause_after_observe';
}>;
type Replay = Readonly<{
  type: 'replay'; channel_url: string; credential: Credential;
  claim: ResourceSyncClaim; started: ResourceSyncStart; page: SyncPageV1;
}>;

function send(value: Record<string, unknown>) { process.send?.(value); }

async function observeSource(path: string, ledgerPath: string, claim: ResourceSyncClaim) {
  const page = SyncPageV1Schema.parse(JSON.parse(await readFile(path, 'utf8')));
  const handle = await open(ledgerPath, 'a');
  try {
    await handle.write(`${JSON.stringify({ run_id: claim.run_id,
      attempt_id: claim.attempt_id, observation: 'synthetic_source_page_read' })}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  return page;
}

async function run(config: Start | Replay) {
  const client = createResourceSyncClient({
    channel_url: config.channel_url, credential: config.credential,
  });
  if (config.type === 'replay') {
    await client.result(config.claim, config.started,
      { status: 'returned', provider_succeeded: true, page: config.page });
    send({ type: 'replayed', run_id: config.claim.run_id });
    return;
  }
  const claim = await client.claim();
  if (!claim) { send({ type: 'idle' }); return; }
  send({ type: 'claimed', run_id: claim.run_id, attempt_id: claim.attempt_id });
  const started = await client.start(claim);
  send({ type: 'started', run_id: claim.run_id });
  const page = await observeSource(config.source_path, config.ledger_path, claim);
  // The parent may SIGKILL after this IPC event; fsync has already completed.
  send({ type: 'observed', run_id: claim.run_id, claim, started, page });
  if (config.mode === 'pause_after_observe') {
    await new Promise<never>(() => { setInterval(() => {}, 1_000); });
  }
  await client.result(claim, started, { status: 'returned', provider_succeeded: true, page });
  send({ type: 'result', run_id: claim.run_id });
}

const target = process.env.DEFT_TEST_DATABASE_URL;
const assigned = target && target === process.env.DATABASE_URL
  && new URL(target).hostname === '127.0.0.1'
  && new URL(target).port === '55435'
  && new URL(target).pathname === '/gate_g_phase5_test_s05_sync_http';
if (!process.send || process.env.DEFT_RESOURCE_SYNC_PROVIDER_FIXTURE !== 'true'
  || !assigned) {
  throw new Error('Resource sync provider child requires an explicit disposable test process');
}
process.once('message', (value: unknown) => {
  if (!value || typeof value !== 'object' || !('type' in value)
    || !['start', 'replay'].includes(String(value.type))) {
    send({ type: 'error', code: 'INVALID_FIXTURE_CONFIG' });
    process.exitCode = 1;
    return;
  }
  void run(value as Start | Replay).then(() => { process.exitCode = 0; }, (error: unknown) => {
    send({ type: 'error', code: error instanceof Error ? error.message : 'FIXTURE_FAILED' });
    process.exitCode = 1;
  });
});
