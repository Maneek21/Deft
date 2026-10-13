import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailImapCredentials, orgMembers } from '@deft/db/schema';
import { EmailImapCredentialCustody, type EmailImapScope } from '../src/lib/email-imap-custody.js';
import { PostgresEmailImapCredentialStore, type EmailImapCredentialDatabase } from '../src/lib/email-imap-credential-store.js';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_upgrade';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;

test('actual isolated PostgreSQL IMAP custody CAS updates principal atomically and leaves account paused', { skip: !safe, timeout: 30000 }, async t => {
  const url = new URL(target);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55435'); assert.equal(url.password, '');
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  const fixtureSchema = 'imap_store_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA ${fixtureSchema}`);
  const pool = new pg.Pool({ connectionString: target, max: 4, options: `-c search_path=${fixtureSchema},public` });
  const schema = { emailAccounts, emailImapCredentials, orgMembers };
  const db = drizzle(pool, { schema });
  const scope: EmailImapScope = { org_id: 'imap-custody-' + randomUUID(), owner_user_id: 'owner-' + randomUUID(), account_id: 'imap-' + randomUUID() };
  await pool.query(`CREATE TABLE org_members(id text NOT NULL,org_id text NOT NULL,user_id text NOT NULL,role text NOT NULL DEFAULT 'member',is_active boolean NOT NULL DEFAULT true,
      app_run_authorization_version integer NOT NULL DEFAULT 1,joined_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(org_id,user_id));
    CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,provider text NOT NULL,
      provider_draft_sync_enabled boolean NOT NULL DEFAULT false,resource_binding_id text NOT NULL,principal_digest text,state text NOT NULL,authority_revision integer NOT NULL,consented_at timestamptz,revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(org_id,owner_user_id,account_id));
    CREATE TABLE email_imap_credentials(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,principal_digest text NOT NULL,
      connection_revision integer NOT NULL,envelope jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(org_id,owner_user_id,account_id));
    CREATE TABLE email_checkpoints(org_id text,owner_user_id text,account_id text);
    CREATE TABLE email_messages(org_id text,owner_user_id text,account_id text);
    CREATE TABLE email_memberships(org_id text,owner_user_id text,account_id text);
    CREATE TABLE email_provider_states(org_id text,owner_user_id text,account_id text);
    CREATE TABLE email_sync_receipts(org_id text,owner_user_id text,account_id text);`);
  await pool.query('INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,$4)', [randomUUID(), scope.org_id, scope.owner_user_id, 'owner']);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${fixtureSchema} CASCADE`);
    await admin.end();
  });
  await db.insert(emailAccounts).values({ ...scope, provider: 'imap_smtp', resource_binding_id: 'synthetic-binding',
    principal_digest: null, state: 'paused', authority_revision: 1 });
  const guards: unknown[] = [];
  const store = new PostgresEmailImapCredentialStore(db as unknown as EmailImapCredentialDatabase, async (selected, tx) => {
    assert.deepEqual(selected, scope); guards.push(tx);
    const [membership] = await tx.select().from(orgMembers).where(eq(orgMembers.org_id, selected.org_id)).limit(1);
    assert.equal(membership?.user_id, selected.owner_user_id);
  });
  const keys = { current: () => ({ key_id: 'imap-db-test', key: Buffer.alloc(32, 41) }),
    read: (_purpose: unknown, key: string) => key === 'imap-db-test' ? { key_id: key, key: Buffer.alloc(32, 41) } : null,
    keyIds: () => ['imap-db-test'] };
  const custody = new EmailImapCredentialCustody(keys, store);
  const profile = { host: 'imap.example.test', port: 993, transport: 'implicit_tls', username: 'reader@example.test', password: 'db-fixture-only-value' } as const;
  assert.equal(await store.read(scope), null);
  const saved = await custody.saveProfile(scope, 0, profile, async () => {});
  assert.equal(saved.connection_revision, 1);
  assert.equal(guards.length, 6, 'each guarded read/CAS transaction runs both authority fences');
  assert.equal(guards[0], guards[1]); assert.equal(guards[2], guards[3]); assert.equal(guards[4], guards[5]);
  const [account] = await db.select().from(emailAccounts).where(eq(emailAccounts.account_id, scope.account_id)).limit(1);
  assert.equal(account?.principal_digest, saved.principal_digest);
  assert.equal(account?.authority_revision, 2);
  assert.equal(account?.state, 'paused');
  let releaseSharedLock!: () => void;
  let acquiredSharedLock!: () => void;
  const sharedLockReady = new Promise<void>(resolve => { acquiredSharedLock = resolve; });
  const sharedLockRelease = new Promise<void>(resolve => { releaseSharedLock = resolve; });
  const lockHolder = db.transaction(async tx => {
    await tx.select({ account_id: emailAccounts.account_id }).from(emailAccounts)
      .where(eq(emailAccounts.account_id, scope.account_id)).for('share').limit(1);
    acquiredSharedLock();
    await sharedLockRelease;
  });
  await sharedLockReady;
  try {
    const concurrentReads = await Promise.race([
      Promise.all([store.read(scope), store.read(scope), store.read(scope)]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('credential reads waited on a shared account lock')), 2000)),
    ]);
    assert.deepEqual(concurrentReads.map(record => record?.connection_revision), [1, 1, 1]);
  } finally {
    releaseSharedLock();
    await lockHolder;
  }
  let finalGuardCalls = 0;
  const finalGuardStore = new PostgresEmailImapCredentialStore(db as unknown as EmailImapCredentialDatabase, async selected => {
    assert.deepEqual(selected, scope);
    if (++finalGuardCalls === 4) throw new Error('fixture final authority fence');
  });
  const finalGuardCustody = new EmailImapCredentialCustody(keys, finalGuardStore);
  await assert.rejects(finalGuardCustody.saveProfile(scope, 1, { ...profile, password: 'rollback-probe-value' }, async () => {}),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'EMAIL_IMAP_CUSTODY_UNAVAILABLE');
  assert.equal(finalGuardCalls, 4);
  const stored = await store.read(scope);
  assert.equal(stored?.connection_revision, 1);
  assert.equal(JSON.stringify(stored).includes(profile.password), false);
  await assert.rejects(custody.saveProfile(scope, 1, { ...profile, username: 'changed@example.test' }, async () => {}),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'EMAIL_IMAP_PRINCIPAL_IMMUTABLE');
  const [unchanged] = await db.select().from(emailAccounts).where(eq(emailAccounts.account_id, scope.account_id)).limit(1);
  assert.equal(unchanged?.authority_revision, 2);
  assert.equal(unchanged?.principal_digest, saved.principal_digest);
});
