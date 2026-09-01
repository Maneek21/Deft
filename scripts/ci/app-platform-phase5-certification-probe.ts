import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_RUN_CONTRACT_VERSIONS,
  canonicalCapabilityJson,
} from '../../packages/shared/src/index.js';

const KEYRING_PURPOSE = 'loop5-lifecycle';
const SNAPSHOT_SCHEMA = 'deft.app_platform.phase5.continuity_snapshot.v1';
const VERIFY_SCHEMA = 'deft.app_platform.phase5.restore_verification.v1';

const CONTINUITY_TABLES = Object.freeze([
  'agent_actions',
  'app_action_bindings',
  'app_dependency_locks',
  'app_grant_snapshots',
  'app_installations',
  'app_module_bindings',
  'app_run_attempts',
  'app_run_events',
  'app_run_receipts',
  'app_run_secret_payloads',
  'app_runs',
  'app_versions',
  'capability_provider_snapshots',
  'module_installations',
  'module_mutation_receipts',
  'module_records',
  'module_versions',
  'resource_relation_edges',
  'resource_relation_receipts',
  'resource_relation_sets',
] as const);

const EXPECTED_APP_PACKAGE_DIGESTS = Object.freeze([
  'sha256:1471f0b94da9f6851bd978c315bc22a2dd0343b61a87477e4293b144c54248d8',
  'sha256:0f478f5a761590f1f5874c7a0d0dc3382436b5e7f44c0c6ad6591cd577476344',
  'sha256:973ec7076daf7405a7a4d8b48509ef6f99b1b1cc4b787961104c73f23b7f770d',
] as const);

const EXPECTED_MODULE_MANIFEST_DIGEST =
  'sha256:5dc2a978506eb2917a3a99021831d62d94112a60615292e4b32e03e480cff208';
const EXPECTED_LATEST_MIGRATION = '0.3.0-preview.25';

type CliOptions = Readonly<{
  mode: 'keyring' | 'snapshot' | 'verify';
  output: string;
  expectedSnapshot?: string;
}>;

type QueryResult<Row extends Record<string, unknown>> = Readonly<{
  rows: Row[];
  rowCount: number | null;
}>;

type PgClient = {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  end(): Promise<void>;
};

type PgModule = Readonly<{
  Client: new (config: Readonly<{ connectionString: string }>) => PgClient;
}>;

export type ContinuityTableSnapshot = Readonly<{
  table: string;
  row_count: number;
  sha256: string;
}>;

export type ContinuitySnapshot = Readonly<{
  schema_version: typeof SNAPSHOT_SCHEMA;
  continuity_sha256: string;
  total_rows: number;
  pgvector_version: string;
  migration_count: number;
  latest_migration: string;
  migration_sha256: string;
  tables: readonly ContinuityTableSnapshot[];
}>;

class CertificationProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CertificationProbeError';
  }
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function deterministicKey(purpose: string, keyId: string): string {
  return createHash('sha256')
    .update(`${KEYRING_PURPOSE}:${purpose}:${keyId}`)
    .digest('base64');
}

export function deterministicCertificationKeyring() {
  return {
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: {
      current: 'enc-v1',
      keys: { 'enc-v1': deterministicKey('run_encryption', 'enc-v1') },
    },
    receipt_signing: {
      current: 'sig-v1',
      keys: { 'sig-v1': deterministicKey('receipt_signing', 'sig-v1') },
    },
    fingerprint: {
      current: 'fp-v1',
      keys: { 'fp-v1': deterministicKey('fingerprint', 'fp-v1') },
    },
  } as const;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const [rawMode, ...rest] = argv;
  if (rawMode !== 'keyring' && rawMode !== 'snapshot' && rawMode !== 'verify') {
    throw new CertificationProbeError('USAGE_INVALID_MODE');
  }

  let output: string | undefined;
  let expectedSnapshot: string | undefined;
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new CertificationProbeError('USAGE_MISSING_VALUE');
    }
    if (flag === '--output' && output === undefined) output = value;
    else if (flag === '--expected-snapshot' && expectedSnapshot === undefined) {
      expectedSnapshot = value;
    } else {
      throw new CertificationProbeError('USAGE_UNKNOWN_OR_DUPLICATE_FLAG');
    }
  }

  if (!output) throw new CertificationProbeError('USAGE_OUTPUT_REQUIRED');
  if (rawMode === 'verify' && !expectedSnapshot) {
    throw new CertificationProbeError('USAGE_EXPECTED_SNAPSHOT_REQUIRED');
  }
  if (rawMode !== 'verify' && expectedSnapshot) {
    throw new CertificationProbeError('USAGE_EXPECTED_SNAPSHOT_NOT_ALLOWED');
  }
  if (expectedSnapshot && resolve(expectedSnapshot) === resolve(output)) {
    throw new CertificationProbeError('USAGE_OUTPUT_OVERLAPS_INPUT');
  }
  return {
    mode: rawMode,
    output: resolve(output),
    ...(expectedSnapshot ? { expectedSnapshot: resolve(expectedSnapshot) } : {}),
  };
}

async function writeJson(path: string, value: unknown, secret = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const serialized = secret
    ? canonicalCapabilityJson(value)
    : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, serialized, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

function databaseUrl(): string {
  const value = process.env.DATABASE_URL ?? process.env.DEFT_TEST_DATABASE_URL;
  if (!value) throw new CertificationProbeError('DATABASE_URL_REQUIRED');
  return value;
}

function pgClient(): PgClient {
  const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  const pg = requireFromApi('pg') as PgModule;
  return new pg.Client({ connectionString: databaseUrl() });
}

async function withClient<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
  const client = pgClient();
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function tableSnapshot(table: string, rows: readonly unknown[]): ContinuityTableSnapshot {
  return Object.freeze({
    table,
    row_count: rows.length,
    sha256: sha256(canonicalCapabilityJson(rows)),
  });
}

function snapshotBasis(snapshot: Omit<ContinuitySnapshot, 'continuity_sha256'>) {
  return {
    schema_version: snapshot.schema_version,
    pgvector_version: snapshot.pgvector_version,
    migration_count: snapshot.migration_count,
    latest_migration: snapshot.latest_migration,
    migration_sha256: snapshot.migration_sha256,
    tables: snapshot.tables,
  };
}

export function assembleContinuitySnapshot(input: Readonly<{
  pgvectorVersion: string;
  migrations: readonly unknown[];
  tables: readonly ContinuityTableSnapshot[];
}>): ContinuitySnapshot {
  if (input.migrations.length === 0) {
    throw new CertificationProbeError('MIGRATION_LEDGER_EMPTY');
  }
  const latest = input.migrations.at(-1);
  if (!latest || typeof latest !== 'object' || !('version' in latest)) {
    throw new CertificationProbeError('MIGRATION_LEDGER_INVALID');
  }
  const latestMigration = (latest as { version?: unknown }).version;
  if (typeof latestMigration !== 'string' || !latestMigration) {
    throw new CertificationProbeError('MIGRATION_LEDGER_INVALID');
  }
  if (latestMigration !== EXPECTED_LATEST_MIGRATION) {
    throw new CertificationProbeError('PHASE5_MIGRATION_NOT_CURRENT');
  }
  const partial = {
    schema_version: SNAPSHOT_SCHEMA,
    total_rows: input.tables.reduce((total, table) => total + table.row_count, 0),
    pgvector_version: input.pgvectorVersion,
    migration_count: input.migrations.length,
    latest_migration: latestMigration,
    migration_sha256: sha256(canonicalCapabilityJson(input.migrations)),
    tables: Object.freeze([...input.tables]),
  } satisfies Omit<ContinuitySnapshot, 'continuity_sha256'>;
  return Object.freeze({
    ...partial,
    continuity_sha256: sha256(canonicalCapabilityJson(snapshotBasis(partial))),
  });
}

async function createContinuitySnapshot(client: PgClient): Promise<ContinuitySnapshot> {
  const tables: ContinuityTableSnapshot[] = [];
  for (const table of CONTINUITY_TABLES) {
    const result = await client.query<{ value: unknown }>(
      `SELECT to_jsonb(certification_row) AS value
         FROM (SELECT * FROM "${table}" ORDER BY id) AS certification_row`,
    );
    tables.push(tableSnapshot(table, result.rows.map((row) => row.value)));
  }

  const vector = await client.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  if (vector.rows.length !== 1 || !vector.rows[0]?.extversion) {
    throw new CertificationProbeError('PGVECTOR_EXTENSION_MISSING');
  }
  const migrations = await client.query<{ value: unknown }>(
    `SELECT to_jsonb(certification_migration) AS value
       FROM (
         SELECT * FROM deft_schema_migrations ORDER BY applied_at, version
       ) AS certification_migration`,
  );
  return assembleContinuitySnapshot({
    pgvectorVersion: vector.rows[0].extversion,
    migrations: migrations.rows.map((row) => row.value),
    tables,
  });
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function parseContinuitySnapshot(value: unknown): ContinuitySnapshot {
  if (!value || typeof value !== 'object') {
    throw new CertificationProbeError('EXPECTED_SNAPSHOT_INVALID');
  }
  const candidate = value as Partial<ContinuitySnapshot>;
  if (
    candidate.schema_version !== SNAPSHOT_SCHEMA
    || !isSha256(candidate.continuity_sha256)
    || typeof candidate.pgvector_version !== 'string'
    || typeof candidate.migration_count !== 'number'
    || typeof candidate.latest_migration !== 'string'
    || !isSha256(candidate.migration_sha256)
    || !Array.isArray(candidate.tables)
  ) throw new CertificationProbeError('EXPECTED_SNAPSHOT_INVALID');

  const tables = candidate.tables.map((raw) => {
    if (
      !raw || typeof raw !== 'object'
      || typeof raw.table !== 'string'
      || !Number.isInteger(raw.row_count) || raw.row_count < 0
      || !isSha256(raw.sha256)
    ) throw new CertificationProbeError('EXPECTED_SNAPSHOT_INVALID');
    return Object.freeze({ table: raw.table, row_count: raw.row_count, sha256: raw.sha256 });
  });
  const parsed = Object.freeze({
    schema_version: SNAPSHOT_SCHEMA,
    continuity_sha256: candidate.continuity_sha256,
    total_rows: tables.reduce((total, table) => total + table.row_count, 0),
    pgvector_version: candidate.pgvector_version,
    migration_count: candidate.migration_count,
    latest_migration: candidate.latest_migration,
    migration_sha256: candidate.migration_sha256,
    tables,
  }) satisfies ContinuitySnapshot;
  const recomputed = sha256(canonicalCapabilityJson(snapshotBasis(parsed)));
  if (recomputed !== parsed.continuity_sha256) {
    throw new CertificationProbeError('EXPECTED_SNAPSHOT_HASH_INVALID');
  }
  return parsed;
}

async function generateKeyring(output: string): Promise<void> {
  const keyring = deterministicCertificationKeyring();
  await writeJson(output, keyring, true);
  const serialized = canonicalCapabilityJson(keyring);
  console.log(JSON.stringify({
    schema_version: 'deft.app_platform.phase5.disposable_keyring.v1',
    result: 'written',
    output: basename(output),
    sha256: sha256(serialized),
    warning: 'deterministic_disposable_certification_keys_only',
    key_ids: {
      run_encryption: keyring.run_encryption.current,
      receipt_signing: keyring.receipt_signing.current,
      fingerprint: keyring.fingerprint.current,
    },
  }));
}

async function writeSnapshot(output: string): Promise<void> {
  const snapshot = await withClient(createContinuitySnapshot);
  await writeJson(output, snapshot);
  console.log(JSON.stringify(snapshot));
}

async function verifyProofArtifacts(client: PgClient): Promise<void> {
  const apps = await client.query<{ package_digest: string }>(
    'SELECT DISTINCT package_digest FROM app_versions WHERE package_digest = ANY($1::text[])',
    [[...EXPECTED_APP_PACKAGE_DIGESTS]],
  );
  const foundApps = new Set(apps.rows.map((row) => row.package_digest));
  if (EXPECTED_APP_PACKAGE_DIGESTS.some((digest) => !foundApps.has(digest))) {
    throw new CertificationProbeError('PROOF_APP_DIGEST_MISSING');
  }
  const modules = await client.query<{ manifest_digest: string }>(
    'SELECT DISTINCT manifest_digest FROM module_versions WHERE manifest_digest = $1',
    [EXPECTED_MODULE_MANIFEST_DIGEST],
  );
  if (modules.rows.length === 0) {
    throw new CertificationProbeError('PROOF_MODULE_DIGEST_MISSING');
  }
}

async function verifyRestore(expectedPath: string, output: string): Promise<void> {
  const expected = parseContinuitySnapshot(JSON.parse(await readFile(expectedPath, 'utf8')) as unknown);
  const restored = await withClient(createContinuitySnapshot);
  if (restored.continuity_sha256 !== expected.continuity_sha256) {
    throw new CertificationProbeError('RESTORED_CONTINUITY_MISMATCH');
  }

  type RunRow = { id: string; org_id: string; state: string };
  type AttemptRow = { id: string };
  type ReceiptRow = {
    envelope: unknown;
    envelope_digest: string;
    signing_key_version: string;
    signature_hmac: string;
  };

  let closeDb: (() => Promise<void>) | undefined;
  let destroyKeys: (() => void) | undefined;
  const client = pgClient();
  await client.connect();
  try {
    const keyringModule = await import('../../apps/api/src/lib/app-run-keyrings.js');
    const repositoryModule = await import('../../apps/api/src/lib/app-run-repository.js');
    const secretRepositoryModule = await import('../../apps/api/src/lib/app-run-secret-repository.js');
    const secretModule = await import('../../apps/api/src/lib/app-run-secrets.js');
    const dbModule = await import('../../apps/api/src/lib/db.js');
    closeDb = dbModule.closeDb;
    const keys = keyringModule.parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
    destroyKeys = () => keys.destroy();
    const secrets = new secretModule.AppRunSecretService(keys);
    const repository = new repositoryModule.PostgresAppRunRepository();
    const secretRepository = new secretRepositoryModule.AppRunSecretRepository(secrets);
    const inventoryAt = new Date();
    keyringModule.assertAppRunReferencedKeysAvailable(keys, [
      ...await repository.activeKeyReferences(inventoryAt),
      ...await secretRepository.retainedKeyReferences(inventoryAt),
      ...await secretRepository.receiptSigningKeyReferences(),
    ]);

    const runs = await client.query<RunRow>(
      "SELECT id, org_id, state FROM app_runs WHERE origin_kind = 'app' ORDER BY id",
    );
    const succeeded = runs.rows.filter((run) => run.state === 'succeeded');
    if (succeeded.length < 4) {
      throw new CertificationProbeError('APP_ORIGIN_SUCCESS_PROOF_INCOMPLETE');
    }

    let inputsDecrypted = 0;
    let outputsDecrypted = 0;
    for (const run of succeeded) {
      const input = await secretRepository.readInput(run.org_id, run.id);
      if (input === null) throw new CertificationProbeError('APP_RUN_INPUT_NOT_RECOVERABLE');
      inputsDecrypted += 1;

      const attempts = await client.query<AttemptRow>(
        `SELECT id FROM app_run_attempts
          WHERE org_id = $1 AND run_id = $2 AND state = 'succeeded'
          ORDER BY attempt_number DESC LIMIT 1`,
        [run.org_id, run.id],
      );
      const attempt = attempts.rows[0];
      if (!attempt) throw new CertificationProbeError('APP_RUN_SUCCESS_ATTEMPT_MISSING');
      const result = await secretRepository.readOutput(run.org_id, run.id, attempt.id);
      if (
        !result || typeof result !== 'object' || Array.isArray(result)
        || result.provider_succeeded !== true
      ) throw new CertificationProbeError('APP_RUN_OUTPUT_NOT_RECOVERABLE');
      outputsDecrypted += 1;
    }

    const receipts = await client.query<ReceiptRow>(
      `SELECT envelope, envelope_digest, signing_key_version, signature_hmac
         FROM app_run_receipts ORDER BY id`,
    );
    if (receipts.rows.length === 0) {
      throw new CertificationProbeError('APP_RUN_RECEIPTS_MISSING');
    }
    let receiptsVerified = 0;
    for (const receipt of receipts.rows) {
      const digest = sha256(canonicalCapabilityJson(receipt.envelope));
      if (
        digest !== receipt.envelope_digest
        || !secrets.verifyReceipt(
          receipt.envelope,
          receipt.signing_key_version,
          receipt.signature_hmac,
        )
      ) throw new CertificationProbeError('APP_RUN_RECEIPT_INVALID');
      receiptsVerified += 1;
    }

    await verifyProofArtifacts(client);
    const report = Object.freeze({
      schema_version: VERIFY_SCHEMA,
      result: 'passed',
      continuity: {
        expected_sha256: expected.continuity_sha256,
        restored_sha256: restored.continuity_sha256,
        matched: true,
        table_count: restored.tables.length,
        total_rows: restored.total_rows,
        pgvector_version: restored.pgvector_version,
        migration_count: restored.migration_count,
        latest_migration: restored.latest_migration,
      },
      referenced_key_inventory: {
        checked: true,
        run_encryption_versions: keys.keyIds('run_encryption').length,
        receipt_signing_versions: keys.keyIds('receipt_signing').length,
        fingerprint_versions: keys.keyIds('fingerprint').length,
      },
      app_origin_runs: {
        total: runs.rows.length,
        succeeded: succeeded.length,
        inputs_decrypted: inputsDecrypted,
        outputs_decrypted: outputsDecrypted,
      },
      receipts: {
        total: receipts.rows.length,
        verified: receiptsVerified,
      },
      proof_artifacts: {
        app_package_digests_verified: EXPECTED_APP_PACKAGE_DIGESTS.length,
        module_manifest_digests_verified: 1,
      },
    });
    await writeJson(output, report);
    console.log(JSON.stringify(report));
  } finally {
    try {
      await client.end();
    } finally {
      destroyKeys?.();
      await closeDb?.();
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  if (options.mode === 'keyring') return generateKeyring(options.output);
  if (options.mode === 'snapshot') return writeSnapshot(options.output);
  if (!options.expectedSnapshot) throw new CertificationProbeError('USAGE_EXPECTED_SNAPSHOT_REQUIRED');
  return verifyRestore(options.expectedSnapshot, options.output);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error: unknown) => {
    const code = error instanceof CertificationProbeError ? error.code : 'UNEXPECTED_FAILURE';
    console.error(JSON.stringify({
      schema_version: 'deft.app_platform.phase5.certification_error.v1',
      result: 'failed',
      error_code: code,
    }));
    process.exitCode = 1;
  });
}

export const __test = Object.freeze({
  SNAPSHOT_SCHEMA,
  CONTINUITY_TABLES,
  EXPECTED_APP_PACKAGE_DIGESTS,
  EXPECTED_MODULE_MANIFEST_DIGEST,
  EXPECTED_LATEST_MIGRATION,
  parseContinuitySnapshot,
  sha256,
  tableSnapshot,
});
