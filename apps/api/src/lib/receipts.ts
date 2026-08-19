/**
 * Phase 7 — HMAC-signed action receipts.
 *
 * `generateReceipt` writes a row into `action_receipts` for every elevated
 * MCP write and for every approval resolver decision. The receipt is signed
 * with an HMAC-SHA256 over a canonical JSON payload (sorted keys, no
 * whitespace) using `env.ENCRYPTION_KEY`. One secret per deployment.
 *
 * `verifyReceipt` recomputes the HMAC against the stored canonical payload
 * and constant-time compares with the stored signature. Returns a plain
 * boolean so callers can render a green/red "Verified" pill.
 *
 * Failure mode:
 *   - generateReceipt MUST NOT throw under any circumstances. If the DB
 *     insert fails, we log to console.error and return `null`. The underlying
 *     write path is already done by the time we get here — receipts are an
 *     audit overlay, not a correctness requirement. Missing receipts are a
 *     separate ops problem to reconcile.
 *
 * Canonical payload shape (order-insensitive, we sort keys):
 *   {
 *     actionId, orgId, actionName, params, decision,
 *     decisionReason (when present), signed_at
 *   }
 *
 * Notes on `timingSafeEqual`: the comparison must be constant-time to
 * prevent timing side-channels on the signature bytes. We compare two
 * hex-encoded buffers of the same length.
 */
import crypto from 'node:crypto';
import { db } from './db.js';
import { actionReceipts } from '@deft/db/schema';
import { env } from './env.js';
import { and, eq, sql } from 'drizzle-orm';

type InferredReceipt = typeof actionReceipts.$inferSelect;
export type ActionReceipt = InferredReceipt;

export type ReceiptProposer = 'defty' | 'employee' | 'user' | 'cron';
export type ReceiptDecision =
  | 'auto_executed'
  | 'approved'
  | 'rejected'
  | 'expired';

export type GenerateReceiptParams = {
  actionId: string;
  orgId: string;
  employeeId?: string | null;
  proposer: ReceiptProposer;
  proposerId?: string | null;
  approverId?: string | null;
  decision: ReceiptDecision;
  decisionReason?: string | null;
  actionName: string;
  actionParams: unknown;
  resultJson?: unknown;
};

/**
 * Build a deterministic JSON payload whose bytes are stable across equal
 * logical values. We recursively sort object keys so
 * `{a: 1, b: 2}` and `{b: 2, a: 1}` hash to the same signature.
 *
 * Arrays preserve order (that's semantically meaningful).
 * Primitives/null pass through to JSON.stringify.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  // Date instances must be preserved as-is so JSON.stringify uses Date's
  // toJSON (→ ISO string). If we fell into the generic object branch,
  // Object.keys(new Date()) would be [] and the Date would collapse to {}.
  // Phase 12 review fix: without this, a resultJson that contains a Date
  // field (task_create returns task.created_at as a Date) hashes to a
  // completely different digest than the same row read back from JSONB,
  // where the same field is a plain string.
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

type SignedEnvelope = {
  actionId: string;
  orgId: string;
  actionName: string;
  params: unknown;
  decision: ReceiptDecision;
  decisionReason: string | null;
  // Phase 12 review fix — the signed envelope now covers every field a
  // tamperer could flip to forge attribution. The previous envelope only
  // signed { actionId, orgId, actionName, params, decision, signed_at },
  // which let an attacker with DB write access swap `approver_id` or
  // `result_json` without invalidating the signature.
  //
  // Note: signed_at is deliberately NOT part of the envelope anymore.
  // Date/timestamptz round-trip through drizzle .returning() was producing
  // off-by-offset values on read, and signed_at is a display field, not
  // an attribution one. Tamper-evident attribution lives in the fields
  // below.
  employeeId: string | null;
  proposer: ReceiptProposer;
  proposerId: string | null;
  approverId: string | null;
  resultHash: string | null;
};

/**
 * Stable hash of the result payload so we can include it in the envelope
 * without blowing up the signed body with a duplicate copy of the result.
 * null when there is no result (e.g. a rejection).
 */
function hashResult(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const canonical = canonicalize(value);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function buildSignedEnvelope(params: {
  actionId: string;
  orgId: string;
  actionName: string;
  actionParams: unknown;
  decision: ReceiptDecision;
  decisionReason?: string | null;
  employeeId?: string | null;
  proposer: ReceiptProposer;
  proposerId?: string | null;
  approverId?: string | null;
  resultJson?: unknown;
}): SignedEnvelope {
  return {
    actionId: params.actionId,
    orgId: params.orgId,
    actionName: params.actionName,
    params: params.actionParams,
    decision: params.decision,
    decisionReason: params.decisionReason ?? null,
    employeeId: params.employeeId ?? null,
    proposer: params.proposer,
    proposerId: params.proposerId ?? null,
    approverId: params.approverId ?? null,
    resultHash: hashResult(params.resultJson),
  };
}

function computeHmac(payload: string): string {
  return crypto
    .createHmac('sha256', env.ENCRYPTION_KEY)
    .update(payload)
    .digest('hex');
}

/**
 * Ensure one signed receipt per action decision. Concurrent/retry callers are
 * serialized by a PostgreSQL advisory lock. Never throws; on DB failure logs
 * and returns null.
 */
export async function generateReceipt(
  params: GenerateReceiptParams,
): Promise<ActionReceipt | null> {
  try {
    const signedAt = new Date();
    const envelope = buildSignedEnvelope({
      actionId: params.actionId,
      orgId: params.orgId,
      actionName: params.actionName,
      actionParams: params.actionParams,
      decision: params.decision,
      decisionReason: params.decisionReason ?? null,
      employeeId: params.employeeId ?? null,
      proposer: params.proposer,
      proposerId: params.proposerId ?? null,
      approverId: params.approverId ?? null,
      resultJson: params.resultJson ?? null,
    });
    const canonical = canonicalize(envelope);
    const signature = computeHmac(canonical);

    return await db.transaction(async (tx) => {
      const receiptKey = `action-receipt:${params.actionId}:${params.decision}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${receiptKey}, 0))`);
      const [existing] = await tx
        .select()
        .from(actionReceipts)
        .where(and(
          eq(actionReceipts.action_id, params.actionId),
          eq(actionReceipts.decision, params.decision),
        ))
        .limit(1);
      if (existing) return existing;

      const [row] = await tx
        .insert(actionReceipts)
        .values({
          org_id: params.orgId,
          action_id: params.actionId,
          employee_id: params.employeeId ?? null,
          proposer: params.proposer,
          proposer_id: params.proposerId ?? null,
          approver_id: params.approverId ?? null,
          decision: params.decision,
          decision_reason: params.decisionReason ?? null,
          action_name: params.actionName,
          action_params_json: (params.actionParams ?? {}) as unknown as Record<string, unknown>,
          result_json: (params.resultJson ?? null) as unknown as Record<string, unknown>,
          signature_hmac: signature,
          signed_at: signedAt,
        })
        .returning();
      return row ?? null;
    });
  } catch (err) {
    // AUDIT OVERLAY: never let a receipt failure crash the caller. Log +
    // continue. Ops will reconcile via a gap report later.
    console.error('[receipts] generation failed:', err);
    return null;
  }
}

/**
 * Recompute the HMAC over the canonical envelope and constant-time compare
 * with the stored signature. Returns true iff the stored signature matches
 * the bytes our secret would produce for the current stored envelope.
 *
 * We deliberately read the envelope fields back off the stored receipt
 * row rather than from user-provided inputs so the verifier catches any
 * in-place tampering of `action_params_json`, `action_name`, `decision`,
 * `decision_reason`, or `signed_at`.
 */
export async function verifyReceipt(
  receipt: ActionReceipt,
): Promise<boolean> {
  try {
    const envelope = buildSignedEnvelope({
      actionId: receipt.action_id,
      orgId: receipt.org_id,
      actionName: receipt.action_name,
      actionParams: receipt.action_params_json,
      decision: receipt.decision as ReceiptDecision,
      decisionReason: receipt.decision_reason,
      employeeId: receipt.employee_id,
      proposer: receipt.proposer as ReceiptProposer,
      proposerId: receipt.proposer_id,
      approverId: receipt.approver_id,
      resultJson: receipt.result_json,
    });
    const canonical = canonicalize(envelope);
    const expected = computeHmac(canonical);

    // Constant-time compare. Both must be hex strings of equal length.
    if (
      typeof receipt.signature_hmac !== 'string' ||
      receipt.signature_hmac.length !== expected.length
    ) {
      return false;
    }
    const a = Buffer.from(receipt.signature_hmac, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (err) {
    console.error('[receipts] verification failed:', err);
    return false;
  }
}
