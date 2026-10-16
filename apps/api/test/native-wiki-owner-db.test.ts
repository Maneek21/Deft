import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, closeDb } from '../src/lib/db.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { humanFetch, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { resolveNativeWikiReader, searchNativeWiki } from '../src/lib/native-wiki-owner.js';
import {
  agentEmployees, messages, orgMembers, orgs, spaceMembers, spaces, users,
  wikiCitations, wikiLinks, wikiPages,
} from '@deft/db/schema';

const url = process.env.DATABASE_URL ?? '';
const safeDatabase = url === process.env.DEFT_TEST_DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_phase5_test_[a-z0-9_]+$/.test(url);

test('native wiki owner uses current human/employee authority for pages, links and citations',
  { skip: !safeDatabase }, async () => {
    const orgId = randomUUID();
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const shadowId = randomUUID();
    const employeeId = randomUUID();
    const spaceId = randomUUID();
    const messageId = randomUUID();
    const sharedId = randomUUID();
    const ownerPageId = randomUUID();
    const employeePageId = randomUUID();
    const sharedSlug = `shared-${randomUUID()}`;
    const ownerSlug = `owner-${randomUUID()}`;
    const employeeSlug = `employee-${randomUUID()}`;
    const ownerTerm = `privateowner${randomUUID().replaceAll('-', '')}`;
    const employeeTerm = `privateemployee${randomUUID().replaceAll('-', '')}`;
    const personalContext = (userId: string): HumanToolContext => ({
      org_id: orgId, user_id: userId, role: 'member', scopes: ['read:wiki'],
    });

    try {
      await db.insert(orgs).values({ id: orgId, name: 'Native wiki owner test', slug: `wiki-${orgId}` });
      await db.insert(users).values([
        { id: ownerId, name: 'Owner', email: `owner-${ownerId}@example.test` },
        { id: otherId, name: 'Other', email: `other-${otherId}@example.test` },
        { id: shadowId, name: 'Employee shadow', email: `shadow-${shadowId}@example.test`, is_agent: true },
      ]);
      await db.insert(orgMembers).values([
        { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'member', is_active: true },
        { id: randomUUID(), org_id: orgId, user_id: otherId, role: 'member', is_active: true },
        { id: randomUUID(), org_id: orgId, user_id: shadowId, role: 'member', is_active: true },
      ]);
      await db.insert(agentEmployees).values({ id: employeeId, org_id: orgId,
        user_id: shadowId, name: 'Test employee', slug: `test-${employeeId}`,
        role: 'custom', system_prompt: 'Fixture', created_by: ownerId,
        is_active: true, is_deleted: false });
      await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'Private source', type: 'private' });
      await db.insert(spaceMembers).values({ id: randomUUID(), space_id: spaceId, user_id: ownerId });
      await db.insert(messages).values({ id: messageId, org_id: orgId, space_id: spaceId,
        user_id: ownerId, content: 'Private cited source' });
      await db.insert(wikiPages).values([
        { id: sharedId, org_id: orgId, scope: 'org', type: 'concept',
          title: 'Shared wiki', slug: sharedSlug, content: 'Shared body' },
        { id: ownerPageId, org_id: orgId, scope: 'user', user_id: ownerId,
          type: 'fact', title: 'Owner private wiki', slug: ownerSlug, content: ownerTerm },
        { id: employeePageId, org_id: orgId, scope: 'user', user_id: shadowId,
          agent_employee_id: employeeId, type: 'fact', title: 'Employee private wiki',
          slug: employeeSlug, content: employeeTerm },
      ]);
      await db.insert(wikiLinks).values([
        { id: randomUUID(), org_id: orgId, source_page_id: sharedId, target_page_id: ownerPageId },
        { id: randomUUID(), org_id: orgId, source_page_id: sharedId, target_page_id: employeePageId },
      ]);
      await db.insert(wikiCitations).values({ id: randomUUID(), org_id: orgId, page_id: sharedId,
        source_type: 'message', source_id: messageId, source_space_id: spaceId,
        excerpt: 'Private cited source' });

      const otherRead = await executeToolCall('wiki_read', { slug: ownerSlug }, orgId, otherId);
      assert.match(otherRead.result.error, /not found/);
      assert.deepEqual(otherRead.citations, []);
      const otherSearch = await executeToolCall('wiki_search', { query: ownerTerm }, orgId, otherId);
      assert.ok(!otherSearch.result.pages.some((page: { id: string }) => page.id === ownerPageId));
      assert.ok(!otherSearch.citations.some((citation) => citation.id === ownerPageId));

      const ownerRead = await executeToolCall('wiki_read', { slug: ownerSlug }, orgId, ownerId);
      assert.equal(ownerRead.result.content, ownerTerm);
      assert.equal(ownerRead.citations[0]?.id, ownerPageId);
      const ownerSearch = await executeToolCall('wiki_search', { query: ownerTerm }, orgId, ownerId);
      assert.ok(ownerSearch.result.pages.some((page: { id: string }) => page.id === ownerPageId));
      const ownerReader = await resolveNativeWikiReader({ orgId, userId: ownerId });
      assert.ok(ownerReader);
      const revokedDuringSearch = await searchNativeWiki(ownerReader, { query: ownerTerm }, {
        afterCandidates: async () => {
          await db.update(wikiPages).set({ user_id: otherId }).where(eq(wikiPages.id, ownerPageId));
        },
      });
      assert.ok(!revokedDuringSearch.some((page) => page.id === ownerPageId),
        'owner removal after candidate ranking must drop the page and title');
      await db.update(wikiPages).set({ user_id: ownerId }).where(eq(wikiPages.id, ownerPageId));

      const sharedOther = await executeToolCall('wiki_read', { slug: sharedSlug }, orgId, otherId);
      assert.equal(sharedOther.result.content, 'Shared body');
      assert.deepEqual(sharedOther.result.linked_pages, []);
      assert.deepEqual(sharedOther.result.citations, []);
      const sharedOwner = await executeToolCall('wiki_read', { slug: sharedSlug }, orgId, ownerId);
      assert.deepEqual(sharedOwner.result.linked_pages.map((page: { slug: string }) => page.slug), [ownerSlug]);
      assert.equal(sharedOwner.result.citations.length, 1);
      const linkRevokedDuringSearch = await searchNativeWiki(ownerReader, { query: 'Shared body' }, {
        afterCandidates: async () => {
          await db.update(wikiPages).set({ user_id: otherId }).where(eq(wikiPages.id, ownerPageId));
        },
      });
      const currentShared = linkRevokedDuringSearch.find((page) => page.id === sharedId);
      assert.ok(currentShared);
      assert.deepEqual(currentShared.linked_pages, [],
        'target removal after candidate ranking must drop its linked title');
      await db.update(wikiPages).set({ user_id: ownerId }).where(eq(wikiPages.id, ownerPageId));
      await db.delete(spaceMembers).where(and(eq(spaceMembers.space_id, spaceId),
        eq(spaceMembers.user_id, ownerId)));
      const afterSourceAccessLoss = await executeToolCall('wiki_read', { slug: sharedSlug }, orgId, ownerId);
      assert.deepEqual(afterSourceAccessLoss.result.citations, []);
      await db.update(wikiPages).set({ user_id: otherId }).where(eq(wikiPages.id, ownerPageId));
      const afterLinkAccessLoss = await executeToolCall('wiki_read', { slug: sharedSlug }, orgId, ownerId);
      assert.deepEqual(afterLinkAccessLoss.result.linked_pages, []);
      await db.update(wikiPages).set({ user_id: ownerId }).where(eq(wikiPages.id, ownerPageId));

      // Employee authority is the live shadow identity, not the triggering human owner.
      const employeeOwnerRead = await executeToolCall('wiki_read', { slug: ownerSlug },
        orgId, ownerId, undefined, employeeId);
      assert.match(employeeOwnerRead.result.error, /not found/);
      const employeeOwnRead = await executeToolCall('wiki_read', { slug: employeeSlug },
        orgId, ownerId, undefined, employeeId);
      assert.equal(employeeOwnRead.result.content, employeeTerm);
      const autonomousEmployeeRead = await executeToolCall('wiki_read', { slug: employeeSlug },
        orgId, '', undefined, employeeId);
      assert.equal(autonomousEmployeeRead.result.content, employeeTerm);
      const employeeOwnSearch = await executeToolCall('wiki_search', { query: employeeTerm },
        orgId, ownerId, undefined, employeeId);
      assert.ok(employeeOwnSearch.result.pages.some((page: { id: string }) => page.id === employeePageId));
      const sharedEmployee = await executeToolCall('wiki_read', { slug: sharedSlug },
        orgId, ownerId, undefined, employeeId);
      assert.deepEqual(sharedEmployee.result.linked_pages.map((page: { slug: string }) => page.slug), [employeeSlug]);
      assert.deepEqual(sharedEmployee.result.citations, []);
      await db.update(orgMembers).set({ is_active: false })
        .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, shadowId)));
      const removedShadow = await executeToolCall('wiki_read', { slug: employeeSlug },
        orgId, ownerId, undefined, employeeId);
      assert.ok(removedShadow.result.error);
      await db.update(orgMembers).set({ is_active: true })
        .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, shadowId)));

      const missingHuman = await executeToolCall('wiki_read', { slug: sharedSlug }, orgId, '');
      assert.match(missingHuman.result.error, /not found/);
      await db.update(orgMembers).set({ is_active: false })
        .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, ownerId)));
      const inactiveHuman = await executeToolCall('wiki_read', { slug: ownerSlug }, orgId, ownerId);
      assert.match(inactiveHuman.result.error, /not found/);
      await db.update(orgMembers).set({ is_active: true })
        .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, ownerId)));
      await db.update(agentEmployees).set({ is_active: false }).where(eq(agentEmployees.id, employeeId));
      const inactiveEmployee = await executeToolCall('wiki_read', { slug: employeeSlug },
        orgId, ownerId, undefined, employeeId);
      assert.ok(inactiveEmployee.result.error);

      // Personal MCP is a separate scoped human path; verify parity rather than claiming it uses this owner.
      const personalDenied = await humanFetch({ id: `wiki:${ownerSlug}` }, personalContext(otherId));
      assert.equal(personalDenied.isError, true);
      const personalAllowed = await humanFetch({ id: `wiki:${ownerSlug}` }, personalContext(ownerId));
      assert.equal(personalAllowed.isError, false);
      assert.match(personalAllowed.content[0]!.text, new RegExp(ownerTerm));
    } finally {
      await db.delete(wikiCitations).where(eq(wikiCitations.page_id, sharedId));
      await db.delete(wikiLinks).where(eq(wikiLinks.source_page_id, sharedId));
      await db.delete(wikiPages).where(eq(wikiPages.org_id, orgId));
      await db.delete(messages).where(eq(messages.id, messageId));
      await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
      await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
      await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
      await db.delete(users).where(eq(users.id, ownerId));
      await db.delete(users).where(eq(users.id, otherId));
      await db.delete(users).where(eq(users.id, shadowId));
      await db.delete(orgs).where(eq(orgs.id, orgId));
      await closeDb();
    }
  });
