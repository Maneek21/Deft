import { createHash } from 'node:crypto';
import {
  appRunReceipts,
  appRunSecretPayloads,
  appRuns,
} from '@deft/db/schema';
import { APP_RUN_CONTRACT_VERSIONS } from '@deft/shared';
import { db } from '../../src/lib/db.js';
import { parseEnvironmentAppRunKeyrings } from '../../src/lib/app-run-keyrings.js';

function key(seed: string, purpose: string, keyId: string): string {
  return createHash('sha256').update(`${seed}:${purpose}:${keyId}`).digest('base64');
}

function keyMap(
  seed: string,
  purpose: string,
  keyIds: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries([...keyIds].map((keyId) => [keyId, key(seed, purpose, keyId)]));
}

/**
 * Builds deterministic test keyrings containing every key ID referenced by
 * the shared disposable database. This satisfies the global retirement guard
 * without making focused tests depend on file order or another test's org.
 */
export async function databaseCompleteAppRunTestKeyrings(seed: string) {
  const [fingerprintRows, encryptionRows, signingRows] = await Promise.all([
    db.select({
      idempotency: appRuns.idempotency_key_version,
      input: appRuns.input_fingerprint_key_version,
    }).from(appRuns),
    db.selectDistinct({ keyId: appRunSecretPayloads.key_version }).from(appRunSecretPayloads),
    db.selectDistinct({ keyId: appRunReceipts.signing_key_version }).from(appRunReceipts),
  ]);
  const fingerprintKeyIds = new Set([
    'fp-v1',
    ...fingerprintRows.flatMap((row) => [row.idempotency, row.input]),
  ]);
  const encryptionKeyIds = new Set(['enc-v1', ...encryptionRows.map((row) => row.keyId)]);
  const signingKeyIds = new Set(['sig-v1', ...signingRows.map((row) => row.keyId)]);
  return parseEnvironmentAppRunKeyrings(JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: {
      current: 'enc-v1',
      keys: keyMap(seed, 'run_encryption', encryptionKeyIds),
    },
    receipt_signing: {
      current: 'sig-v1',
      keys: keyMap(seed, 'receipt_signing', signingKeyIds),
    },
    fingerprint: {
      current: 'fp-v1',
      keys: keyMap(seed, 'fingerprint', fingerprintKeyIds),
    },
  }));
}
