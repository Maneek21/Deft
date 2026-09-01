import { AppRunAttemptRunner } from './app-run-attempt-runner.js';
import { PostgresAppRunApprovalResolver, postgresAppRunApprovalAdapter } from './app-run-approval-adapter.js';
import { PostgresAppRunAttentionProjector } from './app-run-attention.js';
import { PostgresAppRunAuthorizer } from './app-run-authorization.js';
import { AppRunError } from './app-run-errors.js';
import { parseEnvironmentAppRunKeyrings, type EnvironmentAppRunKeyProvider } from './app-run-keyrings.js';
import { PostgresAppRunLiveAuthorization } from './app-run-live-authorization.js';
import {
  AppRunOperationsService,
  postgresAppRunReadOperationsAuthorizer,
} from './app-run-operations.js';
import { PinnedMcpAppRunProviderExecutor } from './app-run-provider-executor.js';
import { PostgresAppRunReceiptReader, PostgresAppRunReceiptWriter } from './app-run-receipts.js';
import { PostgresAppRunRepository } from './app-run-repository.js';
import { postgresAppRunAttemptQueue } from './app-run-scheduler.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import { AppRunSecretService } from './app-run-secrets.js';
import { AppRunPreparedInputService } from './app-run-prepared-input.js';
import { AppRunService } from './app-run-service.js';
import { APP_RUN_APP_ORIGIN_ENABLED, APP_RUNS_ENABLED } from './env.js';

export type AppRunRuntime = Readonly<{
  keys: EnvironmentAppRunKeyProvider;
  repository: PostgresAppRunRepository;
  secretRepository: AppRunSecretRepository;
  inputPreparation: AppRunPreparedInputService;
  liveAuthorization: PostgresAppRunLiveAuthorization;
  service: AppRunService;
  attemptRunner: AppRunAttemptRunner;
  approvalResolver: PostgresAppRunApprovalResolver;
  receiptReader: PostgresAppRunReceiptReader;
  operations: AppRunOperationsService;
}>;

let runtimePromise: Promise<AppRunRuntime> | null = null;

async function createAppRunRuntime(): Promise<AppRunRuntime> {
  const keys = parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
  const secrets = new AppRunSecretService(keys);
  const repository = new PostgresAppRunRepository();
  const secretRepository = new AppRunSecretRepository(secrets);
  const inputPreparation = new AppRunPreparedInputService(secrets);
  const liveAuthorization = new PostgresAppRunLiveAuthorization();
  const accessAuthorization = new PostgresAppRunAuthorizer();
  const receipts = new PostgresAppRunReceiptWriter(secrets, secretRepository);
  const receiptReader = new PostgresAppRunReceiptReader(secrets);
  const attention = new PostgresAppRunAttentionProjector();
  const clock = () => new Date();
  const attemptRunner = new AppRunAttemptRunner(
    repository,
    secretRepository,
    secrets,
    new PinnedMcpAppRunProviderExecutor(),
    liveAuthorization,
    clock,
    60_000,
    20_000,
    receipts,
    attention,
    postgresAppRunAttemptQueue,
  );
  const service = new AppRunService(
    repository,
    secretRepository,
    secrets,
    keys,
    accessAuthorization,
    clock,
    postgresAppRunApprovalAdapter,
    receipts,
    attention,
    attemptRunner,
    inputPreparation,
    liveAuthorization,
    () => APP_RUN_APP_ORIGIN_ENABLED,
  );
  const approvalResolver = new PostgresAppRunApprovalResolver(
    repository,
    liveAuthorization,
    clock,
    receipts,
    attention,
    attemptRunner,
  );
  const operations = new AppRunOperationsService(
    repository,
    postgresAppRunReadOperationsAuthorizer,
    receipts,
    attention,
    clock,
  );

  try {
    await service.assertReferencedKeysAvailable();
  } catch (error) {
    keys.destroy();
    throw error;
  }

  return Object.freeze({
    keys,
    repository,
    secretRepository,
    inputPreparation,
    liveAuthorization,
    service,
    attemptRunner,
    approvalResolver,
    receiptReader,
    operations,
  });
}

/** One process-wide composition root. The exact flag is checked again at the
 * call boundary so imports alone cannot activate governed execution. */
export async function getAppRunRuntime(): Promise<AppRunRuntime> {
  if (!APP_RUNS_ENABLED) throw new AppRunError('APP_RUNS_DISABLED');
  runtimePromise ??= createAppRunRuntime().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

export async function shutdownAppRunRuntime(): Promise<void> {
  const pending = runtimePromise;
  runtimePromise = null;
  if (!pending) return;
  try {
    const runtime = await pending;
    runtime.keys.destroy();
  } catch {
    // A failed composition already destroys any parsed key material.
  }
}
