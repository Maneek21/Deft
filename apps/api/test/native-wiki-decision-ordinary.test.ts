import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

test('ordinary native wiki discovery includes readable decision pages and preserves type selection', async () => {
  const url = safeTestDatabaseUrl();
  assert.ok(url, 'Requires the official guarded isolated database');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const org = randomUUID(), human = randomUUID(), shadow = randomUUID(), employee = randomUUID();
  const decision = randomUUID(), article = randomUUID(), prefix = `NATIVE${randomUUID().replaceAll('-', '')}`;
  const title = `${prefix} Reviewed publication note`, body = `${title}. Participants25; technical review21October2026. Current exact body retained.`;
  const slug = `reviewed-${decision}`, controlSlug = `guide-${article}`;
  try {
    await c.query('INSERT INTO orgs(id,name,slug,ai_config) VALUES($1,$2,$3,$4::jsonb)', [org, 'Ordinary native discovery', `native-${org}`, JSON.stringify({embed:{provider:'off'}})]);
    await c.query('INSERT INTO users(id,email,name,is_agent) VALUES($1,$2,$3,false),($4,$5,$6,true)', [human,`${human}@example.test`,'Ordinary reader',shadow,`${shadow}@example.test`,'Canonical Defty']);
    for (const user of [human,shadow]) await c.query("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES(gen_random_uuid()::text,$1,$2,'member',true)", [org,user]);
    await c.query("INSERT INTO agent_employees(id,org_id,user_id,name,slug,role,system_prompt,created_by,runtime_kind,is_byoa,is_active,is_deleted) VALUES($1,$2,$3,'Defty','defty-system','custom','Ordinary fixture',$4,'defty_system',false,true,false)", [employee,org,shadow,human]);
    for (const row of [{id:decision,title,slug,type:'decision',content:body},{id:article,title:`${prefix} Search coverage guide`,slug:controlSlug,type:'concept',content:`${title}. Ordinary nondecision discovery control.`}]) {
      await c.query("INSERT INTO wiki_pages(id,org_id,user_id,type,scope,title,slug,content,version,confidence,is_deleted) VALUES($1,$2,$3,$4,'org',$5,$6,$7,1,0.95,false)", [row.id,org,human,row.type,row.title,row.slug,row.content]);
    }
    const { resolveNativeWikiReader, searchNativeWiki, readNativeWiki } = await import('../src/lib/native-wiki-owner.js');
    const reader = await resolveNativeWikiReader({orgId:org,userId:human,agentEmployeeId:employee});
    assert.ok(reader);
    assert.equal(reader.subjectUserId,human, 'Canonical Defty keeps the actual human reader');
    const pages = await searchNativeWiki(reader,{query:title,limit:10});
    assert.ok(pages.some(page=>page.id===decision && page.slug===slug && page.type==='decision'), 'Exact-title native discovery must include the readable decision wiki subtype');
    assert.ok(pages.some(page=>page.id===article), 'Existing nondecision discovery remains available');
    const read = await readNativeWiki(reader,slug);
    assert.equal(read?.page.id,decision);assert.equal(read?.page.content,body);assert.equal(read?.page.version,1);
    assert.deepEqual((await searchNativeWiki(reader,{query:title,type:'decision',scope:'org',limit:10})).map(page=>page.id),[decision]);
    assert.deepEqual((await searchNativeWiki(reader,{query:title,type:'concept',scope:'org',limit:10})).map(page=>page.id),[article]);
    assert.equal((await searchNativeWiki(reader,{query:title,limit:1})).length,1);
  } finally {
    await c.query('DELETE FROM wiki_pages WHERE id=ANY($1::text[])',[[decision,article]]);
    await c.query('DELETE FROM agent_employees WHERE id=$1',[employee]);
    await c.query('DELETE FROM org_members WHERE org_id=$1',[org]);
    await c.query('DELETE FROM orgs WHERE id=$1',[org]);
    await c.query('DELETE FROM users WHERE id=ANY($1::text[])',[[human,shadow]]);
    await c.end();
  }
});
