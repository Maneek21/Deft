import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import { hostRetainedSourceStorage } from '../src/lib/host-source-storage.js';
import { and, eq } from 'drizzle-orm';
import { orgs, users, orgMembers, spaces, spaceMembers, wikiPages } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { emailKnowledgeAudienceCondition, emailKnowledgeSourceUrl } from '../src/lib/email-knowledge-visibility.js';
import { retrieveContext } from '../src/lib/retrieve-context.js';
import { readNativeWiki, resolveNativeWikiReader, searchNativeWiki } from '../src/lib/native-wiki-owner.js';
import { visibleWikiPageCondition } from '../src/lib/wiki-visibility.js';

const target = process.env.DATABASE_URL ?? '';
const safe = target === process.env.DEFT_TEST_DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_phase5_test_email_connected$/.test(target);

test('email citations encode only local native-mail source routes', () => {
  assert.equal(emailKnowledgeSourceUrl('work & personal', 'mail_' + 'a'.repeat(64)),
    '/email?account=work%20%26%20personal&message=mail_' + 'a'.repeat(64));
  assert.equal(emailKnowledgeSourceUrl('work', 'javascript:alert(1)'), null);
});

test('captured Email knowledge respects personal, shared and changing Defty audiences', { skip: !safe }, async t => {
  const org = randomUUID(), owner = randomUUID(), other = randomUUID(), agent = randomUUID();
  const dm = randomUUID(), channel = randomUUID(), unrelated = randomUUID();
  const fact = randomUUID(), decision = randomUUID(), shared = randomUUID();
  const term = `emailcapture${randomUUID().replaceAll('-', '')}`;
  try {
    await db.insert(orgs).values({ id: org, name: 'Email audience fixture', slug: `email-${org}` });
    await db.insert(users).values([
      { id: owner, email: `${owner}@example.test`, name: 'Owner' },
      { id: other, email: `${other}@example.test`, name: 'Other' },
      { id: agent, email: `${agent}@example.test`, name: 'Agent', is_agent: true },
    ]);
    await db.insert(orgMembers).values([owner, other, agent].map(user_id => ({ org_id: org, user_id })));
    await db.insert(spaces).values([
      { id: dm, org_id: org, name: 'Personal Defty', type: 'dm' },
      { id: channel, org_id: org, name: 'Client team', type: 'private' },
      { id: unrelated, org_id: org, name: 'Another team', type: 'private' },
    ]);
    await db.insert(spaceMembers).values([
      { space_id: dm, user_id: owner }, { space_id: dm, user_id: agent },
      { space_id: channel, user_id: owner }, { space_id: channel, user_id: other },
      { space_id: unrelated, user_id: owner },
    ]);
    await db.insert(wikiPages).values([
      { id: fact, org_id: org, user_id: owner, scope: 'user', type: 'fact', slug: fact,
        title: term, content: `${term} client delivery preference`, created_via: 'email_knowledge_auto' },
      { id: decision, org_id: org, user_id: owner, scope: 'user', type: 'decision', slug: decision,
        title: term, content: `${term} confirmed delivery decision`, created_via: 'email_knowledge_auto' },
      { id: shared, org_id: org, user_id: owner, scope: 'space', space_id: channel, type: 'fact', slug: shared,
        title: term, content: `${term} explicitly routed team requirement`, created_via: 'email_knowledge_auto' },
    ]);
    const visible = async (userId?: string, conversationId?: string) => (await db.select({ id: wikiPages.id }).from(wikiPages)
      .where(and(eq(wikiPages.org_id, org), emailKnowledgeAudienceCondition(org, userId, conversationId)))).map(r => r.id).sort();
    await t.test('owner recall includes personal Email; another user cannot recall it', async () => {
      assert.deepEqual(await visible(owner), [fact, decision, shared].sort());
      assert.deepEqual(await visible(other), [shared]);
      assert.deepEqual(await visible(), []);
    });
    await t.test('shared replies use only email knowledge routed into the same space', async () => {
      assert.deepEqual(await visible(owner, channel), [shared]);
      assert.deepEqual(await visible(owner, unrelated), []);
    });
    await t.test('personal DM permits recall until another human joins', async () => {
      assert.ok((await visible(owner, dm)).includes(fact));
      await db.insert(spaceMembers).values({ space_id: dm, user_id: other });
      assert.deepEqual(await visible(owner, dm), []);
      await db.delete(spaceMembers).where(and(eq(spaceMembers.space_id, dm), eq(spaceMembers.user_id, other)));
    });
    await t.test('actual retrieval filters both fact and decision branches by output audience', async () => {
      const recall = (user_id?: string, conversation_id?: string) => retrieveContext({ query: term, org_id: org,
        user_id, conversation_id, types: ['wiki', 'decisions'], hybrid: false, limit: 20 });
      assert.equal((await recall(owner)).length, 3);
      assert.deepEqual((await recall(owner, channel)).map(r => r.source_id), [shared]);
      assert.deepEqual(await recall(undefined), []);
      assert.deepEqual((await recall(other)).map(r => r.source_id), [shared]);
    });
    await t.test('native wiki_read cannot bypass conversation audience with an exact slug', async () => {
      const privateReader = await resolveNativeWikiReader({ orgId: org, userId: owner, conversationId: dm });
      const sharedReader = await resolveNativeWikiReader({ orgId: org, userId: owner, conversationId: channel });
      assert.ok(privateReader && sharedReader);
      assert.ok(await readNativeWiki(privateReader, fact));
      assert.equal(await readNativeWiki(sharedReader, fact), null);
    });
    await t.test('membership revocation removes previously eligible email-derived recall', async () => {
      const sharedReader = await resolveNativeWikiReader({ orgId: org, userId: owner, conversationId: channel });
      assert.ok(sharedReader);
      const raced = await searchNativeWiki(sharedReader, { query: term }, { afterEnrichment: async () => {
        await db.delete(spaceMembers).where(and(eq(spaceMembers.space_id, channel), eq(spaceMembers.user_id, owner)));
      } });
      assert.deepEqual(raced, [], 'removal while enriching search results cannot disclose previously selected content');
      assert.deepEqual(await visible(owner, channel), [], 'creator attribution cannot bypass destination revocation');
      const directWiki = await db.select({id:wikiPages.id}).from(wikiPages).where(and(eq(wikiPages.id,shared),visibleWikiPageCondition(owner)));
      assert.deepEqual(directWiki, [], 'the ordinary Wiki HTTP visibility guard also denies the former creator');
      const reader = await resolveNativeWikiReader({ orgId: org, userId: owner });
      assert.ok(reader);
      assert.equal(await readNativeWiki(reader, shared), null);
      assert.ok((await visible(owner, dm)).includes(fact), 'unrelated personal capture remains available');
      await db.delete(spaceMembers).where(and(eq(spaceMembers.space_id, channel), eq(spaceMembers.user_id, other)));
      assert.deepEqual(await visible(other), []);
      await db.update(orgMembers).set({ is_active: false }).where(and(eq(orgMembers.org_id, org), eq(orgMembers.user_id, owner)));
      assert.deepEqual(await visible(owner), []);
    });
  } finally {
    await db.delete(wikiPages).where(eq(wikiPages.org_id, org));
    for (const id of [dm, channel, unrelated]) await db.delete(spaceMembers).where(eq(spaceMembers.space_id, id));
    await db.delete(spaces).where(eq(spaces.org_id, org));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, org));
    await db.delete(orgs).where(eq(orgs.id, org));
    for (const id of [owner, other, agent]) await db.delete(users).where(eq(users.id, id));
    await closeDb();
  }
});


const mappingUrl=process.env.DEFT_TEST_DATABASE_URL;
const mappingSafe=!!mappingUrl&&mappingUrl===process.env.DATABASE_URL&&/^postgres(?:ql)?:\/\/(?:[^@]+@)?(?:127\.0\.0\.1|localhost):\d+\/[^?]*test(?:\?.*)?$/u.test(mappingUrl);
test('registered retained storage accepts only exact historical destination mappings',{skip:!mappingSafe},async()=>{
 const client=new pg.Client({connectionString:mappingUrl});await client.connect();
 try{
  await client.query(`BEGIN;
   CREATE TEMP TABLE wiki_pages(id text,org_id text,user_id text,scope text,space_id text,version integer);
   CREATE TEMP TABLE wiki_citations(page_id text,org_id text,source_type text,source_id text);
   CREATE TEMP TABLE email_knowledge_threads(org_id text,owner_user_id text,account_id text,thread_key text,destination_key text,page_id text,page_version integer);
   CREATE TEMP TABLE email_knowledge_sources(id text,org_id text,owner_user_id text,account_id text,thread_key text);
   INSERT INTO wiki_pages VALUES ('private','org','owner','user',null,1),('shared','org','owner','space','space',1),
    ('unknown','org','owner','user',null,1),('ordinary','org','owner','user',null,1);
   INSERT INTO email_knowledge_threads VALUES ('org','owner','account','private-thread','user','private',1),('org','owner','account','shared-thread','space:space','shared',1);
   INSERT INTO email_knowledge_sources VALUES ('private-source','org','owner','account','private-thread'),('shared-source','org','owner','account','shared-thread');
   INSERT INTO wiki_citations VALUES ('private','org','email','private-source'),('shared','org','email','shared-source'),('unknown','org','email','unknown-source');`);
  const query=(condition:Parameters<PgDialect['sqlToQuery']>[0])=>new PgDialect().sqlToQuery(condition);
  const select=async(condition:Parameters<PgDialect['sqlToQuery']>[0])=>{const q=query(condition);return (await client.query('SELECT id FROM wiki_pages WHERE '+q.sql+' ORDER BY id',q.params)).rows.map(row=>row.id);};
  const facet=hostRetainedSourceStorage.knowledge;
  assert.deepEqual(await select(facet.originCondition),['private','shared','unknown']);
  const mapped=()=>select(facet.provenanceCondition);
  assert.deepEqual(await mapped(),['private','shared']);assert.deepEqual(await mapped(),['private','shared'],'read-only replay is deterministic');
  for(const [table,where,column,value] of [
   ['email_knowledge_threads',"page_id='private'",'org_id','foreign'],
   ['email_knowledge_threads',"page_id='private'",'owner_user_id','foreign'],
   ['email_knowledge_threads',"page_id='private'",'account_id','foreign'],
   ['email_knowledge_threads',"page_id='private'",'thread_key','foreign'],
   ['email_knowledge_threads',"page_id='private'",'destination_key','space:space'],
   ['email_knowledge_threads',"page_id='private'",'page_id','foreign'],
   ['email_knowledge_threads',"page_id='private'",'page_version',2],
   ['email_knowledge_sources',"id='private-source'",'org_id','foreign'],
   ['email_knowledge_sources',"id='private-source'",'owner_user_id','foreign'],
   ['email_knowledge_sources',"id='private-source'",'account_id','foreign'],
   ['email_knowledge_sources',"id='private-source'",'thread_key','foreign'],
   ['wiki_citations',"page_id='private'",'org_id','foreign'],
   ['wiki_citations',"page_id='private'",'org_id',null],
   ['wiki_citations',"page_id='private'",'source_id','unknown'],
  ] as const){
   await client.query('SAVEPOINT mismatch');
   await client.query(`UPDATE ${table} SET ${column}=$1 WHERE ${where}`,[value]);
   assert.deepEqual(await mapped(),['shared'],table+'.'+column+' cannot nominate a different audience');
   await client.query('ROLLBACK TO SAVEPOINT mismatch');
  }
  await client.query("UPDATE wiki_pages SET scope='space',space_id='space' WHERE id='private'");
  assert.deepEqual(await mapped(),['shared'],'private-to-space widening has no retained consent');
  await client.query("UPDATE wiki_pages SET scope='user',space_id=null WHERE id='private'");
  await client.query("UPDATE wiki_pages SET space_id='foreign-space' WHERE id='shared'");
  assert.deepEqual(await mapped(),['private'],'a retained copy cannot move to another space');
  await client.query("UPDATE wiki_pages SET space_id='space' WHERE id='shared'");
  await client.query("INSERT INTO email_knowledge_threads VALUES ('org','owner','account','private-thread','space:space','private',1)");
  assert.deepEqual(await mapped(),['shared'],'one valid thread cannot override conflicting consent');
 }finally{await client.query('ROLLBACK');await client.end();}
});
