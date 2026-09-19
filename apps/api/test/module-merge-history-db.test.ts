import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db, closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
const url = safeTestDatabaseUrl();
const canRun = Boolean(url);
after(closeDb);

test('merge history migration creates tenant-bound preservation storage and is repeatable', { skip: !canRun }, async () => {
  const migration = readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.30-module-record-merges.sql', import.meta.url), 'utf8');
  const schema = `merge_test_${randomUUID().replaceAll('-', '')}`;
  const rollback = new Error('discard isolated migration fixture');
  await assert.rejects(db.transaction(async (tx) => {
    await tx.execute(sql.raw(`CREATE SCHEMA ${schema}`));
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}`));
    await tx.execute(sql.raw('CREATE TABLE module_records (org_id text NOT NULL, installation_id text NOT NULL, id text NOT NULL, UNIQUE(org_id, installation_id, id))'));
    await tx.execute(sql.raw(migration)); await tx.execute(sql.raw(migration));
    await tx.execute(sql.raw("INSERT INTO module_records VALUES ('org','install','source'), ('org','install','target'), ('other','install','foreign'), ('org','other-install','other-source')"));
    const insert = (id: string, source: string, target: string) => tx.execute(sql`INSERT INTO module_record_merges (id,org_id,installation_id,source_record_id,target_record_id,source_revision,target_revision,source_data,target_data,link_snapshot,choices,created_by) VALUES (${id}, 'org','install',${source},${target},1,2,'{"name":"Imported"}','{"name":"Curated"}','{"edges":["original-edge"]}','{"name":"target"}','reviewer')`);
    await insert('valid', 'source', 'target');
    for (const [id, source, target] of [['tenant','foreign','target'], ['installation','other-source','target'], ['same','source','source']]) {
      await tx.execute(sql.raw('SAVEPOINT invalid_merge'));
      await assert.rejects(insert(id!, source!, target!));
      await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT invalid_merge'));
    }
    const rows = await tx.execute(sql`SELECT source_data, target_data, link_snapshot FROM module_record_merges`);
    assert.equal(rows.rows.length, 1);
    assert.deepEqual(rows.rows[0]!.source_data, { name: 'Imported' });
    assert.deepEqual(rows.rows[0]!.target_data, { name: 'Curated' });
    assert.deepEqual(rows.rows[0]!.link_snapshot, { edges: ['original-edge'] });
    throw rollback;
  }), (error: unknown) => error === rollback);
  const exists = await db.execute(sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${schema}`);
  assert.equal(exists.rows.length, 0);
});
