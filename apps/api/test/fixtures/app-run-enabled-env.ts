// Import first in the isolated lifecycle test process, before env.ts freezes flags.
// These deterministic keys are disposable test data; the lifecycle replaces them
// with the database-complete fixture before composing the lazy runtime.
import { createHash } from 'node:crypto';
import { APP_RUN_CONTRACT_VERSIONS } from '@deft/shared';

function key(purpose: string): string {
  return createHash('sha256').update(`loop5-lifecycle:${purpose}:${purpose === 'run_encryption' ? 'enc-v1' : purpose === 'receipt_signing' ? 'sig-v1' : 'fp-v1'}`).digest('base64');
}

process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_RUNS_ENABLED = 'true';
process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
process.env.DEFT_APP_AUTOMATIONS_ENABLED = 'true';
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
  schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
  run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('run_encryption') } },
  receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('receipt_signing') } },
  fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fingerprint') } },
});
