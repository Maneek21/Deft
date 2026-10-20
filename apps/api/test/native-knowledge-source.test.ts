import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import { appSourceKnowledgeAudienceCondition } from '../src/lib/native-knowledge-source.js';
import { AppIntegrationCaptureNominationSchema } from '../../../packages/app-kit/src/app-integration-source.js';

test('non-mail app nominations declare source title, grouping and completeness without domain fields', () => {
  const nomination = {
    schema_version: 'deft.app_capture_nomination.v3', eligible: true,
    body: 'A durable procedure from a booking source with explicit eligibility.',
    body_digest: 'sha256:' + 'a'.repeat(64), grouping_key: 'sha256:' + 'b'.repeat(64),
    source_title: 'Booking procedure', observed_at: '2026-10-20T12:00:00Z',
    completeness: { partial: true, attachments_processed: false },
  };
  assert.equal(AppIntegrationCaptureNominationSchema.parse(nomination).schema_version, nomination.schema_version);
  for (const patch of [{ body: undefined }, { grouping_key: undefined }, { completeness: { partial: false, attachments_processed: false } }, { observed_at: 'unknown' }]) {
    assert.equal(AppIntegrationCaptureNominationSchema.safeParse({ ...nomination, ...patch }).success, false);
  }
});

const url = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!url && url === process.env.DATABASE_URL && /^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost):\d+\/[^?]*test(?:\?.*)?$/u.test(url);

test('native source audience enforces current authority and output audience in PostgreSQL', { skip: !safe }, async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Transaction-local tables exercise the same SQL contract without modifying
    // application fixtures or requiring an app runtime or provider connection.
    await client.query(`
      CREATE TEMP TABLE wiki_pages (id text, org_id text, created_via text, scope text, user_id text, space_id text, is_deleted boolean DEFAULT false);
      CREATE TEMP TABLE org_members (org_id text, user_id text, is_active boolean);
      CREATE TEMP TABLE spaces (id text, org_id text, type text, is_archived boolean DEFAULT false);
      CREATE TEMP TABLE space_members (space_id text, user_id text);
      CREATE TEMP TABLE users (id text, is_agent boolean);
      CREATE TEMP TABLE agent_employees (id text, org_id text, user_id text, is_active boolean, is_deleted boolean, runtime_kind text, slug text, is_byoa boolean);
      CREATE TEMP TABLE app_integration_capture_sources (page_id text, org_id text);
      INSERT INTO org_members VALUES ('org','owner',true),('org','other',true);
      INSERT INTO users VALUES ('owner',false),('other',false),('agent',true);
      INSERT INTO spaces (id,org_id,type) VALUES ('dm','org','dm'),('shared','org','private'),('elsewhere','org','private'),('foreign','other-org','dm');
      INSERT INTO space_members VALUES ('dm','owner'),('dm','agent'),('shared','owner'),('shared','other'),('foreign','owner');
      INSERT INTO agent_employees VALUES ('employee','org','owner',true,false,'byoa','assistant',true);
      INSERT INTO wiki_pages (id,org_id,created_via,scope,user_id,space_id) VALUES
        ('private','org','app_integration_capture','user','owner',null),
        ('shared-copy','org','app_integration_capture','space','owner','shared'),
        ('transfer','org','app_integration_transfer','space','owner','shared'),
        ('retained','org','retained-v1','user','owner',null),
        ('provenance','org','edited-origin','user','owner',null),
        ('foreign-copy','other-org','app_integration_capture','user','owner',null);
      INSERT INTO app_integration_capture_sources VALUES ('provenance','org');
    `);
    const visible = async (user?: string, conversation?: string, employee?: string) => {
      const condition = appSourceKnowledgeAudienceCondition('org', user, conversation, employee, ['retained-v1']);
      const query = new PgDialect().sqlToQuery(condition!);
      const result = await client.query('SELECT id FROM wiki_pages WHERE ' + query.sql + ' ORDER BY id', query.params);
      return result.rows.map(row => row.id);
    };
    assert.deepEqual(await visible('owner'), ['private', 'provenance', 'retained', 'shared-copy', 'transfer']);
    assert.deepEqual(await visible('owner', 'dm', 'employee'), ['private', 'provenance', 'retained']);
    assert.deepEqual(await visible('owner', 'shared'), ['shared-copy', 'transfer']);
    assert.deepEqual(await visible('other', 'shared'), ['shared-copy', 'transfer']);
    assert.deepEqual(await visible('owner', 'foreign'), []);
    assert.deepEqual(await visible('owner', 'elsewhere'), []);
    assert.deepEqual(await visible(), []);
    await client.query("INSERT INTO space_members VALUES ('dm','other')");
    assert.deepEqual(await visible('owner', 'dm'), []);
    await client.query("UPDATE agent_employees SET is_active=false WHERE id='employee'");
    assert.deepEqual(await visible('owner', undefined, 'employee'), []);
    await client.query("UPDATE agent_employees SET is_active=true, is_deleted=true WHERE id='employee'");
    assert.deepEqual(await visible('owner', undefined, 'employee'), []);
    await client.query("DELETE FROM space_members WHERE space_id='shared' AND user_id='owner'");
    assert.deepEqual(await visible('owner', 'shared'), []);
    await client.query("UPDATE org_members SET is_active=false WHERE user_id='owner'");
    assert.deepEqual(await visible('owner'), []);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
