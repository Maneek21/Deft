import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';

const orgId = randomUUID(), userId = randomUUID(), sid = randomUUID();
const account = { installation_id: randomUUID(), account_ref: 'account_1', store_key: 'drafts' };
const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

test('a seeded Defty delegation writes exactly one read grant and never draft/send', async () => {
  let captured: unknown = null;
  mock.module(new URL('../src/lib/app-integration-runtime-gateway.ts', import.meta.url).href, {
    namedExports: {
      getAppIntegrationDataGateway: () => ({
        currentAccount: async () => ({ resource_binding_id: 'binding-rb', identity: 'identity' }),
      }),
    },
  });
  mock.module(new URL('../src/lib/app-integration-tool-grants.ts', import.meta.url).href, {
    namedExports: {
      writeIntegrationToolGrant: async (_caller: unknown, input: unknown) => {
        captured = input; return { id: randomUUID(), revision: 1, operations: ['read'] };
      },
    },
  });
  try {
    const { DEFAULT_DEFTY_GRANT_OPERATIONS, seedDefaultDeftyIntegrationGrant } = await import('../src/lib/app-integration-permission-context.js');
    assert.deepEqual([...DEFAULT_DEFTY_GRANT_OPERATIONS], ['read']);
    assert.equal(DEFAULT_DEFTY_GRANT_OPERATIONS.includes('draft'), false);
    assert.equal(DEFAULT_DEFTY_GRANT_OPERATIONS.includes('send'), false);
    const caller = { org_id: orgId, user_id: userId, sid, access_expires_at: Date.now() + 60_000 };
    const result = await seedDefaultDeftyIntegrationGrant(caller, account, { expires_at: expiresAt, expected_revision: 0 });
    assert.deepEqual(captured, {
      installation_id: account.installation_id, account_ref: account.account_ref, store_key: account.store_key,
      resource_binding_id: 'binding-rb', principal_kind: 'defty', principal_id: userId,
      operations: ['read'], expires_at: expiresAt, expected_revision: 0,
    });
    assert.deepEqual(result.operations, ['read']);
  } finally {
    mock.restoreAll();
  }
});
