import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
