import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { canonicalAppDataJson } from '@deft/app-kit/core';

// Regression tests for the PR #424 independent review of the record-mirror
// approval path. Module mocks keep these hermetic (no database required).
const uuid = () => randomUUID();
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalAppDataJson(value)).digest('hex');
const policy = () => ({ key: 'saved_drafts', action_key: 'mirror_drafts', max_authority_seconds: 3600, max_attempts_per_day: 3 });

function nominationRaw(installationId: string, recordId = uuid()) {
  return {
    connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: recordId,
    request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1,
    account_ref: 'account_1', installation_id: installationId, policy_digest: digest(policy()),
  };
}

type ServiceShape = {
  approveNomination(raw: unknown): Promise<unknown>;
  review(...args: unknown[]): Promise<unknown>;
  confirm(...args: unknown[]): Promise<unknown>;
};

function currentFor(installationId: string) {
  return {
    scope: { target_key: 'primary', installation_id: installationId },
    connection: { account_ref: 'account_1' },
    store: { key: 'drafts', record_mirrors: [policy()] },
    consent: { consent_id: uuid() },
  };
}

// One db mock for the whole file (the service module is imported once); each
// test sets the experience-session rows it needs.
let experienceRows: Array<{ id: string }> = [{ id: uuid() }];
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, {
  namedExports: { db: { execute: async () => ({ rows: experienceRows }) } },
});

function makeService(Service: new (...args: never[]) => ServiceShape, current: unknown) {
  return new Service(
    { caller: { org_id: uuid(), user_id: uuid(), sid: uuid(), access_expires_at: Date.now() + 60_000 }, current: async () => current, guard: async () => {} } as never,
    {} as never, {} as never,
  );
}

test('PR424-F01: approval binds the nominated record into the human review it re-runs', async () => {
  experienceRows = [{ id: uuid() }];
  const { AppRecordMirrorService } = await import('../src/lib/app-record-mirror-service.js');
  const installationId = uuid(), recordA = uuid();
  const service = makeService(AppRecordMirrorService as never, currentFor(installationId));
  let reviewArgs: unknown[] | null = null;
  service.review = async (...args: unknown[]) => { reviewArgs = args; return { ticket: 't', authority_digest: digest('authority') }; };
  service.confirm = async () => ({ receipt_id: 'receipt-1' });
  await service.approveNomination(nominationRaw(installationId, recordA));
  assert.ok(reviewArgs, 'review() must run');
  // The public review request stays the unchanged human request schema...
  assert.equal((reviewArgs![2] as Record<string, unknown>).record_id, undefined);
  // ...but the reviewed record is carried as a trusted, server-side binding.
  assert.deepEqual(reviewArgs![4], { record_id: recordA }, 'the reviewed record must be bound into the issued authority');
});

// The submit path's collaborators are mocked once, reading per-test state, so
// app-record-mirror-submit is imported a single time.
const submitState: { row: Record<string, unknown> | null; submitted: unknown[]; reserved: unknown[]; calls: number } = { row: null, submitted: [], reserved: [], calls: 0 };
mock.module(new URL('../src/lib/app-run-runtime.ts', import.meta.url).href, {
  namedExports: {
    getAppRunRuntime: async () => ({
      service: {
        submitReviewedRuntime: async (_actor: unknown, request: unknown, _a: unknown, finalGuard: () => Promise<void>) => {
          await finalGuard();
          submitState.submitted.push(request);
          return { id: uuid(), state: 'pending_approval', execution_release_kind: null };
        },
      },
    }),
  },
});
mock.module(new URL('../src/lib/app-record-mirror-store.ts', import.meta.url).href, {
  namedExports: {
    PostgresRecordMirrorStore: class {
      async read() { return submitState.row; }
      async remaining() { return 3; }
      async reserve(_tx: unknown, _row: unknown, value: unknown) { submitState.reserved.push(value); }
    },
  },
});
mock.module(new URL('../src/lib/app-record-mirror-authority.ts', import.meta.url).href, {
  namedExports: {
    currentRecordMirrorAuthority: async (_tx: unknown, raw: unknown) => raw,
    currentRecordMirrorReadAuthority: async (_tx: unknown, raw: unknown) => raw,
    // The real schema is exercised by the dedicated schema test above.
    ReviewedRecordMirrorAuthoritySchema: { parse: (raw: unknown) => raw },
    currentOwnerRecordMirrorReadAuthority: async (_tx: unknown, raw: unknown) => raw,
  },
});
mock.module(new URL('../src/lib/app-record-mirror-run.ts', import.meta.url).href, {
  namedExports: { releaseRecordMirrorRun: async (_tx: unknown, run: unknown) => run },
});
mock.module(new URL('../src/lib/app-prepared-record-action-receipt.ts', import.meta.url).href, {
  namedExports: { assertPreparedRecordCleanupSource: async () => {} },
});

async function loadSubmit(pins: Record<string, unknown>) {
  const scope = pins.scope as { org_id: string; owner_user_id: string };
  const row = {
    org_id: scope.org_id, owner_user_id: scope.owner_user_id,
    receipt_id: uuid(), state: 'enabled', revision: 1, policy_digest: pins.policy_digest, store_key: 'drafts',
    expires_at: new Date(Date.now() + 3600_000), reviewed_authority: pins, authority_digest: digest(pins), max_attempts_per_day: 3,
  };
  submitState.row = row; submitState.submitted = []; submitState.reserved = [];
  const { submitRecordMirrorRun } = await import('../src/lib/app-record-mirror-submit.js');
  const tx = {
    execute: async () => {
      submitState.calls += 1;
      // 1: prior request lookup, 2: committed recheck, 3: run input fingerprint.
      return submitState.calls === 3 ? { rows: [{ input_fingerprint: 'fingerprint' }] } : { rows: [] };
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  const input = (recordId: string) => ({
    mirror_receipt_id: row.receipt_id, mirror_receipt_revision: 1, mirror_policy_digest: pins.policy_digest,
    record_store_key: 'drafts', record_id: recordId, record_revision: 1, content_digest: digest('c'),
    snapshot_id: uuid(), snapshot_digest: digest('s'), mirror_operation: 'create',
    accepted_submission_id: '', accepted_snapshot_id: '', accepted_snapshot_digest: '',
  });
  return {
    get submitted() { return submitState.submitted; },
    get reserved() { return submitState.reserved; },
    submit: (recordId: string) => {
      submitState.calls = 0;
      return submitRecordMirrorRun(tx as never, scope as never, uuid(), input(recordId));
    },
  };
}

function pinsFor(recordId?: string) {
  const scope = { org_id: uuid(), owner_user_id: uuid(), installation_id: uuid() };
  return {
    scope, policy: policy(), policy_digest: digest(policy()), store_key: 'drafts',
    action_consents: [{ action_key: 'mirror_drafts', action_binding_id: uuid() }],
    ...(recordId ? { record_id: recordId } : {}),
  };
}

test('PR424-F01: approved receipt cannot mirror a different record', async () => {
  const recordA = uuid(), recordB = uuid();
  const harness = await loadSubmit(pinsFor(recordA));
  await assert.rejects(harness.submit(recordB), (error: unknown) => (error as { code?: string }).code === 'APP_ACCESS_DENIED',
    'a receipt reviewed for record A must not admit a mirror run for record B');
  assert.equal(harness.submitted.length, 0, 'no run may be submitted for an unreviewed record');
  assert.equal(harness.reserved.length, 0, 'no attempt budget may be reserved for an unreviewed record');
  await harness.submit(recordA);
  assert.equal(harness.submitted.length, 1, 'the reviewed record itself is still mirrored');
});

test('PR424-F01: an in-app (unbound) store review keeps its store-wide meaning', async () => {
  const harness = await loadSubmit(pinsFor());
  await harness.submit(uuid());
  await harness.submit(uuid());
  assert.equal(harness.submitted.length, 2);
});
