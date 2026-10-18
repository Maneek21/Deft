import { createBoundedAppRunDatabase } from './app-run-bounded-db.js';
import { PostgresAppRunRepository, type AppRunTransaction } from './app-run-repository.js';
import { AppRunSecretService } from './app-run-secrets.js';
import { AppRunSecretRepository } from './app-run-secret-repository.js';
import { PostgresAppRunReceiptWriter } from './app-run-receipts.js';
import { PostgresAppRunAttentionProjector } from './app-run-attention.js';
import { AppRunAttemptRunner } from './app-run-attempt-runner.js';
import { postgresAppRunAttemptQueue } from './app-run-scheduler.js';
import { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';
import { AppResourceSyncStore } from './app-resource-sync-store.js';
import { AppResourceSyncAdmissionService } from './app-resource-sync-admission.js';
import { AppAttachmentPageLinker } from './app-attachment-page-linker.js';
import { AppAttachmentCustodyService } from './app-attachment-custody.js';
import { LocalAppAttachmentObjectStore } from './app-attachment-object-store.js';
import { AppAttachmentOwnerService } from './app-attachment-owner.js';
import { AppAttachmentSyncChannel } from './app-attachment-sync-channel.js';
import { assertAttachmentBrokerEnabled } from './app-attachment-authority.js';
import { AppResourceSyncManagement } from './app-resource-sync-management.js';
import { env, isAppAttachmentBrokerEnabled } from './env.js';
import { assertAppRunReferencedKeysAvailable, AppRunKeyVersionUnavailableError } from './app-run-keyrings.js';
import { AppRunError } from './app-run-errors.js';
import { listAppAttachmentKeyReferences } from './app-attachment-key-references.js';

type Database = ReturnType<typeof createBoundedAppRunDatabase>;
class AttachmentRunRepository extends PostgresAppRunRepository {
  constructor(private readonly bounded: Database) { super(); }
  override transaction<T>(work: (tx: AppRunTransaction) => Promise<T>): Promise<T> {
    assertAttachmentBrokerEnabled();
    return this.bounded.transaction(work,new AbortController().signal,performance.now()+10_000);
  }
}

async function createAttachmentRuntime() {
  // No keyring, pool or filesystem allocation occurs on a default-off host.
  assertAttachmentBrokerEnabled();
  const { keys } = await (await import('./app-run-runtime.js')).getAppRunRuntime();
  assertAttachmentBrokerEnabled();
  const database=createBoundedAppRunDatabase(env.DATABASE_URL,{max:2,application_name:'deft-app-attachments'});
  try {
    assertAppRunReferencedKeysAvailable(keys,await database.transaction(tx=>listAppAttachmentKeyReferences(tx),new AbortController().signal,performance.now()+10_000));
    assertAttachmentBrokerEnabled();
    const repository=new AttachmentRunRepository(database);
    const secrets=new AppRunSecretService(keys);
    const inputs=new AppRunSecretRepository(secrets);
    const syncSecrets=new AppResourceSyncSecretService(keys);
    const objects=new LocalAppAttachmentObjectStore();
    const linker=new AppAttachmentPageLinker(keys);
    const store=new AppResourceSyncStore(syncSecrets,inputs,{linker});
    const receipts=new PostgresAppRunReceiptWriter(secrets,inputs);
    const runner=new AppRunAttemptRunner(repository,inputs,secrets,{
      async execute() { throw new Error('Attachment channel cannot execute a provider'); },
    },undefined,()=>new Date(),60_000,20_000,receipts,new PostgresAppRunAttentionProjector(),
    postgresAppRunAttemptQueue,store,'attachment_v3');
    const admission=new AppResourceSyncAdmissionService(repository,inputs,secrets,syncSecrets,runner,
      ()=>new Date(),isAppAttachmentBrokerEnabled,'attachment_v3');
    // This single process-wide instance owns the max2 transfer limiter. Routes
    // obtain this runtime; they must never construct a custody service per call.
    const custody=new AppAttachmentCustodyService(database,keys,objects);
    return Object.freeze({database,repository,keys,objects,custody,runner,admission,
      owner:new AppAttachmentOwnerService(database,keys,objects,custody),
      management:new AppResourceSyncManagement(keys,()=>new Date(),'attachment_v3'),
      channel:new AppAttachmentSyncChannel(runner,database)});
  } catch(error) { await database.close(); throw error; }
}
let pending: ReturnType<typeof createAttachmentRuntime>|null=null;
export function getAppAttachmentRuntime() {
  assertAttachmentBrokerEnabled();
  pending ??=createAttachmentRuntime().catch(error=>{
    pending=null;
    if(error instanceof AppRunKeyVersionUnavailableError) {
      throw new AppRunError('APP_RUN_KEY_VERSION_UNAVAILABLE');
    }
    throw error;
  });
  return pending;
}
export async function shutdownAppAttachmentRuntime(): Promise<void> {
  const current=pending; pending=null;
  if(current) await (await current).database.close();
}
