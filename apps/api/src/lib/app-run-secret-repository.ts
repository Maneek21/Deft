import { createHash } from 'node:crypto';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { appRunEvents, appRunReceipts, appRuns, appRunSecretPayloads } from '@deft/db/schema';
import { canonicalCapabilityJson, type CapabilityJsonValue } from '@deft/shared';
import { db } from './db.js';
import type { AppRunTransaction } from './app-run-repository.js';
import {
  AppRunSecretService,
  type AppRunSecretEnvelope,
} from './app-run-secrets.js';

function payloadBytes(envelope: AppRunSecretEnvelope): number {
  const bytes = Buffer.from(envelope.ciphertext_b64, 'base64');
  try {
    return bytes.length;
  } finally {
    bytes.fill(0);
  }
}

function envelopeFromRow(row: typeof appRunSecretPayloads.$inferSelect): AppRunSecretEnvelope {
  return {
    schema_version: row.envelope_version as AppRunSecretEnvelope['schema_version'],
    algorithm: row.algorithm,
    key_version: row.key_version,
    nonce_b64: row.nonce_b64,
    ciphertext_b64: row.ciphertext_b64,
    auth_tag_b64: row.auth_tag_b64,
  };
}

export class AppRunSecretRepository {
  constructor(private readonly secrets: AppRunSecretService) {}

  async insertInput(
    tx: AppRunTransaction,
    input: Readonly<{ org_id: string; run_id: string; value: unknown; expires_at: Date }>,
  ): Promise<void> {
    const envelope = this.secrets.sealJson(input.value, {
      org_id: input.org_id,
      run_id: input.run_id,
      payload_kind: 'input',
    });
    await tx.insert(appRunSecretPayloads).values({
      id: crypto.randomUUID(),
      org_id: input.org_id,
      run_id: input.run_id,
      payload_kind: 'input',
      envelope_version: envelope.schema_version,
      algorithm: envelope.algorithm,
      key_version: envelope.key_version,
      nonce_b64: envelope.nonce_b64,
      ciphertext_b64: envelope.ciphertext_b64,
      auth_tag_b64: envelope.auth_tag_b64,
      payload_bytes: payloadBytes(envelope),
      expires_at: input.expires_at,
    });
  }

  async insertOutput(
    tx: AppRunTransaction,
    input: Readonly<{
      org_id: string;
      run_id: string;
      attempt_id: string;
      value: unknown;
      expires_at: Date;
    }>,
  ): Promise<void> {
    const envelope = this.secrets.sealJson(input.value, {
      org_id: input.org_id,
      run_id: input.run_id,
      attempt_id: input.attempt_id,
      payload_kind: 'output',
    });
    await tx.insert(appRunSecretPayloads).values({
      id: crypto.randomUUID(),
      org_id: input.org_id,
      run_id: input.run_id,
      attempt_id: input.attempt_id,
      payload_kind: 'output',
      envelope_version: envelope.schema_version,
      algorithm: envelope.algorithm,
      key_version: envelope.key_version,
      nonce_b64: envelope.nonce_b64,
      ciphertext_b64: envelope.ciphertext_b64,
      auth_tag_b64: envelope.auth_tag_b64,
      payload_bytes: payloadBytes(envelope),
      expires_at: input.expires_at,
    });
  }

  async readInput(orgId: string, runId: string): Promise<CapabilityJsonValue | null> {
    const [row] = await db.select().from(appRunSecretPayloads).where(and(
      eq(appRunSecretPayloads.org_id, orgId),
      eq(appRunSecretPayloads.run_id, runId),
      eq(appRunSecretPayloads.payload_kind, 'input'),
    )).limit(1);
    if (!row) return null;
    return this.secrets.openJson(envelopeFromRow(row), {
      org_id: orgId,
      run_id: runId,
      payload_kind: 'input',
    });
  }

  async readOutput(orgId: string, runId: string, attemptId: string): Promise<CapabilityJsonValue | null> {
    const [row] = await db.select().from(appRunSecretPayloads).where(and(
      eq(appRunSecretPayloads.org_id, orgId),
      eq(appRunSecretPayloads.run_id, runId),
      eq(appRunSecretPayloads.attempt_id, attemptId),
      eq(appRunSecretPayloads.payload_kind, 'output'),
    )).limit(1);
    if (!row) return null;
    return this.secrets.openJson(envelopeFromRow(row), {
      org_id: orgId,
      run_id: runId,
      attempt_id: attemptId,
      payload_kind: 'output',
    });
  }

  async outputEnvelopeDigest(
    tx: AppRunTransaction,
    orgId: string,
    runId: string,
    attemptId: string,
  ): Promise<string | undefined> {
    const [row] = await tx.select({
      envelope_version: appRunSecretPayloads.envelope_version,
      algorithm: appRunSecretPayloads.algorithm,
      key_version: appRunSecretPayloads.key_version,
      nonce_b64: appRunSecretPayloads.nonce_b64,
      ciphertext_b64: appRunSecretPayloads.ciphertext_b64,
      auth_tag_b64: appRunSecretPayloads.auth_tag_b64,
    }).from(appRunSecretPayloads).where(and(
      eq(appRunSecretPayloads.org_id, orgId),
      eq(appRunSecretPayloads.run_id, runId),
      eq(appRunSecretPayloads.attempt_id, attemptId),
      eq(appRunSecretPayloads.payload_kind, 'output'),
    )).limit(1);
    return row
      ? `sha256:${createHash('sha256').update(canonicalCapabilityJson(row)).digest('hex')}`
      : undefined;
  }

  async retainedKeyReferences(
    now: Date,
    orgId?: string,
  ): Promise<readonly { purpose: 'run_encryption'; key_id: string }[]> {
    const rows = await db.selectDistinct({ key_id: appRunSecretPayloads.key_version })
      .from(appRunSecretPayloads)
      .where(and(
        sql`${appRunSecretPayloads.expires_at} > ${now}`,
        ...(orgId ? [eq(appRunSecretPayloads.org_id, orgId)] : []),
      ));
    return rows.map((row) => ({ purpose: 'run_encryption' as const, key_id: row.key_id }));
  }

  async receiptSigningKeyReferences(orgId?: string): Promise<readonly {
    purpose: 'receipt_signing';
    key_id: string;
  }[]> {
    const rows = await db.selectDistinct({ key_id: appRunReceipts.signing_key_version })
      .from(appRunReceipts)
      .where(orgId ? eq(appRunReceipts.org_id, orgId) : undefined);
    return rows.map((row) => ({ purpose: 'receipt_signing' as const, key_id: row.key_id }));
  }

  async purgeExpiredBatch(now = new Date(), limit = 100): Promise<number> {
    const candidates = await db.select({
      org_id: appRunSecretPayloads.org_id,
      run_id: appRunSecretPayloads.run_id,
    }).from(appRunSecretPayloads)
      .where(lte(appRunSecretPayloads.expires_at, now))
      .groupBy(appRunSecretPayloads.org_id, appRunSecretPayloads.run_id)
      .orderBy(asc(appRunSecretPayloads.run_id))
      .limit(Math.max(1, Math.min(limit, 500)));
    let purged = 0;
    for (const candidate of candidates) {
      purged += await this.#purgeRun(candidate.org_id, candidate.run_id, now);
    }
    return purged;
  }

  async #purgeRun(orgId: string, runId: string, now: Date): Promise<number> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM app_runs WHERE org_id = ${orgId} AND id = ${runId} FOR UPDATE`);
      const expired = await tx.select({
        id: appRunSecretPayloads.id,
        payload_kind: appRunSecretPayloads.payload_kind,
      }).from(appRunSecretPayloads).where(and(
        eq(appRunSecretPayloads.org_id, orgId),
        eq(appRunSecretPayloads.run_id, runId),
        lte(appRunSecretPayloads.expires_at, now),
      ));
      if (expired.length === 0) return 0;

      await tx.execute(sql`SELECT set_config('deft.app_run_maintenance', 'on', true)`);
      await tx.delete(appRunSecretPayloads).where(and(
        eq(appRunSecretPayloads.org_id, orgId),
        eq(appRunSecretPayloads.run_id, runId),
        lte(appRunSecretPayloads.expires_at, now),
      ));

      const purgedInput = expired.some((row) => row.payload_kind === 'input');
      const purgedOutput = expired.some((row) => row.payload_kind === 'output');
      const [run] = await tx.select({ state: appRuns.state, safe_outcome: appRuns.safe_outcome })
        .from(appRuns).where(and(eq(appRuns.org_id, orgId), eq(appRuns.id, runId))).limit(1);
      const shouldExpire = purgedInput && (run?.state === 'pending' || run?.state === 'pending_approval');
      const safeOutcome = purgedOutput && run?.safe_outcome
        ? { ...run.safe_outcome, result_status: 'expired' }
        : run?.safe_outcome;
      await tx.update(appRuns).set({
        state: shouldExpire ? 'expired' : run?.state,
        safe_outcome: safeOutcome,
        input_purged_at: purgedInput ? now : undefined,
        result_purged_at: purgedOutput ? now : undefined,
        terminal_at: shouldExpire ? now : undefined,
        updated_at: now,
      }).where(and(eq(appRuns.org_id, orgId), eq(appRuns.id, runId)));

      const [sequenceRow] = await tx.select({
        next: sql<number>`COALESCE(MAX(${appRunEvents.sequence}), 0)::int + 1`,
      }).from(appRunEvents).where(and(
        eq(appRunEvents.org_id, orgId), eq(appRunEvents.run_id, runId),
      ));
      await tx.insert(appRunEvents).values({
        id: crypto.randomUUID(), org_id: orgId, run_id: runId,
        sequence: sequenceRow?.next ?? 1,
        event_type: 'secrets_purged',
        payload: { input_purged: purgedInput, result_purged: purgedOutput },
        created_at: now,
      });
      return expired.length;
    });
  }
}
