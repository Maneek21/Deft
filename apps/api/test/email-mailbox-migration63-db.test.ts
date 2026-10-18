import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertEmailMailboxTestDatabaseTarget,
  EMAIL_MAILBOX_MIGRATION_FIXTURE_TABLES,
  EMAIL_MAILBOX_TEST_DATABASE_URL,
  openPreparedEmailMailboxTestDatabase,
} from './fixtures/email-mailbox-database.js';

test('migration 63 is idempotent on its guarded minimal predecessor fixture', async (t) => {
  assert.throws(() => assertEmailMailboxTestDatabaseTarget(
    'postgresql://localhost/deft', EMAIL_MAILBOX_TEST_DATABASE_URL,
  ));
  const client = await openPreparedEmailMailboxTestDatabase();
  t.after(() => client.end());
  const result = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  assert.deepEqual(result.rows.map((row) => row.tablename), EMAIL_MAILBOX_MIGRATION_FIXTURE_TABLES);
  const emailTables = result.rows.filter((row) => row.tablename.startsWith('email_'));
  assert.deepEqual(emailTables.map((row) => row.tablename), [
    'email_accounts', 'email_checkpoints', 'email_memberships', 'email_messages', 'email_provider_states', 'email_sync_receipts',
  ]);
});
