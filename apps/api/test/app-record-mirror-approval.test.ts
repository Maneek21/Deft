import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { canonicalAppDataJson } from '@deft/app-kit/core';

const uuid = () => randomUUID();
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
const policy = () => ({ key: 'saved_drafts', action_key: 'mirror_drafts', max_authority_seconds: 3600, max_attempts_per_day: 3 });

function nominationRaw(installationId: string, accountRef: string, policyDigest: string, mirrorKey = 'saved_drafts') {
  return {
    connection_session_id: uuid(), store_key: 'drafts', mirror_key: mirrorKey, record_id: uuid(),
    request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1,
    account_ref: accountRef, installation_id: installationId, policy_digest: policyDigest,
  };
}

async function mockDb() {
  mock.module(new URL('../src/lib/db.ts', import.meta.url).href, {
    namedExports: { db: { execute: async () => ({ rows: [{ id: uuid() }] }) } },
  });
}

function makeService(current: unknown, approver: unknown, Service: new (...args: never[]) => { approveNomination(raw: unknown): Promise<unknown>; review(...args: unknown[]): Promise<unknown>; confirm(...args: unknown[]): Promise<unknown> }) {
  return new Service(
    { caller: approver, current: async () => current, guard: async () => {} } as never,
    {} as never, {} as never,
  );
}

test('approveNomination re-checks pins and re-runs the ordinary review()/confirm() authority', async () => {
  await mockDb();
  const { AppRecordMirrorService } = await import('../src/lib/app-record-mirror-service.js');
  const installationId = uuid();
  const current = {
    scope: { target_key: 'primary', installation_id: installationId },
    connection: { account_ref: 'account_1' },
    store: { key: 'drafts', record_mirrors: [policy()] },
    consent: { consent_id: uuid() },
  };
  const service = makeService(current, { org_id: uuid(), user_id: uuid(), sid: uuid(), access_expires_at: Date.now() + 60_000 }, AppRecordMirrorService);
  let reviewArgs: unknown[] | null = null;
  let confirmArgs: unknown[] | null = null;
  service.review = async (...args: unknown[]) => { reviewArgs = args; return { ticket: 'sealed-ticket', authority_digest: digest('authority') }; };
  service.confirm = async (...args: unknown[]) => { confirmArgs = args; return { receipt_id: 'receipt-1' }; };
  try {
    const receipt = await service.approveNomination(nominationRaw(installationId, 'account_1', digest(policy())));
    assert.equal((receipt as { receipt_id: string }).receipt_id, 'receipt-1');
    assert.ok(reviewArgs, 'review() must run');
    assert.ok(confirmArgs, 'confirm() must run');
    assert.equal(reviewArgs![0], confirmArgs![0], 'the same experience session is used');
    assert.equal(reviewArgs![1], 'primary', 'the target key is derived from current scope');
    const reviewRequest = reviewArgs![2] as Record<string, unknown>;
    assert.equal(reviewRequest.mirror_key, 'saved_drafts');
    assert.equal(reviewRequest.record_id, undefined, 'the record_id pin is not forwarded to the human review');
    assert.equal((confirmArgs![2] as Record<string, unknown>).expected_authority_digest, digest('authority'));
  } finally {
    mock.restoreAll();
  }
});

test('approveNomination fails closed on account, installation or policy drift with no receipt', async () => {
  await mockDb();
  const { AppRecordMirrorService } = await import('../src/lib/app-record-mirror-service.js');
  const installationId = uuid();
  const base = {
    scope: { target_key: 'primary', installation_id: installationId },
    connection: { account_ref: 'account_1' },
    store: { key: 'drafts', record_mirrors: [policy()] },
    consent: { consent_id: uuid() },
  };
  let reviews = 0;
  const mk = (current: unknown) => {
    const service = makeService(current, { org_id: uuid(), user_id: uuid(), sid: uuid(), access_expires_at: Date.now() + 60_000 }, AppRecordMirrorService);
    service.review = async () => { reviews += 1; return { ticket: 't', authority_digest: digest('authority') }; };
    service.confirm = async () => ({ receipt_id: 'receipt-1' });
    return service;
  };
  try {
    const service = mk(base);
    await assert.rejects(service.approveNomination(nominationRaw(installationId, 'account_2', digest(policy()))));
    await assert.rejects(service.approveNomination(nominationRaw(uuid(), 'account_1', digest(policy()))));
    await assert.rejects(service.approveNomination(nominationRaw(installationId, 'account_1', digest({ ...policy(), max_attempts_per_day: 99 }))));
    await assert.rejects(mk({ ...base, consent: null }).approveNomination(nominationRaw(installationId, 'account_1', digest(policy()))));
    assert.equal(reviews, 0, 'no review/confirm ever runs on a failed pin');
  } finally {
    mock.restoreAll();
  }
});
