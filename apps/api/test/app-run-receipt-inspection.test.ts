import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';

import { APP_RUN_CONTRACT_VERSIONS, canonicalCapabilityJson } from '@deft/shared';

import {
  AppActionService,
  type AppActionCaller,
  type AppActionLiveAuthorityPort,
  type AppActionRunReadPort,
} from '../src/lib/app-action-service.js';
import { closeDb } from '../src/lib/db.js';
import { AppRunError } from '../src/lib/app-run-errors.js';
import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import {
  PostgresAppRunReceiptReader,
  type AppRunReceiptReader,
  type AppRunStoredReceiptRow,
} from '../src/lib/app-run-receipts.js';
import type { AppRunSafeView } from '../src/lib/app-run-repository.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { humanModuleActor } from '../src/lib/module-service.js';

after(async () => closeDb());

const ORG_ID = 'receipt-inspection-org';
const RUN_ID = 'receipt-inspection-run';
const RECEIPT_KEY = 'approval:action-1';
const OCCURRED_AT = '2026-09-01T12:00:00.000Z';

function key(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64');
}

function keyringConfig(): string {
  return JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key(1) } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key(2) } },
    fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key(3) } },
  });
}

function receiptId(orgId = ORG_ID, runId = RUN_ID, receiptKey = RECEIPT_KEY): string {
  return `app-run-receipt:${createHash('sha256')
    .update('deft.app_run_receipt_id.v1\0')
    .update(orgId)
    .update('\0')
    .update(runId)
    .update('\0')
    .update(receiptKey)
    .digest('hex')}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalCapabilityJson(value)).digest('hex')}`;
}

function storedReceipt(
  secrets: AppRunSecretService,
  envelopeOverrides: Record<string, unknown> = {},
): AppRunStoredReceiptRow {
  const envelope = {
    schema_version: APP_RUN_CONTRACT_VERSIONS.receipt,
    receipt_id: receiptId(),
    receipt_kind: 'approval' as const,
    org_id: ORG_ID,
    run_id: RUN_ID,
    run_state: 'pending_approval' as const,
    actor: { actor_type: 'human' as const, user_id: 'forbidden-actor-id' },
    operation: {
      provider: {
        org_id: ORG_ID,
        provider_kind: 'mcp' as const,
        provider_instance_id: 'forbidden-provider-instance',
      },
      operation_name: 'send_email',
    },
    policy: {
      risk_class: 'external_write' as const,
      review_requirement: 'always' as const,
      review_scope: 'per_invocation' as const,
      retry_class: 'idempotent_with_key' as const,
    },
    input_fingerprint: {
      key_version: 'fp-v1',
      fingerprint: `hmac-sha256:${'1'.repeat(64)}`,
    },
    output_envelope_digest: `sha256:${'2'.repeat(64)}`,
    facts: { private_marker: 'forbidden-fact' },
    occurred_at: OCCURRED_AT,
    ...envelopeOverrides,
  };
  const signature = secrets.signReceipt(envelope);
  return {
    id: receiptId(),
    org_id: ORG_ID,
    run_id: RUN_ID,
    attempt_id: null,
    receipt_version: APP_RUN_CONTRACT_VERSIONS.receipt,
    receipt_key: RECEIPT_KEY,
    receipt_kind: 'approval',
    envelope,
    envelope_digest: digest(envelope),
    signing_key_version: signature.key_version,
    signature_hmac: signature.signature_hmac,
    signed_at: new Date(OCCURRED_AT),
    created_at: new Date(OCCURRED_AT),
  };
}

test('receipt reader verifies every row and returns only the bounded safe projection', async () => {
  const keys = parseEnvironmentAppRunKeyrings(keyringConfig());
  const secrets = new AppRunSecretService(keys);
  const row = storedReceipt(secrets);
  const reader = new PostgresAppRunReceiptReader(secrets, {
    async list(orgId, runId) {
      assert.equal(orgId, ORG_ID);
      assert.equal(runId, RUN_ID);
      return [row];
    },
  });

  const projected = await reader.readVerified(ORG_ID, RUN_ID);
  assert.deepEqual(projected, [{
    receipt_id: row.id,
    receipt_kind: 'approval',
    run_state: 'pending_approval',
    occurred_at: OCCURRED_AT,
    envelope_digest: row.envelope_digest,
    signing_key_version: 'sig-v1',
    signed_at: OCCURRED_AT,
    verified: true,
  }]);
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    ORG_ID,
    'forbidden-actor-id',
    'forbidden-provider-instance',
    'forbidden-fact',
    row.signature_hmac,
    'output_envelope_digest',
    'input_fingerprint',
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden));

  for (const invalid of [
    { ...row, envelope_digest: `sha256:${'0'.repeat(64)}` },
    { ...row, signature_hmac: `hmac-sha256:${'0'.repeat(64)}` },
    storedReceipt(secrets, { run_id: 'different-run' }),
  ]) {
    const failClosed = new PostgresAppRunReceiptReader(secrets, {
      async list() { return [row, invalid]; },
    });
    await assert.rejects(
      () => failClosed.readVerified(ORG_ID, RUN_ID),
      (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_REPAIR_REQUIRED',
    );
  }
  keys.destroy();
});

test('AppActionService authorizes through Run inspection before reading receipts and redacts the Run', async () => {
  const order: string[] = [];
  const forbiddenOrg = 'forbidden-org-id';
  const forbiddenActor = 'forbidden-actor-id';
  const forbiddenProvider = 'forbidden-provider-instance';
  const runReads: AppActionRunReadPort = {
    async inspect(orgId, runId, actor, requiredAuthorityRef) {
      order.push('inspect');
      assert.equal(orgId, ORG_ID);
      assert.equal(runId, RUN_ID);
      assert.deepEqual(actor, { actor_type: 'human', user_id: 'receipt-reader-user' });
      assert.equal(requiredAuthorityRef, null);
      return {
        id: RUN_ID,
        org_id: forbiddenOrg,
        contract_version: APP_RUN_CONTRACT_VERSIONS.run,
        origin_kind: 'app',
        initiating_actor_type: 'human',
        initiating_actor_id: forbiddenActor,
        execution_actor_type: 'human',
        execution_actor_id: forbiddenActor,
        provider_kind: 'mcp',
        provider_instance_id: forbiddenProvider,
        operation_name: 'send_email',
        state: 'succeeded',
        risk_class: 'external_write',
        review_requirement: 'always',
        review_scope: 'per_invocation',
        retry_class: 'idempotent_with_key',
        retention_class: 'standard',
        safe_preview: { title: 'Send one sandbox message' },
        safe_outcome: { success: true, provider_call_attempted: true, result_status: 'retained' },
        root_run_id: RUN_ID,
        parent_run_id: null,
        depth: 0,
        input_expires_at: new Date('2026-09-02T12:00:00.000Z'),
        result_expires_at: new Date('2026-09-03T12:00:00.000Z'),
        idempotency_expires_at: new Date('2026-09-04T12:00:00.000Z'),
        attempt_limit: 3,
        execution_release_kind: 'approved',
        execution_released_at: new Date(OCCURRED_AT),
        input_purged_at: null,
        result_purged_at: null,
        started_at: new Date(OCCURRED_AT),
        terminal_at: new Date(OCCURRED_AT),
        unknown_outcome_at: null,
        reconciled_at: null,
        cancelled_at: null,
        cancel_requested_at: null,
        created_at: new Date(OCCURRED_AT),
        updated_at: new Date(OCCURRED_AT),
      };
    },
    async result() { throw new Error('not used'); },
  };
  const receiptReads: AppRunReceiptReader = {
    async readVerified(orgId, runId) {
      order.push('receipts');
      assert.equal(orgId, ORG_ID);
      assert.equal(runId, RUN_ID);
      return [{
        receipt_id: receiptId(),
        receipt_kind: 'approval',
        run_state: 'pending_approval',
        occurred_at: OCCURRED_AT,
        envelope_digest: `sha256:${'3'.repeat(64)}`,
        signing_key_version: 'sig-v1',
        signed_at: OCCURRED_AT,
        verified: true,
      }];
    },
  };
  const service = new AppActionService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runReads,
    receiptReads,
  );
  const caller = {
    actor: humanModuleActor({
      orgId: ORG_ID,
      userId: 'receipt-reader-user',
      role: 'member',
      source: 'ui',
    }),
  };

  const bundle = await service.inspectReceipts(caller, RUN_ID);
  assert.deepEqual(order, ['inspect', 'receipts']);
  assert.deepEqual(bundle.run, {
    id: RUN_ID,
    state: 'succeeded',
    operation_name: 'send_email',
    safe_preview: { title: 'Send one sandbox message' },
    safe_outcome: { success: true, provider_call_attempted: true, result_status: 'retained' },
    risk_class: 'external_write',
    review_requirement: 'always',
    review_scope: 'per_invocation',
    retry_class: 'idempotent_with_key',
    retention_class: 'standard',
    result_expires_at: '2026-09-03T12:00:00.000Z',
    result_purged_at: null,
  });
  const serialized = JSON.stringify(bundle);
  for (const forbidden of [forbiddenOrg, forbiddenActor, forbiddenProvider]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }

  let receiptReadsAfterDenial = 0;
  const denied = new AppActionService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      async inspect() { throw new AppRunError('APP_RUN_ACCESS_DENIED'); },
      async result() { throw new Error('not used'); },
    },
    {
      async readVerified() {
        receiptReadsAfterDenial += 1;
        return [];
      },
    },
  );
  await assert.rejects(
    () => denied.inspectReceipts(caller, RUN_ID),
    (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_ACCESS_DENIED',
  );
  assert.equal(receiptReadsAfterDenial, 0);
});

test('AppActionService binds MCP inspect, result, and receipt reads to the exact live token', async () => {
  const actorId = 'exact-token-reader';
  const originalTokenId = 'exact-token-original';
  const originalAuthority = {
    authority_kind: 'token_scope' as const,
    authority_id: originalTokenId,
    version: `sha256:${'1'.repeat(64)}`,
  };
  const liveAuthority: AppActionLiveAuthorityPort = {
    async captureForPreparation() {
      throw new Error('not used');
    },
    async assertTokenScopes(input) {
      const tokenId = input.token_authorities[0]?.token_id;
      if (!tokenId) throw new Error('missing token');
      return {
        authority_kind: 'token_scope',
        authority_id: tokenId,
        version: tokenId === originalTokenId
          ? originalAuthority.version
          : `sha256:${'2'.repeat(64)}`,
      };
    },
  };
  const run = {
    id: RUN_ID,
    state: 'succeeded',
    operation_name: 'send_email',
    safe_preview: { title: 'Safe preview' },
    safe_outcome: { success: true, provider_call_attempted: true, result_status: 'retained' },
    risk_class: 'external_write',
    review_requirement: 'always',
    review_scope: 'per_invocation',
    retry_class: 'idempotent_with_key',
    retention_class: 'standard',
    result_expires_at: new Date('2026-09-03T12:00:00.000Z'),
    result_purged_at: null,
  } as AppRunSafeView;
  const authorizeRead = (
    actor: Parameters<AppActionRunReadPort['inspect']>[2],
    authority: Parameters<AppActionRunReadPort['inspect']>[3],
  ) => {
    if (
      actor.actor_type !== 'human'
      || actor.user_id !== actorId
      || authority?.authority_kind !== originalAuthority.authority_kind
      || authority.authority_id !== originalAuthority.authority_id
      || authority.version !== originalAuthority.version
    ) throw new AppRunError('APP_RUN_ACCESS_DENIED');
  };
  const runReads: AppActionRunReadPort = {
    async inspect(_orgId, _runId, actor, requiredAuthorityRef) {
      authorizeRead(actor, requiredAuthorityRef);
      return run;
    },
    async result(_orgId, _runId, actor, requiredAuthorityRef) {
      authorizeRead(actor, requiredAuthorityRef);
      return { run, value: { status: 'delivered' } };
    },
  };
  let receiptReads = 0;
  const service = new AppActionService(
    undefined,
    liveAuthority,
    undefined,
    undefined,
    undefined,
    runReads,
    {
      async readVerified() {
        receiptReads += 1;
        return [];
      },
    },
  );
  const caller = (userId: string, tokenId: string): AppActionCaller => ({
    actor: humanModuleActor({
      orgId: ORG_ID,
      userId,
      role: 'member',
      source: 'mcp',
      scopes: ['read:app-runs'],
    }),
    token_authorities: [{ token_kind: 'mcp', token_id: tokenId }],
  });
  const originalCaller = caller(actorId, originalTokenId);

  assert.equal((await service.inspectRun(originalCaller, RUN_ID)).id, RUN_ID);
  assert.deepEqual((await service.result(originalCaller, RUN_ID)).value, { status: 'delivered' });
  assert.equal((await service.inspectReceipts(originalCaller, RUN_ID)).run.id, RUN_ID);
  assert.equal(receiptReads, 1);

  for (const alternate of [
    caller(actorId, 'exact-token-second'),
    caller('different-reader', 'exact-token-other-actor'),
  ]) {
    for (const read of [
      () => service.inspectRun(alternate, RUN_ID),
      () => service.result(alternate, RUN_ID),
      () => service.inspectReceipts(alternate, RUN_ID),
    ]) {
      await assert.rejects(
        read,
        (error: unknown) => error instanceof AppRunError && error.code === 'APP_RUN_ACCESS_DENIED',
      );
    }
  }
  assert.equal(receiptReads, 1, 'denied receipt reads must stop before receipt storage');
});
