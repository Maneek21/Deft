import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';

/** Only this disposable, loopback-only database is permitted for this fixture. */
export const EMAIL_MAILBOX_TEST_DATABASE_URL =
  'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_test';

const FIXTURE_DDL = `
-- Minimal migration predecessors only. This is not the complete Deft schema.
CREATE TABLE IF NOT EXISTS job_queue (
  id text PRIMARY KEY, org_id text, queue text NOT NULL, name text NOT NULL, data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
  run_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz, error text,
  dedupe_key text, locked_by text, lock_token text, lock_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_dedupe_unique ON job_queue(COALESCE(org_id,''),dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS org_members (
  org_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE IF NOT EXISTS app_resource_bindings (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  CONSTRAINT app_resource_bindings_email_fixture_scope_uq UNIQUE (org_id, id, owner_user_id)
);
`;

const EXPECTED_TABLES = [
  'app_resource_bindings', 'email_accounts', 'email_checkpoints', 'email_memberships', 'job_queue',
  'email_messages', 'email_provider_states', 'email_sync_receipts', 'org_members',
].sort();
const EXPECTED_CONSTRAINTS = [
  'app_resource_bindings_email_fixture_scope_uq',
  'job_queue_pkey',
  'email_accounts_binding_fk', 'email_accounts_consent_check', 'email_accounts_owner_fk',
  'email_accounts_pkey', 'email_accounts_principal_check', 'email_accounts_provider_check', 'email_accounts_revision_check', 'email_accounts_state_check',
  'email_checkpoints_account_fk', 'email_checkpoints_coverage_check', 'email_checkpoints_pkey',
  'email_checkpoints_revision_check', 'email_checkpoints_state_check',
  'email_memberships_message_fk', 'email_memberships_pkey',
  'email_messages_account_fk', 'email_messages_content_check', 'email_messages_identity_check', 'email_messages_pkey',
  'email_provider_states_account_fk', 'email_provider_states_identity_check', 'email_provider_states_pkey',
  'email_sync_receipts_account_fk', 'email_sync_receipts_digest_check', 'email_sync_receipts_pkey',
  'org_members_pkey',
].sort();
const EXPECTED_INDEXES = [
  'job_queue_dedupe_unique', 'job_queue_pkey',
  'email_accounts_binding_idx', 'email_checkpoints_pkey', 'email_memberships_folder_idx',
  'email_memberships_pkey', 'email_messages_inventory_idx', 'email_messages_page_idx', 'email_messages_pkey',
  'email_provider_states_pkey', 'email_sync_receipts_pkey',
].sort();

export function assertEmailMailboxTestDatabaseTarget(
  runtimeUrl = process.env.DATABASE_URL,
  intendedUrl = process.env.DEFT_TEST_DATABASE_URL,
): string {
  if (runtimeUrl !== EMAIL_MAILBOX_TEST_DATABASE_URL || intendedUrl !== EMAIL_MAILBOX_TEST_DATABASE_URL) {
    throw new Error('Email mailbox DB fixture requires the exact dedicated email_stage34_test target in both DB variables');
  }
  const url = new URL(runtimeUrl);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55435'
    || url.username !== 'gate_g_test' || url.password || url.pathname !== '/email_stage34_test'
    || url.search || url.hash) {
    throw new Error('Email mailbox DB fixture target failed its loopback isolation guard');
  }
  return runtimeUrl;
}

async function assertOnlyFixtureTables(client: Client): Promise<void> {
  const result = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const actual = result.rows.map((row) => row.tablename).sort();
  const allowed = new Set(EXPECTED_TABLES);
  if (actual.some((name) => !allowed.has(name))) {
    throw new Error('Email mailbox DB fixture refuses unexpected public tables');
  }
}

async function assertCatalog(client: Client): Promise<void> {
  const tables = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  if (JSON.stringify(tables.rows.map((row) => row.tablename)) !== JSON.stringify(EXPECTED_TABLES)) {
    throw new Error('Email mailbox fixture table set does not match expected migration output');
  }
  const constraints = await client.query<{ conname: string }>(
    "SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'",
  );
  const actualConstraints = [...new Set(constraints.rows.map((row) => row.conname))].sort();
  for (const expected of EXPECTED_CONSTRAINTS) {
    if (!actualConstraints.includes(expected)) throw new Error(`Email mailbox migration constraint missing: ${expected}`);
  }
  const indexes = await client.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname='public'",
  );
  const actualIndexes = [...new Set(indexes.rows.map((row) => row.indexname))].sort();
  for (const expected of EXPECTED_INDEXES) {
    if (!actualIndexes.includes(expected)) throw new Error(`Email mailbox migration index missing: ${expected}`);
  }
  const trigger = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='email_accounts'
         AND t.tgname='email_account_identity_trigger' AND NOT t.tgisinternal
     ) AS present`,
  );
  if (!trigger.rows[0]?.present) throw new Error('Email mailbox migration trigger missing');
}

/** Prepare a minimal migration-only predecessor and run the real migration twice.
 * This proves SQL idempotence against the declared FK targets, not full schema parity. */
export async function openPreparedEmailMailboxTestDatabase(): Promise<Client> {
  const connectionString = assertEmailMailboxTestDatabaseTarget();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const identity = await client.query<{ database_name: string; role_name: string; server_port: number; server_address: string }>(
      'SELECT current_database() AS database_name, current_user AS role_name, inet_server_port() AS server_port, host(inet_server_addr()) AS server_address',
    );
    const row = identity.rows[0];
    if (row?.database_name !== 'email_stage34_test' || row.role_name !== 'gate_g_test'
      || row.server_port !== 55435 || row.server_address !== '127.0.0.1') {
      throw new Error('Email mailbox DB fixture connected outside its dedicated loopback test target');
    }

    await assertOnlyFixtureTables(client);
    await client.query(FIXTURE_DDL);
    const migration = readFileSync(fileURLToPath(new URL(
      '../../../../packages/db/upgrades/0.3.0-preview.63-native-email-mailbox.sql', import.meta.url,
    )), 'utf8');
    await client.query(migration);
    await client.query(migration);
    await assertCatalog(client);
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

export const EMAIL_MAILBOX_MIGRATION_FIXTURE_TABLES = Object.freeze([...EXPECTED_TABLES]);

/** Opt-in current-store bootstrap. Default migration63 fixture above stays exact.
 * Only retained-registry account columns and the real notification migration
 * are needed here; no draft/OAuth enrolment tables or activation are fabricated. */
export async function openPreparedCurrentEmailMailboxTestDatabase(): Promise<Client> {
  const client=await openPreparedEmailMailboxTestDatabase();
  try{
    const read=(name:string,expected:string)=>{
      const bytes=readFileSync(fileURLToPath(new URL('../../../../packages/db/upgrades/'+name,import.meta.url)));
      if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Current mailbox fixture migration hash changed');
      return bytes.toString('utf8').replaceAll('\r\n','\n');
    };
    const draft=read('0.3.0-preview.70-email-provider-draft-mirrors.sql','263c27cf8f81fffbd10112cba6df0705a2c60b352b8490b563335770b16d740c');
    const draftEnd=draft.indexOf('CREATE TABLE IF NOT EXISTS email_provider_draft_mirrors (');
    const draftPrefix=draft.slice(0,draftEnd);
    if(draftEnd<0||draftPrefix!=="-- Native provider draft mirroring is dormant unless the owner explicitly opts in.\nALTER TABLE email_accounts\n  ADD COLUMN IF NOT EXISTS provider_draft_sync_enabled boolean NOT NULL DEFAULT false;\n\n")throw new Error('Current mailbox fixture draft prefix changed');
    const native=read('0.3.0-preview.85-email-native-connections.sql','b1ec09d5068b59b898be44aa86c3e638aacebfba8723541612c45e729db1a464');
    const nativeEnd=native.indexOf('CREATE TABLE IF NOT EXISTS email_native_account_connections (');
    const nativePrefix=native.slice(0,nativeEnd);
    if(nativeEnd<0||!nativePrefix.startsWith('-- Owner-native OAuth setup receipts.')||!nativePrefix.endsWith('CREATE TRIGGER email_account_identity_trigger BEFORE UPDATE ON email_accounts FOR EACH ROW EXECUTE FUNCTION email_account_identity_immutable();\n'))throw new Error('Current mailbox fixture account prefix changed');
    await client.query(draftPrefix);await client.query(nativePrefix);
    await client.query(read('0.3.0-preview.87-email-notifications-unread.sql','dcf3a9d09614f79439dcc2fa001b0c76653747f009793b0c70fc5f1446d09404'));
    const expected=[...EXPECTED_TABLES,'email_notification_states','email_notification_events'].sort();
    const tables=await client.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    if(JSON.stringify(tables.rows.map(row=>row.tablename))!==JSON.stringify(expected))throw new Error('Current mailbox fixture table set changed');
    const columns=await client.query<{column_name:string;data_type:string;is_nullable:string;is_generated:string}>("SELECT column_name,data_type,is_nullable,is_generated FROM information_schema.columns WHERE table_schema='public' AND table_name='email_accounts' AND column_name IN ('credential_source','provider_draft_sync_enabled','retained_resource_binding_id') ORDER BY column_name");
    if(JSON.stringify(columns.rows)!==JSON.stringify([
      {column_name:'credential_source',data_type:'text',is_nullable:'NO',is_generated:'NEVER'},
      {column_name:'provider_draft_sync_enabled',data_type:'boolean',is_nullable:'NO',is_generated:'NEVER'},
      {column_name:'retained_resource_binding_id',data_type:'text',is_nullable:'YES',is_generated:'ALWAYS'},
    ]))throw new Error('Current mailbox fixture account columns changed');
    const constraints=await client.query<{conname:string}>("SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'");
    const names=new Set(constraints.rows.map(row=>row.conname));
    for(const name of [...EXPECTED_CONSTRAINTS,'email_accounts_source_check','email_notification_states_pkey','email_notification_states_account_fk','email_notification_events_pkey','email_notification_events_message_unique','email_notification_events_account_fk','email_notification_events_identity_check','email_notification_events_state_check'])if(!names.has(name))throw new Error('Current mailbox fixture constraint missing: '+name);
    const indexes=await client.query<{indexname:string}>("SELECT indexname FROM pg_indexes WHERE schemaname='public'");const indexNames=new Set(indexes.rows.map(row=>row.indexname));
    for(const name of [...EXPECTED_INDEXES,'email_accounts_retained_binding_idx','email_notification_events_pending_idx'])if(!indexNames.has(name))throw new Error('Current mailbox fixture index missing: '+name);
    return client;
  }catch(error){await client.end();throw error;}
}
