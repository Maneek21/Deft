import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

test('ordinary natural decision question recalls current scoped source', async () => {
  const url = safeTestDatabaseUrl();
  assert.ok(url, 'Requires the official guarded isolated database');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const org = randomUUID(), user = randomUUID(), spaceA = randomUUID(), spaceB = randomUUID();
  const target = randomUUID(), distractor = randomUUID(), scopedA = randomUUID(), scopedB = randomUUID(), generic = randomUUID();
  const ids = [target, distractor, scopedA, scopedB, generic];
  const question = 'Who is the pilot sponsor and launch approver for LIVE261019, and who is responsible for technical readiness? Use the current company knowledge and cite the source.';
  const content = 'LIVE261019 E1 planning note. Participants:25. Technical review21October2026; demo23October2026. Requested20Octoberstart remains unresolved. Elena Morris is the pilot sponsor and launch approver. Noah Chen remains responsible for technical readiness.';
  try {
    await c.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$2,$3)', [org, 'Ordinary decision recall fixture', `decision-${org}`]);
    await c.query("INSERT INTO users (id,email,name,kind,is_agent) VALUES ($1,$2,'Ordinary reader','human',false)", [user, `${user}@example.test`]);
    await c.query("INSERT INTO org_members (id,org_id,user_id,role,is_active) VALUES (gen_random_uuid()::text,$1,$2,'member',true)", [org, user]);
    for (const space of [spaceA, spaceB]) {
      await c.query("INSERT INTO spaces (id,org_id,name,type,created_by) VALUES ($1,$2,'Ordinary scope','public',$3)", [space, org, user]);
      await c.query('INSERT INTO space_members (id,space_id,user_id) VALUES (gen_random_uuid()::text,$1,$2)', [space, user]);
    }
    for (const row of [
      { id:target, scope:'org', space:null, title:'LIVE261019 Launch readiness note', content, confidence:0.95 },
      { id:distractor, scope:'org', space:null, title:'LIVE261019 Travel receipts', content:'LIVE261019 travel expenses and accounting archive. No project-role facts.', confidence:0.99 },
      { id:scopedA, scope:'space', space:spaceA, title:'LIVE261019 Space A readiness', content, confidence:0.9 },
      { id:scopedB, scope:'space', space:spaceB, title:'LIVE261019 Space B readiness', content, confidence:0.9 },
      { id:generic, scope:'org', space:null, title:'ALPHA2049 Launch readiness', content:content.replaceAll('LIVE261019','ALPHA2049'), confidence:0.95 },
    ]) {
      await c.query("INSERT INTO wiki_pages (id,org_id,user_id,type,scope,space_id,title,slug,content,version,confidence,is_deleted) VALUES ($1,$2,$3,'decision',$4,$5,$6,$7,$8,3,$9,false)", [row.id,org,user,row.scope,row.space,row.title,`ordinary-${row.id}`,row.content,row.confidence]);
    }
    const { retrieveContext } = await import('../src/lib/retrieve-context.js');
    const read = (query: string, extra: Record<string, unknown> = {}) => retrieveContext({ query, org_id:org, user_id:user, types:['decisions'], hybrid:false, limit:5, ...extra });
    const natural = await read(question);
    assert.ok(natural.some(row => row.source_id === target && row.content === content), 'Natural question must recall the actual current decision body');
    assert.ok(!natural.some(row => row.source_id === distractor), 'Identifier alone cannot admit unrelated same-org content');
    const control = await read('LIVE261019');
    assert.ok(control.some(row => row.source_id === target));
    assert.ok(control.some(row => row.source_id === distractor), 'Existing single-keyword eligibility remains unchanged');
    for (const [space,id] of [[spaceA,scopedA],[spaceB,scopedB]]) {
      const selected = await read(question, {space_id:space, include_org:false});
      assert.deepEqual(selected.map(row => row.source_id), [id], 'Both readable spaces keep their own positive selection');
    }
    const genericResult = await read(question.replaceAll('LIVE261019','ALPHA2049'));
    assert.deepEqual(genericResult.map(row => row.source_id), [generic], 'Identifier anchoring is not tied to a release prefix');
    assert.equal((await read(question, {limit:1})).length, 1);
  } finally {
    await c.query('DELETE FROM wiki_pages WHERE id=ANY($1::text[])', [ids]);
    await c.query('DELETE FROM space_members WHERE space_id=ANY($1::text[])', [[spaceA,spaceB]]);
    await c.query('DELETE FROM spaces WHERE id=ANY($1::text[])', [[spaceA,spaceB]]);
    await c.query('DELETE FROM org_members WHERE org_id=$1', [org]);
    await c.query('DELETE FROM orgs WHERE id=$1', [org]);
    await c.query('DELETE FROM users WHERE id=$1', [user]);
    await c.end();
  }
});
