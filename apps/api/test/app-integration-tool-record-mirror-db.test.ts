import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';

const orgId = randomUUID(), ownerId = randomUUID();
const policy = { key: 'mirror', action_key: 'mirror_records', max_authority_seconds: 3600, max_attempts_per_day: 3 };
const current = {
  scope: { org_id: orgId, owner_user_id: ownerId, installation_id: randomUUID(), app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), resource_key: 'records', target_key: 'primary' },
  connection: { account_ref: 'account_1' },
  store: { key: 'records', record_mirrors: [policy] },
  consent: { consent_id: randomUUID() },
};
const baseNomination = () => ({
  connection_session_id: randomUUID(), store_key: 'records', mirror_key: 'mirror', record_id: randomUUID(),
  request_id: randomUUID(), expected_revision: 0,
  expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1,
});

async function loadService() {
  let cardWritten = false;
  let principalSeen: unknown = null;
  mock.module(new URL('../src/lib/db.ts', import.meta.url).href, {
    namedExports: {
      db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        execute: async () => { cardWritten = true; return { rows: [{ id: 'action-id' }] }; },
      }) },
    },
  });
  mock.module(new URL('../src/lib/app-integration-tool-authority.ts', import.meta.url).href, {
    namedExports: {
      currentAppIntegrationToolPrincipal: async (_tx: unknown, caller: unknown) => { principalSeen = caller; return { identity: 'agent', expires_at: Date.now() + 60_000 }; },
    },
  });
  const { AppRecordMirrorService } = await import('../src/lib/app-record-mirror-service.js');
  const makeService = () => new AppRecordMirrorService(
    { caller: { org_id: orgId, user_id: ownerId, sid: randomUUID() }, guard: async () => {}, current: async () => current } as never,
    {} as never, {} as never,
  );
  const caller = { org_id: orgId, user_id: ownerId, kind: 'defty' as const, principal_id: ownerId, access_expires_at: Date.now() + 60_000, conversation_id: randomUUID(), employee_id: randomUUID() };
  return { AppRecordMirrorService, makeService, caller, cardWritten: () => cardWritten, principalSeen: () => principalSeen };
}

test('an agent nomination lands a pending approval card and issues no receipt', async () => {
  const { makeService, caller, cardWritten, principalSeen } = await loadService();
  try {
    const result = await makeService().nominate(caller, current as never, baseNomination());
    assert.equal(result.approval_status, 'pending');
    assert.equal(result.mirror_key, 'mirror');
    assert.equal(result.store_key, 'records');
    assert.equal(result.schema_version, 'deft.app_record_mirror_nomination.v1');
    assert.ok(cardWritten(), 'a pending agent_actions card must be written');
    assert.equal(principalSeen(), caller);
  } finally {
    mock.restoreAll();
  }
});

test('a nomination for a foreign account or missing consent is rejected before any card', async () => {
  const { makeService, caller, cardWritten } = await loadService();
  try {
    // Foreign owner (different user_id) must be denied without writing a card.
    await assert.rejects(makeService().nominate({ ...caller, user_id: randomUUID() }, current as never, baseNomination()));
    // Missing consent must be denied.
    await assert.rejects(makeService().nominate(caller, { ...current, consent: null } as never, baseNomination()));
    // Out-of-bounds lifetime must be denied.
    await assert.rejects(makeService().nominate(caller, current as never, { ...baseNomination(), expires_at: new Date(Date.now() + 10 * 3600_000).toISOString() }));
    assert.equal(cardWritten(), false);
  } finally {
    mock.restoreAll();
  }
});
