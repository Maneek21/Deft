import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { APP_RUN_CONTRACT_VERSIONS } from '@deft/shared';
import { parseEnvironmentAppRunKeyrings } from '../apps/api/src/lib/app-run-keyrings.js';
import { AppRunSecretService } from '../apps/api/src/lib/app-run-secrets.js';

const key = (purpose: string, keyId: string) => createHash('sha256')
  .update(`loop5-lifecycle:${purpose}:${keyId}`)
  .digest('base64');

async function main() {
  const databaseUrl = process.env.DEFT_RESTORE_PROOF_DATABASE_URL;
  if (!databaseUrl) throw new Error('DEFT_RESTORE_PROOF_DATABASE_URL is required');
  const provider = parseEnvironmentAppRunKeyrings(JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('run_encryption', 'enc-v1') } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('receipt_signing', 'sig-v1') } },
    fingerprint: { current: 'fp-v1', keys: {
      'fp-v1': key('fingerprint', 'fp-v1'),
      'fp-old': key('fingerprint', 'fp-old'),
    } },
  }));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
  const result = await client.query<{
    receipt_key: string;
    envelope: unknown;
    signing_key_version: string;
    signature_hmac: string;
  }>('SELECT receipt_key, envelope, signing_key_version, signature_hmac FROM app_run_receipts ORDER BY created_at LIMIT 1');
  assert.equal(result.rows.length, 1, 'restore proof requires exactly one selected App Run receipt');
  const row = result.rows[0]!;
  assert.equal(new AppRunSecretService(provider).verifyReceipt(
    row.envelope,
    row.signing_key_version,
    row.signature_hmac,
  ), true, 'restored App Run receipt failed canonical verification');
  console.log(JSON.stringify({ verified: true, receipt_key: row.receipt_key, signing_key_version: row.signing_key_version }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[FAIL]', error instanceof Error ? error.message : error);
  process.exit(1);
});
