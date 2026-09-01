import { createHash } from 'node:crypto';
import { appRunReceipts, appRuns } from '@deft/db/schema';
import {
  APP_RUN_CONTRACT_VERSIONS,
  canonicalCapabilityJson,
  parseAppRunReceiptEnvelope,
  type AppRunActor,
  type AppRunReceiptKind,
  type AppRunSafeMetadata,
} from '@deft/shared';
import { and, asc, eq } from 'drizzle-orm';
import { AppRunError } from './app-run-errors.js';
import { db } from './db.js';
import type { AppRunSafeView, AppRunTransaction } from './app-run-repository.js';
import type { AppRunSecretRepository } from './app-run-secret-repository.js';
import type { AppRunSecretService } from './app-run-secrets.js';

export type AppRunReceiptWrite = Readonly<{
  receipt_key: string;
  receipt_kind: AppRunReceiptKind;
  run: AppRunSafeView;
  attempt_id?: string;
  actor?: AppRunActor;
  facts?: AppRunSafeMetadata;
  occurred_at: Date;
}>;

export interface AppRunReceiptWriter {
  write(tx: AppRunTransaction, input: AppRunReceiptWrite): Promise<void>;
}

export type AppRunVerifiedReceiptView = Readonly<{
  receipt_id: string;
  receipt_kind: AppRunReceiptKind;
  run_state: AppRunSafeView['state'];
  occurred_at: string;
  envelope_digest: string;
  signing_key_version: string;
  signed_at: string;
  verified: true;
}>;

export interface AppRunReceiptReader {
  readVerified(orgId: string, runId: string): Promise<readonly AppRunVerifiedReceiptView[]>;
}

export type AppRunStoredReceiptRow = typeof appRunReceipts.$inferSelect;

export interface AppRunReceiptRowSource {
  list(orgId: string, runId: string): Promise<readonly AppRunStoredReceiptRow[]>;
}

export const noOpAppRunReceiptWriter: AppRunReceiptWriter = Object.freeze({
  async write() {},
});

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalCapabilityJson(value))
    .digest('hex')}`;
}

function receiptId(orgId: string, runId: string, receiptKey: string): string {
  return `app-run-receipt:${createHash('sha256')
    .update('deft.app_run_receipt_id.v1\0')
    .update(orgId)
    .update('\0')
    .update(runId)
    .update('\0')
    .update(receiptKey)
    .digest('hex')}`;
}

function verifiedReceiptView(
  row: AppRunStoredReceiptRow,
  expectedOrgId: string,
  expectedRunId: string,
  secrets: AppRunSecretService,
): AppRunVerifiedReceiptView {
  let envelope: ReturnType<typeof parseAppRunReceiptEnvelope>;
  try {
    envelope = parseAppRunReceiptEnvelope(row.envelope);
  } catch {
    throw new AppRunError('APP_RUN_REPAIR_REQUIRED');
  }
  const expectedReceiptId = receiptId(expectedOrgId, expectedRunId, row.receipt_key);
  if (
    row.org_id !== expectedOrgId
    || row.run_id !== expectedRunId
    || row.receipt_version !== APP_RUN_CONTRACT_VERSIONS.receipt
    || row.id !== expectedReceiptId
    || envelope.receipt_id !== row.id
    || envelope.receipt_kind !== row.receipt_kind
    || envelope.org_id !== expectedOrgId
    || envelope.run_id !== expectedRunId
    || (envelope.attempt_id ?? null) !== row.attempt_id
    || envelope.occurred_at !== row.signed_at.toISOString()
    || row.envelope_digest !== sha256(envelope)
    || !secrets.verifyReceipt(envelope, row.signing_key_version, row.signature_hmac)
  ) throw new AppRunError('APP_RUN_REPAIR_REQUIRED');

  return Object.freeze({
    receipt_id: row.id,
    receipt_kind: envelope.receipt_kind,
    run_state: envelope.run_state,
    occurred_at: envelope.occurred_at,
    envelope_digest: row.envelope_digest,
    signing_key_version: row.signing_key_version,
    signed_at: row.signed_at.toISOString(),
    verified: true as const,
  });
}

const postgresAppRunReceiptRows: AppRunReceiptRowSource = Object.freeze({
  async list(orgId: string, runId: string) {
    return db.select().from(appRunReceipts).where(and(
      eq(appRunReceipts.org_id, orgId),
      eq(appRunReceipts.run_id, runId),
    )).orderBy(asc(appRunReceipts.signed_at), asc(appRunReceipts.id));
  },
});

export class PostgresAppRunReceiptReader implements AppRunReceiptReader {
  constructor(
    private readonly secrets: AppRunSecretService,
    private readonly rows: AppRunReceiptRowSource = postgresAppRunReceiptRows,
  ) {}

  async readVerified(orgId: string, runId: string): Promise<readonly AppRunVerifiedReceiptView[]> {
    const rows = await this.rows.list(orgId, runId);
    return Object.freeze(rows.map((row) => verifiedReceiptView(row, orgId, runId, this.secrets)));
  }
}

export class PostgresAppRunReceiptWriter implements AppRunReceiptWriter {
  constructor(
    private readonly secrets: AppRunSecretService,
    private readonly secretRepository: AppRunSecretRepository,
  ) {}

  async write(tx: AppRunTransaction, input: AppRunReceiptWrite): Promise<void> {
    if (
      !input.receipt_key
      || input.receipt_key !== input.receipt_key.trim()
      || Buffer.byteLength(input.receipt_key, 'utf8') > 512
    ) throw new AppRunError('APP_RUN_REPAIR_REQUIRED');
    if (input.receipt_kind === 'attempt_terminal' && !input.attempt_id) {
      throw new AppRunError('APP_RUN_REPAIR_REQUIRED');
    }

    const [internal] = await tx.select({
      input_fingerprint_key_version: appRuns.input_fingerprint_key_version,
      input_fingerprint: appRuns.input_fingerprint,
    }).from(appRuns).where(and(
      eq(appRuns.org_id, input.run.org_id),
      eq(appRuns.id, input.run.id),
    )).limit(1);
    if (!internal) throw new AppRunError('APP_RUN_REPAIR_REQUIRED');

    const outputEnvelopeDigest = input.attempt_id
      ? await this.secretRepository.outputEnvelopeDigest(
        tx,
        input.run.org_id,
        input.run.id,
        input.attempt_id,
      )
      : undefined;
    const id = receiptId(input.run.org_id, input.run.id, input.receipt_key);
    const envelope = parseAppRunReceiptEnvelope({
      schema_version: APP_RUN_CONTRACT_VERSIONS.receipt,
      receipt_id: id,
      receipt_kind: input.receipt_kind,
      org_id: input.run.org_id,
      run_id: input.run.id,
      ...(input.attempt_id ? { attempt_id: input.attempt_id } : {}),
      run_state: input.run.state,
      ...(input.actor ? { actor: input.actor } : {}),
      operation: {
        provider: {
          org_id: input.run.org_id,
          provider_kind: input.run.provider_kind,
          provider_instance_id: input.run.provider_instance_id,
        },
        operation_name: input.run.operation_name,
      },
      policy: {
        risk_class: input.run.risk_class,
        review_requirement: input.run.review_requirement,
        review_scope: input.run.review_scope,
        retry_class: input.run.retry_class,
      },
      input_fingerprint: {
        key_version: internal.input_fingerprint_key_version,
        fingerprint: internal.input_fingerprint,
      },
      ...(outputEnvelopeDigest ? { output_envelope_digest: outputEnvelopeDigest } : {}),
      facts: input.facts ?? {},
      occurred_at: input.occurred_at.toISOString(),
    });
    const envelopeDigest = sha256(envelope);
    const signature = this.secrets.signReceipt(envelope);
    const [created] = await tx.insert(appRunReceipts).values({
      id,
      org_id: input.run.org_id,
      run_id: input.run.id,
      attempt_id: input.attempt_id ?? null,
      receipt_key: input.receipt_key,
      receipt_kind: input.receipt_kind,
      envelope,
      envelope_digest: envelopeDigest,
      signing_key_version: signature.key_version,
      signature_hmac: signature.signature_hmac,
      signed_at: input.occurred_at,
      created_at: input.occurred_at,
    }).onConflictDoNothing().returning({ id: appRunReceipts.id });
    if (created) return;

    const [existing] = await tx.select().from(appRunReceipts).where(and(
      eq(appRunReceipts.org_id, input.run.org_id),
      eq(appRunReceipts.run_id, input.run.id),
      eq(appRunReceipts.receipt_key, input.receipt_key),
    )).limit(1);
    if (
      !existing
      || existing.envelope_digest !== envelopeDigest
      || canonicalCapabilityJson(existing.envelope) !== canonicalCapabilityJson(envelope)
      || !this.secrets.verifyReceipt(
        existing.envelope,
        existing.signing_key_version,
        existing.signature_hmac,
      )
    ) throw new AppRunError('APP_RUN_REPAIR_REQUIRED');
  }

  async verifyStored(orgId: string, runId: string, receiptKey: string): Promise<boolean> {
    const [receipt] = await db.select().from(appRunReceipts).where(and(
      eq(appRunReceipts.org_id, orgId),
      eq(appRunReceipts.run_id, runId),
      eq(appRunReceipts.receipt_key, receiptKey),
    )).limit(1);
    if (!receipt) return false;
    try {
      verifiedReceiptView(receipt, orgId, runId, this.secrets);
      return true;
    } catch {
      return false;
    }
  }
}
