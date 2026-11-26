/**
 * Planning the document and drive access checks costs a database backend a
 * few MB, in every form the surfaces use them (spec 5.2; consult S-F4).
 *
 * Why: PostgreSQL plans every branch of a condition whatever the row, and the
 * backend keeps the memory it grew to until its connection closes. An
 * oversized condition ran a 512 MB database machine out of memory in
 * releases 145 to 149 (attention-visibility-narrowing-db.test.ts).
 *
 * Each form is planned by a fresh backend (planningGrowth, JIT off as the
 * API's connections run) in workspaces of 10, 50 and 200 documents
 * (setupDrivesFixture's `documents`), after ANALYZE. Budget for each: under
 * 24 MB of private memory and under 48 MB of peak resident size. The measured
 * values are printed as diagnostics. Skipped where the test database does not
 * let a session read /proc/self/status (CI's does, and fails instead).
 */
import assert from 'node:assert/strict';
import test, { after, before, type TestContext } from 'node:test';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { documents, drives } from '@deft/db/documents';
import { attentionItems, notifications } from '@deft/db/schema';
import { visibleAttentionCondition } from '../src/lib/attention.js';
import { nativeNotificationAccessSql } from '../src/lib/native-mention-visibility.js';
import { closeDb, db } from '../src/lib/db.js';
import {
  documentRoleQuery,
  documentViewersQuery,
  driveRoleQuery,
  spaceMembersWhoCannotOpenQuery,
  visibleDocumentCondition,
  visibleDocumentIdSql,
  visibleDriveCondition,
} from '../src/lib/document-access.js';
import { breadcrumbChainQuery, driveTreeDocumentsQuery, favoriteDocumentsQuery, recentDocumentsQuery } from '../src/lib/documents.js';
import { documentCardsQuery, fullDriveQuery, postableDocumentsQuery, spaceSharedDocumentsQuery } from '../src/lib/chat-documents.js';
import { newlyReachedQuery } from '../src/lib/document-shares.js';
import { visibleFilesSql } from '../src/lib/workspace-export/attachments.js';
import { driveListQuery, drivesWithoutManagerQuery } from '../src/lib/drives.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { planningGrowth, type Growth } from './fixtures/planning-growth.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SIZES = [10, 50, 200] as const;
const ANON_MB = 24;
const PEAK_MB = 48;
type Statement = { sql: string; params: unknown[] };
const query = (statement: SQL): Statement => new PgDialect().sqlToQuery(statement);
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';

before(async () => {
  if (unavailable) return;
  if (await planningGrowth({ sql: 'SELECT 1', params: [] }) === null) {
    unavailable = 'this test database does not let a session read /proc/self/status';
  }
});

after(async () => {
  await closeDb();
});

const mb = (kb: number) => Math.round(kb / 1024);

/**
 * Plans each form at each workspace size and asserts the budget. The forms
 * are built against a fresh fixture of that size, ANALYZEd so the planner
 * sees its rows, then torn down.
 */
async function withinBudget(t: TestContext, forms: (fx: DrivesFixture) => Promise<Array<[string, Statement]>>): Promise<void> {
  const measured: Array<[string, number, Growth]> = [];
  for (const size of SIZES) {
    const fx = await setupDrivesFixture(`planning-${size}`, { documents: size });
    try {
      // An Inbox item for each document, as F9's document_shared items are.
      await fx.client.query(`INSERT INTO attention_items (id, org_id, user_id, kind, lane, dedupe_key, source_type, source_id, title)
        SELECT gen_random_uuid()::text, org_id, $2, 'document_shared', 'updates', 'document_shared:' || id || ':' || $2, 'document', id, title
        FROM documents WHERE org_id = $1`, [fx.orgId, fx.people.member]);
      await fx.client.query(`ANALYZE drives, drive_members, doc_folders, documents, document_shares, doc_favorites, spaces, space_members,
        org_members, users, agent_employees, attention_items, notifications`);
      for (const [name, statement] of await forms(fx)) {
        const growth = await planningGrowth(statement);
        assert.ok(growth, `${name}: measured`);
        measured.push([name, size, growth]);
      }
    } finally {
      await fx.teardown();
    }
  }
  t.diagnostic(`backend growth planning (private / peak MB): ${measured
    .map(([name, size, growth]) => `${name} at ${size} documents ${mb(growth.anon)} / ${mb(growth.peak)}`).join('; ')}`);
  for (const [name, size, growth] of measured) {
    assert.ok(growth.anon < ANON_MB * 1024, `${name} at ${size} documents, private memory: ${growth.anon} kB`);
    assert.ok(growth.peak < PEAK_MB * 1024, `${name} at ${size} documents, peak: ${growth.peak} kB`);
  }
}

test('the document access check plans within budget', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await withinBudget(t, async (fx) => {
    const { member } = fx.people;
    const [document] = await db.select({ id: documents.id }).from(documents).where(eq(documents.org_id, fx.orgId)).limit(1);
    return [
      // A list of documents (a drive's tree, recent documents).
      ['document list', db.select({ id: documents.id, title: documents.title }).from(documents)
        .where(and(eq(documents.drive_id, fx.workspaceDriveId), visibleDocumentCondition(member, fx.orgId)))
        .orderBy(desc(documents.updated_at)).limit(200).toSQL()],
      ['document list, at least edit', db.select({ id: documents.id }).from(documents)
        .where(visibleDocumentCondition(member, fx.orgId, 'edit')).limit(200).toSQL()],
      // The role of one document, on every request and live-editing connection: the point lookup, which
      // plans the condition once for each role.
      ['documentRoleFor (point lookup)', query(documentRoleQuery(member, fx.orgId, document!.id))],
      // Who in a chat can't open a document (the posting prompt).
      ['spaceMembersWhoCannotOpen', query(spaceMembersWhoCannotOpenQuery(fx.orgId, fx.spaces.team, document!.id))],
      // Whom a share newly reaches on each page it writes, before it is written (F9; consult S-F3): a chat's
      // members over a tree of 50 pages, and a person.
      ['newly reached by a chat share, per page', query(newlyReachedQuery(fx.orgId, fx.people.owner, 'space', fx.spaces.team,
        (await db.select({ id: documents.id }).from(documents).where(eq(documents.org_id, fx.orgId)).limit(50)).map((row) => row.id), 'edit'))],
      ['newly reached by a person share, per page', query(newlyReachedQuery(fx.orgId, fx.people.owner, 'user', member, [document!.id], 'edit'))],
      // Who is sent document:updated for a drive's documents (rule C4): one statement for all of them.
      ['documentViewers (events)', query(documentViewersQuery(fx.orgId,
        (await db.select({ id: documents.id }).from(documents).where(eq(documents.org_id, fx.orgId)).limit(50)).map((row) => row.id)))],
    ];
  });
});

test('the drive list plans within budget', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await withinBudget(t, async (fx) => {
    const { admin, member } = fx.people;
    return [
      // GET /api/drives, as the route runs it: each drive's role, plus the private drives an owner or admin sees listed.
      ['drive list', query(driveListQuery(admin, fx.orgId))],
      ['drive list (a member)', query(driveListQuery(member, fx.orgId))],
      ['drive list, at least edit', db.select({ id: drives.id }).from(drives).where(visibleDriveCondition(member, fx.orgId, 'edit')).toSQL()],
      // The role on one drive: the point lookup, the drive condition once for each role.
      ['driveRoleFor (point lookup)', query(driveRoleQuery(member, fx.orgId, fx.workspaceDriveId))],
      // GET /api/drives/without-manager: the private drives nobody active holds full on (F6).
      ['drives without a manager', query(drivesWithoutManagerQuery(fx.orgId))],
    ];
  });
});

test('the drive tree and the recent list plan within budget', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await withinBudget(t, async (fx) => {
    const { member } = fx.people;
    // A sub-page where the workspace has one (the deepest breadcrumb), else any document.
    const [document] = await db.select({ id: documents.id }).from(documents).where(eq(documents.org_id, fx.orgId))
      .orderBy(sql`${documents.parent_document_id} IS NULL`, documents.id).limit(1);
    return [
      // GET /api/drives/:id/tree: the drive's documents the caller can see.
      ['drive tree', driveTreeDocumentsQuery(member, fx.orgId, fx.workspaceDriveId).toSQL()],
      // GET /api/documents/recent and /favorites.
      ['recent documents', recentDocumentsQuery(member, fx.orgId).toSQL()],
      ['favourite documents', favoriteDocumentsQuery(member, fx.orgId).toSQL()],
      // The breadcrumb's page chain, each page held to the access check (GET /api/documents/:id).
      ['breadcrumb page chain', query(breadcrumbChainQuery(member, fx.orgId, document!.id))],
    ];
  });
});

test('the chat document forms plan within budget (F13)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await withinBudget(t, async (fx) => {
    const { member, member2 } = fx.people;
    const ids = (await db.select({ id: documents.id }).from(documents).where(eq(documents.org_id, fx.orgId)).limit(50)).map((row) => row.id);
    return [
      // POST /api/documents/cards: up to 50 cards, each with the viewer's role and the drive's name where they can see it.
      ['document cards (50 ids)', query(documentCardsQuery(member, fx.orgId, ids))],
      // GET /api/spaces/:id/documents: a page of the documents shared into a chat (the seed shares one in four with
      // `other`), the first and a later one, and whether the viewer holds full on some drive (`can_link`).
      ['documents shared into a chat, first page', query(spaceSharedDocumentsQuery(member2, fx.orgId, fx.spaces.other))],
      ['documents shared into a chat, later page', query(spaceSharedDocumentsQuery(member2, fx.orgId, fx.spaces.other,
        { at: '2026-11-26T10:00:00.000000', id: 'share-cursor' }))],
      ['can_link: full on some drive', fullDriveQuery(member, fx.orgId).toSQL()],
      // Posting a message with documents: the poster can open each one (at most five).
      ['posting check (5 ids)', postableDocumentsQuery(member, fx.orgId, ids.slice(0, 5)).toSQL()],
    ];
  });
});

test('the composed Inbox rule for document items plans within budget (F9)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await withinBudget(t, async (fx) => {
    const { member } = fx.people;
    const mine = and(eq(attentionItems.org_id, fx.orgId), eq(attentionItems.user_id, member));
    // The production predicate (lib/attention.ts visibleAttentionCondition) as routes/attention.ts runs it on the
    // source types it read: the legacy-notification check (nativeNotificationAccessSql, with its drive and document
    // branches) and the source dispatch with the document rule. The whole rule, every type at once, carries the
    // review gate and has its own budget (attention-visibility-narrowing-db.test.ts).
    return [
      ['Inbox rule, document items', db.select({ id: attentionItems.id }).from(attentionItems)
        .where(and(mine, visibleAttentionCondition(member, ['document'])))
        .orderBy(desc(attentionItems.last_event_at), desc(attentionItems.id)).limit(51).toSQL()],
      ['Inbox rule, document and notification items', db.select({ id: attentionItems.id }).from(attentionItems)
        .where(and(mine, visibleAttentionCondition(member, ['document', 'notification'])))
        .orderBy(desc(attentionItems.last_event_at), desc(attentionItems.id)).limit(51).toSQL()],
      ['Inbox counts, document items', db.select({ lane: attentionItems.lane, count: sql<number>`count(*)::int` }).from(attentionItems)
        .where(and(mine, visibleAttentionCondition(member, ['document']))).groupBy(attentionItems.lane).toSQL()],
    ];
  });
});

test('the attention, export and retrieval forms plan within budget', async (t) => {
  if (unavailable) return t.skip(unavailable);
  await withinBudget(t, async (fx) => {
    const { member } = fx.people;
    const words = 'seed document';
    return [
      // GET /api/notifications: the notification rule, with its drive (F4) and document (F9) branches, on every list and count.
      ['notifications list (drive and document branches)', db.select({ id: notifications.id }).from(notifications).where(and(
        eq(notifications.user_id, member), eq(notifications.org_id, fx.orgId),
        nativeNotificationAccessSql(member, sql`${notifications.metadata}`, sql`${notifications.org_id}`),
      )).orderBy(desc(notifications.created_at)).limit(50).toSQL()],
      // GET /api/dashboard's unread count: the same rule, as a count.
      ['dashboard unread count', db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(and(
        eq(notifications.org_id, fx.orgId), eq(notifications.user_id, member), eq(notifications.is_read, false),
        nativeNotificationAccessSql(member, sql`${notifications.metadata}`, sql`${notifications.org_id}`),
      )).toSQL()],
      // The Inbox rule for document items (F9): the item's workspace and document are columns of the statement.
      ['attention items', db.select({ id: attentionItems.id }).from(attentionItems).where(and(
        eq(attentionItems.org_id, fx.orgId), eq(attentionItems.user_id, member), eq(attentionItems.source_type, 'document'),
        visibleDocumentIdSql(member, sql`${attentionItems.org_id}`, sql`${attentionItems.source_id}`),
      )).orderBy(desc(attentionItems.last_event_at)).limit(50).toSQL()],
      // A member's workspace export (F17): every dataset filtered by the document id of its rows.
      ['export documents', query(sql`SELECT export_document.id, export_document.drive_id, export_document.folder_id,
          export_document.parent_document_id, export_document.title, export_document.content_json,
          export_document.created_at, export_document.updated_at
        FROM documents export_document
        WHERE export_document.org_id = ${fx.orgId} AND export_document.is_deleted = false
          AND ${visibleDocumentIdSql(member, fx.orgId, sql`export_document.id`)}
        ORDER BY export_document.created_at, export_document.id`)],
      // A member's export of attachments (F10): a file documents link is decided by them, at view or at edit.
      ['export files (document images)', query(visibleFilesSql({ orgId: fx.orgId, scope: { kind: 'member', user_id: member, role: 'member' } }))],
      ['export shares', query(sql`SELECT share.document_id, share.principal_type, share.principal_id, share.role, share.created_at
        FROM document_shares share
        WHERE share.org_id = ${fx.orgId} AND share.principal_type = 'user' AND share.principal_id = ${member}
          AND ${visibleDocumentIdSql(member, fx.orgId, sql`share.document_id`)}
        ORDER BY share.document_id, share.created_at, share.id`)],
      // Defty's retrieval (retrieveContext's documents until H2) and search's documents group.
      ['retrieval', db.select({ id: documents.id, title: documents.title, text: documents.content_text }).from(documents).where(and(
        eq(documents.org_id, fx.orgId), eq(documents.is_deleted, false), visibleDocumentCondition(member, fx.orgId),
        or(ilike(documents.title, `%${words}%`), ilike(documents.content_text, `%${words}%`)),
      )).limit(10).toSQL()],
      ['search', db.select({ id: documents.id, title: documents.title }).from(documents).where(and(
        eq(documents.org_id, fx.orgId), visibleDocumentCondition(member, fx.orgId),
        sql`${documents.search_vector} @@ websearch_to_tsquery('simple', ${words})`,
      )).orderBy(sql`ts_rank(${documents.search_vector}, websearch_to_tsquery('simple', ${words})) DESC`).limit(10).toSQL()],
    ];
  });
});
