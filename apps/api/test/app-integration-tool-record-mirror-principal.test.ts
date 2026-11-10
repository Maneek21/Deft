import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';

const uuid = () => randomUUID();

test('nominateRecordMirror refuses a foreign owner or an invalid principal before any card', async () => {
  let cardWritten = false;
  mock.module(new URL('../src/lib/db.ts', import.meta.url).href, {
    namedExports: {
      db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        execute: async () => { cardWritten = true; return { rows: [{ id: 'action-id' }] }; },
      }) },
    },
  });
  mock.module(new URL('../src/lib/app-integration-tool-authority.ts', import.meta.url).href, {
    namedExports: {
      currentAppIntegrationToolPrincipal: async () => { throw new Error('APP_INTEGRATION_TOOL_ACCESS_DENIED'); },
    },
  });
  try {
    const { nominateRecordMirror } = await import('../src/lib/app-record-mirror-service.js');
    const orgId = uuid(), ownerId = uuid();
    const policy = { key: 'saved_drafts', action_key: 'mirror_drafts', max_authority_seconds: 3600, max_attempts_per_day: 3 };
    const current = {
      scope: { org_id: orgId, owner_user_id: ownerId },
      connection: { account_ref: 'account_1' },
      store: { key: 'drafts', record_mirrors: [policy] },
      consent: { consent_id: uuid() },
    } as never;
    const nomination = {
      connection_session_id: uuid(), store_key: 'drafts', mirror_key: 'saved_drafts', record_id: uuid(),
      request_id: uuid(), expected_revision: 0, expires_at: new Date(Date.now() + 3600_000).toISOString(), max_attempts_per_day: 1,
    };
    // A foreign owner (different user_id) is denied before the principal runs.
    await assert.rejects(nominateRecordMirror({ org_id: orgId, user_id: uuid(), kind: 'defty' as const, principal_id: uuid(), access_expires_at: Date.now() + 60_000, conversation_id: uuid(), employee_id: uuid() } as never, current, nomination));
    assert.equal(cardWritten, false);
    // A rejected principal (revoked token / inactive member / non-canonical DM) is denied.
    await assert.rejects(nominateRecordMirror({ org_id: orgId, user_id: ownerId, kind: 'defty' as const, principal_id: ownerId, access_expires_at: Date.now() + 60_000, conversation_id: uuid(), employee_id: uuid() } as never, current, nomination));
    assert.equal(cardWritten, false);
  } finally {
    mock.restoreAll();
  }
});
