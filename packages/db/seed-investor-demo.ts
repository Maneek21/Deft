/**
 * Investor demo seed — "Northstar Labs" (builders of Flow, clinic scheduling).
 *
 * NON-DESTRUCTIVE. It never truncates and never wipes the database. It:
 *   1. updates the fixed roster rows (org, Maneek, Maya, Leo, Amina, Noah),
 *   2. removes Priya from this org (the user row survives),
 *   3. renames the Hermes BYOA agent to Scout,
 *   4. soft-deletes stale demo rows that match the release/email/LIVE patterns,
 *   5. inserts ~21 days of chat, tasks, wiki, notes, calendar, standups,
 *      contacts, notifications and reminders for the investor walkthrough.
 *
 * Timestamps are written as UTC wall-clock text (see `bindUtcTimestamps`) so the
 * demo reads correctly from an IST laptop or a UTC server.
 *
 * Everything runs in one transaction. Errors abort the whole seed. Cleanup is
 * soft-delete only: no hard deletes, no "Archived: " renames. The optional
 * reaction/tag inserts still use savepoints instead of `.catch`, because a
 * caught error would poison the surrounding transaction.
 *
 * Idempotent: if the org is already named "Northstar Labs" and a message with
 * metadata.seed = "investor-demo-v1" exists, it prints "already seeded" and
 * exits 0 without writing anything.
 *
 * Usage (normal):
 *   DATABASE_URL=postgres://... pnpm exec tsx packages/db/seed-investor-demo.ts
 *
 * Usage (local throwaway DB, proves idempotency, rolls back at the end):
 *   DEFT_INVESTOR_SEED_LOCAL_URL=postgres://deft:deft@127.0.0.1:5432/deft_test \
 *     pnpm exec tsx packages/db/seed-investor-demo.ts --self-test
 *
 * `--self-test` refuses to run against a non-local host.
 */
import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as schema from './src/schema.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../.env') });

type Db = NodePgDatabase<typeof schema>;

// ── Fixed identity ──────────────────────────────────────────────────────────
const SEED_MARKER = 'investor-demo-v1';
const ORG_ID = '584e5a84-5f0f-4d70-a7bb-86e160c3051d';
const MANEEK = '4be16c0f-09e4-4d8d-a22f-09efd2b49934';
const MAYA = '4133a97e-9df6-4b50-8a2e-f8c5859d34f7';
const LEO = 'f16b7e82-2579-4952-8361-485ca6e9e218';
const AMINA = '81c008c8-953f-414f-b5e0-afbe9ee0784e';
const NOAH = 'c843c850-7c24-43c8-88f8-bc42486f9079';
const PRIYA = 'fd9514fa-9ce1-4a8b-a065-3f74243046f2';
const DEFTY_FALLBACK_ID = 'deft-system-agent';
/** Resolved from users.email on every run so we never fork the platform agent. */
let DEFTY = DEFTY_FALLBACK_ID;
const SCOUT_USER = 'c43330ec-6fe0-438e-8479-76f0a0a4207f';
const SCOUT_SLUG = 'hermes-rel261018';

/** Canonical person mention token used by the chat renderer. */
function at(userId: string): string {
  return `@[[deft:person:${userId}]]`;
}

// ── Time helpers (Asia/Kolkata, UTC+5:30) ───────────────────────────────────
const MINUTE = 60_000;
const DAY = 86_400_000;
const IST_OFFSET = 5.5 * 60 * MINUTE;

function istParts(date: Date): { y: number; m: number; d: number; dow: number } {
  const shifted = new Date(date.getTime() + IST_OFFSET);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    dow: shifted.getUTCDay(),
  };
}

/** Wall-clock time in IST for a day offset relative to now. */
function atIST(dayOffset: number, hour: number, minute = 0): Date {
  const p = istParts(new Date(Date.now() + dayOffset * DAY));
  return new Date(Date.UTC(p.y, p.m, p.d, hour, minute) - IST_OFFSET);
}

function isWeekend(dayOffset: number): boolean {
  const dow = istParts(new Date(Date.now() + dayOffset * DAY)).dow;
  return dow === 0 || dow === 6;
}

/** n most recent working days, newest first (offset -1 is yesterday). */
function workingDaysBack(n: number): number[] {
  const out: number[] = [];
  let offset = -1;
  while (out.length < n) {
    if (!isWeekend(offset)) out.push(offset);
    offset -= 1;
  }
  return out;
}

/** n upcoming working days, nearest first. */
function workingDaysAhead(n: number): number[] {
  const out: number[] = [];
  let offset = 1;
  while (out.length < n) {
    if (!isWeekend(offset)) out.push(offset);
    offset += 1;
  }
  return out;
}

function istDateStamp(date: Date): string {
  const p = istParts(date);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** November 11 of the current (or next) year, 09:00 IST. */
function nextNovember11(): Date {
  const now = istParts(new Date());
  let year = now.y;
  if (now.m > 10 || (now.m === 10 && now.d > 11)) year += 1;
  return new Date(Date.UTC(year, 10, 11, 9, 0) - IST_OFFSET);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Row counts ──────────────────────────────────────────────────────────────
type Counts = Record<string, number>;

class Tracker {
  readonly counts: Counts = {};
  bump(table: string, rows = 1): void {
    this.counts[table] = (this.counts[table] ?? 0) + rows;
  }
}

function printCounts(counts: Counts): void {
  const entries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  const width = Math.max(...entries.map(([name]) => name.length), 12);
  console.log('\nRows created:');
  for (const [name, count] of entries) {
    console.log(`  ${name.padEnd(width)}  ${count}`);
  }
  console.log(`  ${'TOTAL'.padEnd(width)}  ${entries.reduce((sum, [, count]) => sum + count, 0)}`);
}

// ── Optional inserts (savepoint instead of .catch, so the tx survives) ──────
let savepointSeq = 0;
async function withSavepoint<T>(db: Db, fn: () => Promise<T>): Promise<T | null> {
  const name = `investor_seed_sp_${++savepointSeq}`;
  await db.execute(sql.raw(`SAVEPOINT ${name}`));
  try {
    const result = await fn();
    await db.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return result;
  } catch {
    await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    await db.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return null;
  }
}

// ── Cleanup patterns ────────────────────────────────────────────────────────
const CLEANUP_PREFIX = /^(LIVE|REL|SF0|Email acceptance|Email Sideload|Record checklist|Review checklist|Onboarding handoff|Technical review|CRM follow-up|Review recipient|Developer preview|LIVE[0-9])/i;
const CLEANUP_STARTS_WITH = [
  'Controlled ',
  'Synthetic ',
];
const CLEANUP_CONTAINS = [
  'Deft Email demo evidence',
  'Developer Preview Acceptance',
  'Email Sideload',
  'Release triage',
  'Release pilot',
  'Sol 5.6',
  'acceptance',
  'REL26',
  'LIVE26',
  '[REL',
  'REL261018',
];

function matchesCleanup(label: string | null): boolean {
  if (!label) return false;
  const value = label.trim();
  if (!value) return false;
  if (CLEANUP_PREFIX.test(value)) return true;
  const lower = value.toLowerCase();
  if (CLEANUP_STARTS_WITH.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return true;
  return CLEANUP_CONTAINS.some((fragment) => lower.includes(fragment.toLowerCase()));
}

// Fresh workspace: every pre-existing content row in the org is hidden, not just
// test-named ones. Pass --patterns-only to fall back to the pattern match.
const FRESH_WORKSPACE = !process.argv.includes('--patterns-only');

function shouldHide(label: string | null): boolean {
  return FRESH_WORKSPACE || matchesCleanup(label);
}

function moduleRecordMatchesCleanup(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  for (const key of ['name', 'title', 'subject']) {
    const value = record[key];
    if (typeof value === 'string' && matchesCleanup(value)) return true;
  }
  const tags = record.tags;
  if (Array.isArray(tags)) {
    return tags.some((tag) => typeof tag === 'string' && matchesCleanup(tag));
  }
  if (typeof tags === 'string') {
    return matchesCleanup(tags) || tags.split(',').some((tag) => matchesCleanup(tag));
  }
  return false;
}

type CleanupResult = {
  softDeleted: number;
  renamed: number;
  byTable: Record<string, number>;
};

const columnCache = new Map<string, Set<string>>();

async function tableColumns(db: Db, table: string): Promise<Set<string>> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const result = await db.execute(sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `);
  const columns = new Set((result.rows as Array<{ column_name: string }>).map((row) => row.column_name));
  columnCache.set(table, columns);
  return columns;
}

/**
 * Soft-delete rows by id. Only sets columns that actually exist on the table, so
 * this stays correct across schema drift (for example `spaces` has `is_archived`
 * and `updated_at` but no `is_deleted`/`deleted_at`).
 */
async function softDeleteRows(
  db: Db,
  table: string,
  ids: string[],
  extraSets: SQL[] = [],
): Promise<number> {
  if (ids.length === 0) return 0;
  const columns = await tableColumns(db, table);
  const sets: SQL[] = [];
  if (columns.has('is_deleted')) sets.push(sql`is_deleted = true`);
  if (columns.has('deleted_at')) sets.push(sql`deleted_at = now()`);
  if (columns.has('is_archived')) sets.push(sql`is_archived = true`);
  if (columns.has('updated_at')) sets.push(sql`updated_at = now()`);
  if (sets.length === 0) return 0;
  sets.push(...extraSets);

  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  const result = await db.execute(sql`
    update ${sql.raw(`"${table}"`)}
    set ${sql.join(sets, sql`, `)}
    where org_id = ${ORG_ID} and id in (${idList})
  `);
  return result.rowCount ?? ids.length;
}

/**
 * Space ids that cannot be soft-deleted because an `app_*` table points at them.
 * The first query follows real foreign keys (covers app_private_defty_seals and
 * anything else that gains an FK later). The second catches app_* tables that
 * carry a space id without a constraint.
 */
async function loadReferencedSpaceIds(db: Db): Promise<Set<string>> {
  const referenced = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) referenced.add(value);
  };

  const fkColumns = await db.execute(sql`
    select c.relname as table_name, a.attname as column_name
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_class ref on ref.oid = con.confrelid
    join pg_namespace n on n.oid = c.relnamespace
    join lateral unnest(con.conkey) as keys(attnum) on true
    join pg_attribute a on a.attrelid = c.oid and a.attnum = keys.attnum
    where n.nspname = 'public'
      and ref.relname = 'spaces'
  `);
  const fkTargets = (fkColumns.rows as Array<{ table_name: string; column_name: string }>)
    .filter((row) => row.table_name.startsWith('app_'));

  const looseColumns = await db.execute(sql`
    select table_name, column_name, data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name like 'app%'
      and column_name like '%space%id%'
  `);
  const looseTargets = (looseColumns.rows as Array<{ table_name: string; column_name: string; data_type: string }>)
    .filter((row) => row.table_name.startsWith('app_'));

  const seen = new Set<string>();
  const targets = [...fkTargets, ...looseTargets].filter((row) => {
    const key = `${row.table_name}.${row.column_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return /^[a-z0-9_]+$/.test(row.table_name) && /^[a-z0-9_]+$/.test(row.column_name);
  });

  for (const target of targets) {
    const column = target.column_name;
    const isArray = 'data_type' in target && target.data_type === 'ARRAY';
    const result = await db.execute(sql`
      select distinct ${isArray
        ? sql`unnest(${sql.raw(`"${column}"`)})::text`
        : sql`${sql.raw(`"${column}"`)}::text`} as space_id
      from ${sql.raw(`"${target.table_name}"`)}
      where ${sql.raw(`"${column}"`)} is not null
    `);
    for (const row of result.rows as Array<{ space_id: string | null }>) add(row.space_id);
  }
  return referenced;
}

async function cleanupAgainstPatterns(db: Db): Promise<CleanupResult> {
  const byTable: Record<string, number> = {};
  let renamed = 0;
  const note = (table: string, rows: number) => {
    if (rows > 0) byTable[table] = (byTable[table] ?? 0) + rows;
  };

  // DMs with the old "Email Demo" label get their names normalised first.
  const demoDms = await db
    .select({ id: schema.spaces.id, name: schema.spaces.name })
    .from(schema.spaces)
    .where(and(
      eq(schema.spaces.org_id, ORG_ID),
      inArray(schema.spaces.type, ['dm', 'group_dm']),
      ilike(schema.spaces.name, '%Email Demo%'),
    ));
  for (const row of demoDms) {
    const nextName = row.name.replace(/Email Demo/gi, 'Maneek');
    if (nextName === row.name) continue;
    await db.update(schema.spaces)
      .set({ name: nextName, updated_at: new Date() })
      .where(eq(schema.spaces.id, row.id));
    renamed += 1;
    console.log(`[cleanup] renamed dm "${row.name}" -> "${nextName}"`);
  }

  const staleTasks = await db
    .select({ id: schema.tasks.id, label: schema.tasks.title })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.org_id, ORG_ID), eq(schema.tasks.is_deleted, false)));
  const taskIds = staleTasks.filter((row) => shouldHide(row.label)).map((row) => row.id);
  const deletedTasks = await softDeleteRows(db, 'tasks', taskIds);
  note('tasks', deletedTasks);
  for (const row of staleTasks) {
    if (shouldHide(row.label)) console.log(`[cleanup] soft-deleted task "${row.label}"`);
  }

  const staleProjects = await db
    .select({ id: schema.projects.id, label: schema.projects.name })
    .from(schema.projects)
    .where(and(eq(schema.projects.org_id, ORG_ID), eq(schema.projects.is_deleted, false)));
  const projectIds = staleProjects.filter((row) => shouldHide(row.label)).map((row) => row.id);
  const deletedProjects = await softDeleteRows(db, 'projects', projectIds);
  note('projects', deletedProjects);
  for (const row of staleProjects) {
    if (shouldHide(row.label)) console.log(`[cleanup] soft-deleted project "${row.label}"`);
  }

  const referencedSpaceIds = await loadReferencedSpaceIds(db);
  const staleSpaces = await db
    .select({ id: schema.spaces.id, label: schema.spaces.name, type: schema.spaces.type })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.org_id, ORG_ID), eq(schema.spaces.is_archived, false)));
  const spaceIdsToDelete: string[] = [];
  const keptSpaceIds: string[] = [];
  for (const row of staleSpaces) {
    if (!shouldHide(row.label)) continue;
    if (referencedSpaceIds.has(row.id)) {
      // App-owned spaces stay; only their visible name is made natural.
      keptSpaceIds.push(row.id);
      const natural = row.type === 'agent_conversation' ? 'Defty' : row.type === 'dm' ? 'Maneek, Defty' : null;
      if (natural && row.label !== natural && matchesCleanup(row.label)) {
        await db.update(schema.spaces)
          .set({ name: natural, updated_at: new Date() })
          .where(eq(schema.spaces.id, row.id));
        renamed += 1;
        console.log(`[cleanup] kept app-referenced ${row.type} "${row.label}" (renamed -> "${natural}")`);
      }
      continue;
    }
    spaceIdsToDelete.push(row.id);
  }
  const deletedSpaces = await softDeleteRows(db, 'spaces', spaceIdsToDelete);
  note('spaces', deletedSpaces);

  if (FRESH_WORKSPACE) {
    // Every old message in the org is hidden, so search and Defty never surface it.
    {
      const oldMessages = await db
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(sql`${schema.messages.is_deleted} = false and ${schema.messages.space_id} in (select id from spaces where org_id = ${ORG_ID})`);
      note('messages', await softDeleteRows(db, 'messages', oldMessages.map((row) => row.id)));
    }
    // Side tables without a soft-delete flag: remove this org's old rows (backups keep them).
    const orgScoped: Array<[string, SQL]> = [
      ['notifications', sql`delete from notifications where org_id = ${ORG_ID}`],
      ['meeting_briefs', sql`delete from meeting_briefs where org_id = ${ORG_ID} or event_id in (select id from events where org_id = ${ORG_ID})`],
      ['events', sql`delete from events where org_id = ${ORG_ID}`],
      ['standups', sql`delete from standups where org_id = ${ORG_ID}`],
      ['reminders', sql`delete from reminders where org_id = ${ORG_ID}`],
      ['attention_items', sql`delete from attention_items where org_id = ${ORG_ID}`],
      ['message_bookmarks', sql`delete from message_bookmarks where org_id = ${ORG_ID}`],
      ['pinned_messages', sql`delete from pinned_messages where space_id in (select id from spaces where org_id = ${ORG_ID})`],
      ['user_group_members', sql`delete from user_group_members where group_id in (select id from user_groups where org_id = ${ORG_ID})`],
      ['user_groups', sql`delete from user_groups where org_id = ${ORG_ID}`],
    ];
    for (const [table, statement] of orgScoped) {
      const result = await withSavepoint(db, () => db.execute(statement));
      if (result === null) console.log(`[cleanup] kept old ${table} rows (delete blocked)`);
      else note(table, Number((result as { rowCount?: number }).rowCount ?? 0));
    }
  }
  for (const row of staleSpaces) {
    if (spaceIdsToDelete.includes(row.id)) console.log(`[cleanup] soft-deleted space "${row.label}"`);
  }

  const staleWiki = await db
    .select({ id: schema.wikiPages.id, label: schema.wikiPages.title })
    .from(schema.wikiPages)
    .where(and(eq(schema.wikiPages.org_id, ORG_ID), eq(schema.wikiPages.is_deleted, false)));
  const wikiIds = staleWiki.filter((row) => shouldHide(row.label)).map((row) => row.id);
  const deletedWiki = await softDeleteRows(db, 'wiki_pages', wikiIds);
  note('wiki_pages', deletedWiki);
  for (const row of staleWiki) {
    if (shouldHide(row.label)) console.log(`[cleanup] soft-deleted wiki page "${row.label}"`);
  }

  const staleNotes = await db
    .select({ id: schema.notes.id, label: schema.notes.title })
    .from(schema.notes)
    .where(and(eq(schema.notes.org_id, ORG_ID), eq(schema.notes.is_deleted, false)));
  const noteIds = staleNotes.filter((row) => shouldHide(row.label)).map((row) => row.id);
  const deletedNotes = await softDeleteRows(db, 'notes', noteIds);
  note('notes', deletedNotes);
  for (const row of staleNotes) {
    if (shouldHide(row.label)) console.log(`[cleanup] soft-deleted note "${row.label}"`);
  }

  // CRM records: all collections of the Contacts installation.
  const [contactsInstallation] = await db
    .select({ id: schema.moduleInstallations.id })
    .from(schema.moduleInstallations)
    .where(sql`${schema.moduleInstallations.org_id} = ${ORG_ID}
      and ${schema.moduleInstallations.module_id} = 'com.deft.contacts'
      and ${schema.moduleInstallations.is_deleted} = false`)
    .limit(1);
  if (contactsInstallation) {
    const crmRows = await db
      .select({
        id: schema.moduleRecords.id,
        data: schema.moduleRecords.data,
        collectionKey: schema.moduleRecords.collection_key,
        label: schema.moduleRecords.search_title,
      })
      .from(schema.moduleRecords)
      .where(sql`${schema.moduleRecords.org_id} = ${ORG_ID}
        and ${schema.moduleRecords.installation_id} = ${contactsInstallation.id}
        and ${schema.moduleRecords.is_deleted} = false`);
    const crmIds = crmRows.filter((row) => (FRESH_WORKSPACE || moduleRecordMatchesCleanup(row.data))).map((row) => row.id);
    const deletedCrm = await softDeleteRows(db, 'module_records', crmIds, [
      sql`revision = revision + 1`,
      sql`deleted_by_actor_type = 'user'`,
      sql`deleted_by_actor_id = ${MANEEK}`,
      sql`updated_by_actor_type = 'user'`,
      sql`updated_by_actor_id = ${MANEEK}`,
    ]);
    note('module_records', deletedCrm);
    for (const row of crmRows) {
      if ((FRESH_WORKSPACE || moduleRecordMatchesCleanup(row.data))) {
        console.log(`[cleanup] soft-deleted ${row.collectionKey} record "${row.label}"`);
      }
    }
  }

  const softDeleted = Object.values(byTable).reduce((sum, rows) => sum + rows, 0);
  console.log(`[cleanup] ${softDeleted} soft-deleted, ${renamed} renamed`);
  for (const [table, rows] of Object.entries(byTable).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`[cleanup]   ${table}: ${rows}`);
  }
  return { softDeleted, renamed, byTable };
}

// ── Fixed roster / org updates ──────────────────────────────────────────────
/**
 * The platform seed pins Defty to a stable id, but a database seeded before
 * that pin can hold the same account (same unique email) under another id.
 * Prefer the existing row so the demo never forks the system agent identity.
 */
async function resolveDeftyIdentity(db: Db): Promise<void> {
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = 'deft-agent@system.local'`)
    .limit(1);
  if (existing && existing.id !== DEFTY) {
    DEFTY = existing.id;
    console.log(`[roster] using existing Defty user ${DEFTY}`);
  }
}

async function updateFixedRows(db: Db): Promise<void> {
  await resolveDeftyIdentity(db);

  const [org] = await db
    .select({ id: schema.orgs.id, name: schema.orgs.name, slug: schema.orgs.slug })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, ORG_ID));
  if (!org) {
    throw new Error(`Org ${ORG_ID} not found. Create the org (or run --self-test) before seeding.`);
  }

  const slugTaken = await db
    .select({ id: schema.orgs.id })
    .from(schema.orgs)
    .where(eq(schema.orgs.slug, 'northstar-labs'));
  const canTakeSlug = !slugTaken.some((row) => row.id !== ORG_ID);

  await db.update(schema.orgs)
    .set({
      name: 'Northstar Labs',
      ...(canTakeSlug ? { slug: 'northstar-labs' } : {}),
      updated_at: new Date(),
    })
    .where(eq(schema.orgs.id, ORG_ID));
  console.log(`[roster] org -> Northstar Labs${canTakeSlug ? ' (slug northstar-labs)' : ' (slug left unchanged, already taken)'}`);

  await db.update(schema.users)
    .set({
      name: 'Maneek Mohan',
      title: 'Founder & CEO',
      timezone: 'Asia/Kolkata',
      profile_summary: 'Founder and CEO of Northstar Labs. Building Flow so clinics stop losing appointments to a spreadsheet.',
      expertise_tags: ['clinic operations', 'product strategy', 'pricing', 'fundraising'],
      updated_at: new Date(),
    })
    .where(eq(schema.users.id, MANEEK));

  const roster: Array<[string, string]> = [
    [MAYA, 'Maya Rao'],
    [LEO, 'Leo Park'],
    [AMINA, 'Amina Shah'],
    [NOAH, 'Noah Chen'],
  ];
  const titles: Record<string, string> = {
    [MAYA]: 'Head of Product',
    [LEO]: 'Engineering Lead',
    [AMINA]: 'Design Lead',
    [NOAH]: 'Growth & Partnerships',
  };
  for (const [id, name] of roster) {
    await db.update(schema.users)
      .set({ name, title: titles[id] ?? null, updated_at: new Date() })
      .where(eq(schema.users.id, id));
  }

  const rosterIds = [MANEEK, MAYA, LEO, AMINA, NOAH];
  const present = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(inArray(schema.users.id, rosterIds));
  const missing = rosterIds.filter((id) => !present.some((row) => row.id === id));
  if (missing.length > 0) {
    throw new Error(
      `missing fixed user rows (${missing.join(', ')}). Create the Northstar roster before running this seed outside --self-test.`,
    );
  }

  // Defty is the built-in agent identity. Create only if it is missing.
  const [defty] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, DEFTY));
  if (!defty) {
    await db.insert(schema.users).values({
      id: DEFTY,
      email: 'deft-agent@system.local',
      name: 'Defty',
      kind: 'agent',
      is_agent: true,
      email_verified: true,
    }).onConflictDoNothing();
    console.log('[roster] created Defty agent user');
  }
  await db.insert(schema.orgMembers).values({
    org_id: ORG_ID,
    user_id: DEFTY,
    role: 'member',
  }).onConflictDoNothing();

  // Priya leaves this org; her user row is untouched.
  await db.delete(schema.orgMembers).where(sql`${schema.orgMembers.org_id} = ${ORG_ID} and ${schema.orgMembers.user_id} = ${PRIYA}`);
  await db.execute(sql`
    delete from space_members
    where user_id = ${PRIYA}
      and space_id in (select id from spaces where org_id = ${ORG_ID})
  `);
  console.log('[roster] removed Priya Das from the org and its spaces (user kept)');

  // Hermes -> Scout. Slug and channel/token rows are left alone.
  await db.update(schema.users)
    .set({
      name: 'Scout',
      title: 'Research agent: market and competitor research',
      updated_at: new Date(),
    })
    .where(eq(schema.users.id, SCOUT_USER));

  const scouts = await db
    .select({ id: schema.agentEmployees.id })
    .from(schema.agentEmployees)
    .where(sql`${schema.agentEmployees.org_id} = ${ORG_ID} and ${schema.agentEmployees.slug} = ${SCOUT_SLUG}`);
  if (scouts.length === 0) {
    console.log(`[roster] no agent_employees row for slug ${SCOUT_SLUG}; skipped agent rename`);
  } else {
    for (const scout of scouts) {
      await db.update(schema.agentEmployees)
        .set({
          name: 'Scout',
          expertise_description: 'Research agent: market and competitor research',
          job_title: 'Research agent: market and competitor research',
          updated_at: new Date(),
        })
        .where(eq(schema.agentEmployees.id, scout.id));
    }
    console.log(`[roster] renamed agent employee ${SCOUT_SLUG} -> Scout`);
  }
}

// ── Idempotency probe ───────────────────────────────────────────────────────
async function alreadySeeded(db: Db): Promise<boolean> {
  const [org] = await db
    .select({ name: schema.orgs.name })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, ORG_ID));
  if (!org || org.name !== 'Northstar Labs') return false;

  const [marker] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(sql`${schema.messages.org_id} = ${ORG_ID} and ${schema.messages.metadata}->>'seed' = ${SEED_MARKER}`)
    .limit(1);
  return Boolean(marker);
}

// ════════════════════════════════════════════════════════════════════════════
// Main seed
// ════════════════════════════════════════════════════════════════════════════
type SeedResult = { status: 'seeded' | 'already seeded'; counts: Counts; cleanup?: CleanupResult };

const SPACE_KEYS = [
  'general', 'product', 'engineering', 'design', 'growth', 'launch', 'random',
  'dmMaya', 'dmLeo', 'dmAmina', 'dmNoah', 'leadership',
] as const;
type SpaceKey = typeof SPACE_KEYS[number];

type ThreadReply = { who: string; text: string };
type Post = {
  key: string;
  who: string;
  text: string;
  thread?: ThreadReply[];
  pin?: boolean;
};
type Scene = { space: SpaceKey; day: number; start: [number, number]; posts: Post[] };

async function seedWorkspace(db: Db): Promise<SeedResult> {
  if (await alreadySeeded(db)) {
    console.log('already seeded');
    return { status: 'already seeded', counts: {} };
  }

  console.log('Seeding Northstar Labs investor workspace (non-destructive)…');
  const tracker = new Tracker();
  const bump = (table: string, rows = 1) => tracker.bump(table, rows);

  await updateFixedRows(db);

  const cleanup = await cleanupAgainstPatterns(db);
  if (cleanup.softDeleted + cleanup.renamed === 0) console.log('[cleanup] nothing matched the cleanup patterns');

  const now = new Date();
  const historyDays = workingDaysBack(15).reverse(); // oldest -> most recent
  if (historyDays.length < 15) throw new Error('not enough history days');

  // ── Spaces ────────────────────────────────────────────────────────────────
  const everyone = [MANEEK, MAYA, LEO, AMINA, NOAH];
  const membership: Record<SpaceKey, string[]> = {
    general: everyone,
    random: everyone,
    product: everyone,
    engineering: [MANEEK, MAYA, LEO],
    design: [MANEEK, MAYA, AMINA],
    growth: [MANEEK, MAYA, NOAH],
    launch: [MANEEK, MAYA, LEO],
    dmMaya: [MANEEK, MAYA],
    dmLeo: [MANEEK, LEO],
    dmAmina: [MANEEK, AMINA],
    dmNoah: [MANEEK, NOAH],
    leadership: [MANEEK, MAYA, NOAH],
  };

  const spaceIds = {} as Record<SpaceKey, string>;
  const spaceRows: Array<{ key: SpaceKey; name: string; description: string; type: 'public' | 'private' | 'dm' | 'group_dm'; created_by: string }> = [
    { key: 'general', name: 'general', description: 'Company-wide updates, launches, and the Friday note', type: 'public', created_by: MANEEK },
    { key: 'product', name: 'product', description: 'Scope, pricing, and launch decisions', type: 'public', created_by: MAYA },
    { key: 'engineering', name: 'engineering', description: 'Shipping, incidents, and infrastructure', type: 'public', created_by: LEO },
    { key: 'design', name: 'design', description: 'Design system, crits, and product polish', type: 'public', created_by: AMINA },
    { key: 'growth', name: 'growth', description: 'Pilot pipeline, clinic demos, and partnerships', type: 'public', created_by: NOAH },
    { key: 'launch', name: 'launch-v2', description: 'Private launch room for Flow v2', type: 'private', created_by: MANEEK },
    { key: 'random', name: 'random', description: 'Coffee, plants, and everything else', type: 'public', created_by: NOAH },
    { key: 'dmMaya', name: 'Maneek, Maya', description: '', type: 'dm', created_by: MANEEK },
    { key: 'dmLeo', name: 'Maneek, Leo', description: '', type: 'dm', created_by: MANEEK },
    { key: 'dmAmina', name: 'Maneek, Amina', description: '', type: 'dm', created_by: MANEEK },
    { key: 'dmNoah', name: 'Maneek, Noah', description: '', type: 'dm', created_by: MANEEK },
    { key: 'leadership', name: 'leadership', description: 'Founders and functional leads', type: 'group_dm', created_by: MANEEK },
  ];

  const normalizeSpaceName = (name: string): string => name.trim().replace(/^#+/, '').toLowerCase();
  const existingSpaces = await db
    .select({
      id: schema.spaces.id,
      name: schema.spaces.name,
      type: schema.spaces.type,
      is_default: schema.spaces.is_default,
    })
    .from(schema.spaces)
    .where(and(eq(schema.spaces.org_id, ORG_ID), eq(schema.spaces.is_archived, false)));
  const memberRows = await db.execute(sql`
    select sm.space_id, sm.user_id
    from space_members sm
    join spaces s on s.id = sm.space_id
    where s.org_id = ${ORG_ID} and s.is_archived = false
  `);
  const membersBySpace = new Map<string, Set<string>>();
  for (const row of memberRows.rows as Array<{ space_id: string; user_id: string }>) {
    const set = membersBySpace.get(row.space_id) ?? new Set<string>();
    set.add(row.user_id);
    membersBySpace.set(row.space_id, set);
  }
  const memberKey = (spaceId: string): string => [...(membersBySpace.get(spaceId) ?? new Set<string>())].sort().join(',');
  const findReusableSpace = (row: typeof spaceRows[number]) => {
    if (row.type === 'public' || row.type === 'private') {
      const wanted = normalizeSpaceName(row.name);
      return existingSpaces.find((space) =>
        space.type === row.type && normalizeSpaceName(space.name) === wanted);
    }
    const wanted = [...membership[row.key]].sort().join(',');
    return existingSpaces.find((space) =>
      space.type === row.type && memberKey(space.id) === wanted);
  };

  let createdSpaces = 0;
  let reusedSpaces = 0;
  for (const row of spaceRows) {
    const reusable = findReusableSpace(row);
    if (reusable) {
      spaceIds[row.key] = reusable.id;
      reusedSpaces += 1;
      if (row.key === 'general' && !reusable.is_default) {
        await db.update(schema.spaces)
          .set({ is_default: true, updated_at: now })
          .where(eq(schema.spaces.id, reusable.id));
      }
      console.log(`[seed] reusing existing ${row.type} "${reusable.name}" as ${row.key}`);
      continue;
    }
    const [inserted] = await db.insert(schema.spaces).values({
      org_id: ORG_ID,
      name: row.name,
      description: row.description || null,
      type: row.type,
      is_default: row.key === 'general',
      created_by: row.created_by,
      created_at: atIST(historyDays[0]!, 9, 0),
      updated_at: now,
    }).returning({ id: schema.spaces.id });
    spaceIds[row.key] = inserted!.id;
    createdSpaces += 1;
    bump('spaces');
  }

  for (const key of SPACE_KEYS) {
    const inserted = await db.insert(schema.spaceMembers).values(
      membership[key].map((userId) => ({ space_id: spaceIds[key], user_id: userId })),
    ).onConflictDoNothing().returning({ id: schema.spaceMembers.id });
    bump('space_members', inserted.length);
  }
  console.log(`[seed] ${createdSpaces} spaces created, ${reusedSpaces} reused`);

  // ── Messages ──────────────────────────────────────────────────────────────
  const messageIds = new Map<string, { id: string; spaceId: string; createdAt: Date }>();
  let messageCount = 0;

  const insertMessage = async (
    spaceKey: SpaceKey,
    userId: string,
    content: string,
    createdAt: Date,
    parentId?: string,
  ) => {
    const [inserted] = await db.insert(schema.messages).values({
      org_id: ORG_ID,
      space_id: spaceIds[spaceKey],
      user_id: userId,
      content,
      parent_id: parentId ?? null,
      created_at: createdAt,
      updated_at: createdAt,
      metadata: { seed: SEED_MARKER },
    }).returning({ id: schema.messages.id });
    messageCount += 1;
    return inserted!.id;
  };

  const scenes: Scene[] = [
    // ── Day 0 — three weeks ago ──────────────────────────────────────────────
    {
      space: 'general', day: 0, start: [10, 5], posts: [
        { key: 'g-standup', who: MAYA, pin: true, text: 'Morning. Two things before anything else: Lakeview stabilisation, and the v2 pricing call. Everything else waits until those are settled. Standups move to 10:00 IST starting today — invites are on your calendars.' },
        { key: 'g-pilot4', who: MAYA, text: 'Pilot #4 is Harbor Family Clinic. Onboarding starts Monday. Intake checklist is in the Clinic pilot playbook, and I am not accepting "we will figure it out on the call" this time.' },
        { key: 'g-leo-bug', who: LEO, text: 'Engineering is on the double-booking report from Lakeview. Nothing to share yet. It reproduces, which is the good news.' },
        { key: 'g-noah-pipe', who: NOAH, text: 'Pipeline: 11 clinics in conversation, 4 pilot-ready. Full breakdown in #growth in a bit.' },
        { key: 'g-amina-audit', who: AMINA, text: 'Design system audit is done. 38 components, 11 one-offs, four different paddings on the same appointment card. Writing it up today.' },
        { key: 'g-maneek-focus', who: MANEEK, text: 'Good. One product, one story, by November. If it does not help a front desk book a patient faster, it is not in this release.' },
      ],
    },
    {
      space: 'growth', day: 0, start: [11, 20], posts: [
        { key: 'gr-pipeline', who: NOAH, text: 'Pilot pipeline as of this morning: Lakeview Physio (live), Brightside Dental (live), Harbor Family Clinic (onboarding Monday), Northside Pediatrics (verbal).' },
        { key: 'gr-funnel', who: NOAH, text: 'Top of funnel: 34 clinics touched, 11 demos booked, 6 completed, 4 moving. Demo to pilot is 36%. Good, not great.' },
        { key: 'gr-maneek', who: MANEEK, text: 'Where are we losing them?' },
        { key: 'gr-pricegap', who: NOAH, text: 'Price uncertainty, mostly. Two asked for a per-location number and I could not give one. The three-tier thing fixes that in one sentence.' },
        { key: 'gr-maya', who: MAYA, text: 'It also shortens the demo. Fewer options to explain means more time on the scheduling grid.' },
        { key: 'gr-target', who: NOAH, text: 'I want 8 pilots by January. At this rate we land at 6. I am doing demos, onboarding, and support, and support is eating the week.' },
        { key: 'gr-maneek2', who: MANEEK, text: 'Then the constraint is you, not the market. Draft the support hire and we will talk about it Friday.' },
      ],
    },
    {
      space: 'engineering', day: 0, start: [14, 10], posts: [
        { key: 'e-refactor', who: LEO, text: 'v2 branch is green. Slot service refactor landed: booking writes now go through one path instead of three.' },
        { key: 'e-locks', who: LEO, text: 'Postgres advisory locks are in. One lock key per clinic, provider, and day. Cheap and boring, which is what I want in a booking path.' },
        { key: 'e-amina', who: AMINA, text: 'Does that change the grid loading state? Right now we show a spinner per column.' },
        { key: 'e-409', who: LEO, text: 'No UI change. The server returns 409 on conflict, same as before. The difference is that it actually conflicts now.' },
        { key: 'e-flag', who: LEO, text: 'Old path is still behind a flag. I will delete it after the pilot weekend.' },
        { key: 'e-maneek', who: MANEEK, text: 'Delete it. Two paths is how we got here.' },
      ],
    },

    // ── Day 1 ────────────────────────────────────────────────────────────────
    {
      space: 'product', day: 1, start: [9, 45], posts: [
        { key: 'p-scope', who: MAYA, text: 'v2 scope, final: scheduling grid, three-tier pricing, onboarding wizard, design tokens. Everything else is post-launch.' },
        { key: 'p-cut', who: MAYA, text: 'Cut list if we slip: dark mode, saved views, bulk reschedule.' },
        { key: 'p-maneek', who: MANEEK, text: 'Cut dark mode now. Nobody buys a scheduler for dark mode.' },
        { key: 'p-amina', who: AMINA, text: 'I will remember you said that when the app store reviews arrive.' },
        { key: 'p-bulk', who: MAYA, text: 'Bulk reschedule is the one I would fight for. Front desks move half a day of appointments when a provider calls in sick.' },
        { key: 'p-leo', who: LEO, text: 'A week, maybe ten days with tests. The grid selection model is already there.' },
        { key: 'p-order', who: MAYA, text: 'Order is grid, pricing, onboarding, tokens. I will update the launch plan this afternoon.' },
      ],
    },
    {
      space: 'dmMaya', day: 1, start: [16, 30], posts: [
        { key: 'dm-m1', who: MANEEK, text: 'Investor meeting is next Thursday at 3. I want a clean story: pilots, pricing, launch date. No roadmap theatre.' },
        { key: 'dm-m2', who: MAYA, text: 'I will have the launch plan and the pricing decision log ready by Monday. Both are written, just need the final numbers.' },
        { key: 'dm-m3', who: MANEEK, text: 'Add what we cut. They respect a team that cuts.' },
        { key: 'dm-m4', who: MAYA, text: 'Then the cut list stays visible in the plan. It also protects us if they ask why dark mode is not done.' },
        { key: 'dm-m5', who: MANEEK, text: 'And put Noah pipeline numbers early. Numbers first, narrative second.' },
      ],
    },

    // ── Day 2 ────────────────────────────────────────────────────────────────
    {
      space: 'design', day: 2, start: [10, 15], posts: [
        { key: 'd-audit', who: AMINA, text: 'Component audit: 38 components, 11 legitimate variants, 6 accidental ones. The appointment card has four different paddings and nobody can tell me why.' },
        { key: 'd-tokens', who: AMINA, text: 'I am proposing a token layer before we touch any component. Color, spacing, type, radius, elevation. One source of truth, no hex codes in feature code.' },
        { key: 'd-leo', who: LEO, text: 'Does that touch the grid? We are freezing the grid this week.' },
        { key: 'd-scope', who: AMINA, text: 'Tokens first, then a visual pass. Grid migration happens after launch, no structural changes before.' },
        { key: 'd-maya', who: MAYA, text: 'How long?' },
        { key: 'd-est', who: AMINA, text: 'Tokens three days. Grid migration one day. Snapshot updates two.' },
        { key: 'd-maneek', who: MANEEK, text: 'Do it. If the product looks like four products, pricing will not save us.' },
        { key: 'd-thanks', who: AMINA, text: 'That is the nicest thing you have said about design all quarter.' },
      ],
    },
    {
      space: 'engineering', day: 2, start: [15, 40], posts: [
        { key: 'e-bug', who: LEO, text: 'Heads up: Lakeview reported a double booking in production. Two patients, same chair, same time.' },
        { key: 'e-root', who: LEO, text: 'Reproduced. Not a UI bug. Two booking requests raced and both passed the availability check, because the check ran outside the write. The write path had no lock.' },
        { key: 'e-maya', who: MAYA, text: 'How many clinics affected?' },
        { key: 'e-window', who: LEO, text: 'One confirmed. The window is narrow, so probably a handful of near misses we never saw.' },
        { key: 'e-maneek', who: MANEEK, text: 'Fix first, then tell me how it happened.' },
        { key: 'e-ship', who: LEO, text: 'Advisory lock is already in the branch. I can ship tonight behind the existing flag.' },
        { key: 'e-call', who: MAYA, text: 'I will call the practice manager before they call us.' },
        { key: 'e-maneek2', who: MANEEK, text: 'Good. I would rather they hear it from a person.', thread: [
          { who: MAYA, text: 'Can we get a written summary I can send to the other two pilots? They will hear about it from someone eventually.' },
          { who: LEO, text: 'Postmortem entry goes in the engineering runbook by Friday. Short version: we trusted a read, we should have locked the write.' },
          { who: DEFTY, text: 'Incident summary from the last few hours:\n• Two booking writes accepted the same slot because availability was checked outside the write transaction.\n• Leo shipped advisory locks per clinic, provider, and day; 40k synthetic concurrent requests replayed clean.\n• Lakeview Physio is being credited one month; Maya spoke to Dana at 08:15.\nOpen follow-ups I can turn into tasks:\n1. Regression test for concurrent slot writes (Leo, p0)\n2. "Slot just taken" empty state (Amina)\n3. Postmortem in the engineering runbook (Leo, due Friday)\nSay the word and I will open them.' },
        ] },
      ],
    },

    // ── Day 3 ────────────────────────────────────────────────────────────────
    {
      space: 'general', day: 3, start: [9, 30], posts: [
        { key: 'g-lakeview', who: MAYA, text: 'Lakeview update: I spoke to Dana at 08:15. She was calm, which was worse than angry. Two patients rescheduled, no clinical impact.' },
        { key: 'g-fix', who: LEO, text: 'Fix is deployed. Booking writes serialize per provider per day now. I replayed 40k synthetic concurrent requests with zero double bookings.' },
        { key: 'g-credit', who: NOAH, text: 'Do we credit them?' },
        { key: 'g-maneek', who: MANEEK, text: 'Yes. One month free, and I will call Dana myself this afternoon.' },
        { key: 'g-empty', who: AMINA, text: 'I am adding an empty state for "slot just taken". Right now it just errors and the front desk retries blindly, which is how you get a second phone call.' },
        { key: 'g-maya2', who: MAYA, text: 'That is the actual fix from the user side. Server stops it, interface explains it.', thread: [
          { who: NOAH, text: 'I will mention it on the Brightside call Thursday. Better they hear it from us than from a competitor.' },
          { who: MAYA, text: 'Agreed. And no discount offers in that conversation. Credit is a gesture, not a precedent.' },
        ] },
        { key: 'g-leo2', who: LEO, text: 'I am also adding a test that fails if the availability read ever leaves the transaction again. That is the part that bothers me.' },
      ],
    },
    {
      space: 'launch', day: 3, start: [11, 0], posts: [
        { key: 'l-date', who: MANEEK, text: 'Launch is November 11. Not the 4th.' },
        { key: 'l-maya', who: MAYA, text: 'Two extra weeks. I would spend them on onboarding and the pricing page.' },
        { key: 'l-leo', who: LEO, text: 'And on the slot-lock regression suite. I do not want to launch on a fix I shipped in a day.' },
        { key: 'l-freeze', who: MANEEK, text: 'Agreed. November 11, and we stop adding scope today. What is not in, is not in.' },
        { key: 'l-amina', who: AMINA, text: 'Design has three polish items queued. I assume you want one?' },
        { key: 'l-pick', who: MANEEK, text: 'Pick one.' },
      ],
    },
    {
      space: 'dmLeo', day: 3, start: [17, 10], posts: [
        { key: 'dl-1', who: MANEEK, text: 'How bad was it, honestly?' },
        { key: 'dl-2', who: LEO, text: 'Bad but contained. We had no lock and no test that could have caught it. Both are fixed.' },
        { key: 'dl-3', who: MANEEK, text: 'Would you have caught it in review?' },
        { key: 'dl-4', who: LEO, text: 'No. The code looked right. That is the uncomfortable part.' },
        { key: 'dl-5', who: MANEEK, text: 'Then the test matters more than the review. Make sure the suite runs on every pull request, not just before release.' },
      ],
    },

    // ── Day 4 ────────────────────────────────────────────────────────────────
    {
      space: 'product', day: 4, start: [10, 0], posts: [
        { key: 'p-price2', who: NOAH, text: 'Pricing proposal, round two: two tiers at $129 and $349, plus custom for five or more locations.' },
        { key: 'p-maya3', who: MAYA, text: 'I want three named tiers. Two tiers plus "call us" reads like we have not decided.' },
        { key: 'p-99', who: NOAH, text: '$99 to start would get us more pilots. Volume now, price later.' },
        { key: 'p-maneek2', who: MANEEK, text: 'We are not running a discount experiment on clinics that book patients for a living.' },
        { key: 'p-amina3', who: AMINA, text: 'Three tiers is also a design constraint. Three cards fit one row. Four wrap and look broken on a laptop.' },
        { key: 'p-leo3', who: LEO, text: 'Billing complexity scales with feature gates, not tier count. Three is fine.' },
        { key: 'p-names', who: MAYA, text: 'Solo, Clinic, Multi-site. Boring and clear. The middle tier is where most pilots land.' },
        { key: 'p-noah2', who: NOAH, text: 'Clinic at $349 still gets me to the pipeline number if churn holds. I can sell that.', thread: [
          { who: MANEEK, text: 'Then we are settled. Maya writes it down, Noah sells it, nobody invents a fourth tier in a demo.' },
          { who: NOAH, text: 'I have been inventing a fourth tier in demos for three weeks. It was called "let me check with my CEO".' },
        ] },
        { key: 'p-maya4', who: MAYA, text: 'Decision log by end of day. Alternatives and all.' },
      ],
    },
    {
      space: 'random', day: 4, start: [16, 20], posts: [
        { key: 'r-coffee', who: NOAH, text: 'Someone left a bag of filter coffee in the kitchen with a note that says "for the launch team". We are the launch team. It is ours.' },
        { key: 'r-amina', who: AMINA, text: 'It is from the clinic next door. They heard us say "launch" eleven times a day through the wall.' },
        { key: 'r-leo', who: LEO, text: 'We should return it.' },
        { key: 'r-noah2', who: NOAH, text: 'We should invite them to the launch.' },
        { key: 'r-maneek', who: MANEEK, text: 'Return the coffee, invite them anyway.' },
        { key: 'r-amina2', who: AMINA, text: 'Most CEO thing you have said all week.' },
      ],
    },

    // ── Day 5 ────────────────────────────────────────────────────────────────
    {
      space: 'design', day: 5, start: [9, 50], posts: [
        { key: 'd-publish', who: AMINA, pin: true, text: 'Tokens v2.0 are published. Package is @flow/tokens, version 2.0.0.' },
        { key: 'd-scale', who: AMINA, text: 'Color: 6 neutrals, one brand ramp with 5 steps, 4 semantic. Spacing: 4px base, 8 stops. Type: 4 sizes, 2 weights. Radius: 3 values. That is the whole system.' },
        { key: 'd-subtract', who: AMINA, text: 'The point is subtraction. We had 47 colors. Now we have 16.' },
        { key: 'd-leo4', who: LEO, text: 'Does the 4px base break the scheduling grid?' },
        { key: 'd-grid', who: AMINA, text: 'Grid currently uses 6px gutters. Moving to 8px makes rows 2px taller, which fixes the truncated provider names at 1280. It is a bug fix wearing a design hat.', thread: [
          { who: MAYA, text: 'So the thing that looked like churn is going to make the demo look better. Put that in the launch notes.' },
          { who: DEFTY, text: 'Summary of the tokens discussion:\n• v2.0 published: 16 colors (from 47), 8 spacing stops on a 4px base, 4 type sizes, 3 radii.\n• Grid migration moves 6px gutters to 8px, which also fixes truncated provider names at 1280px.\n• Sequence agreed: tokens, then onboarding empty states, then grid migration after launch.\nSuggested tasks: "Migrate scheduling grid to 8px gutters" (Amina, p1) and "Add token usage notes to component docs" (Amina, p3).' },
        ] },
        { key: 'd-maya2', who: MAYA, text: 'So it is a bug fix wearing a design hat.' },
        { key: 'd-maneek3', who: MANEEK, text: 'Ship it before the onboarding work, not after.' },
        { key: 'd-amina3', who: AMINA, text: 'Already in the order. I moved it myself.' },
      ],
    },
    {
      space: 'dmAmina', day: 5, start: [17, 40], posts: [
        { key: 'da-1', who: AMINA, text: 'Look at the onboarding screen with the new tokens. Same layout, completely different read. Sent you a screenshot.' },
        { key: 'da-2', who: MANEEK, text: 'It is calmer. The step indicator was doing too much before.' },
        { key: 'da-3', who: AMINA, text: 'It was three colors. Now it is one color plus a disabled state. That is the entire change.' },
        { key: 'da-4', who: MANEEK, text: 'This is the part investors will remember. Keep going.' },
        { key: 'da-5', who: AMINA, text: 'I need one more week after launch for the grid migration. Not before.' },
        { key: 'da-6', who: MANEEK, text: 'Take the week.' },
      ],
    },

    // ── Day 6 ────────────────────────────────────────────────────────────────
    {
      space: 'growth', day: 6, start: [10, 30], posts: [
        { key: 'gr-numbers', who: NOAH, text: 'Pilot numbers, week 3: 3 live clinics, 41 providers, 1,840 appointments booked through Flow.' },
        { key: 'gr-activation', who: NOAH, text: 'Activation: 3 of 3 clinics finished onboarding in under 9 days. Median time to first booking: 2 days.' },
        { key: 'gr-adoption', who: NOAH, text: 'Retention signal: all three still book daily. Brightside is at 92% of appointments going through Flow, up from 61% three weeks ago.' },
        { key: 'gr-maya3', who: MAYA, text: 'What is the other 8%?' },
        { key: 'gr-habit', who: NOAH, text: 'Walk-ins and phone bookings the front desk forgets to log. It is a habit problem, not a product problem.' },
        { key: 'gr-maneek3', who: MANEEK, text: 'Habits are a product problem. What would make it automatic?' },
        { key: 'gr-sameday', who: NOAH, text: 'A same-day view the front desk keeps open all morning. Amina empty-state work is close to that already.', thread: [
          { who: AMINA, text: 'I will mock the same-day view this week. No promises on scope before launch — but the shape is obvious.' },
          { who: MAYA, text: 'Shape first. We can decide scope after the 11th.' },
        ] },
      ],
    },
    {
      space: 'general', day: 6, start: [17, 0], posts: [
        { key: 'g-friday', who: MAYA, pin: true, text: 'Friday note: Lakeview back to normal booking volume, Brightside at 92% adoption, Harbor onboarding Monday. Pricing settled on three tiers. Launch date locked.' },
        { key: 'g-leo3', who: LEO, text: 'Zero booking conflicts since the fix. 41k requests replayed clean. I am almost bored of saying it.' },
        { key: 'g-noah3', who: NOAH, text: 'Two new demos booked next week. Both multi-site, both found us through the Brightside practice manager.' },
        { key: 'g-amina4', who: AMINA, text: 'Tokens are live in the product with no flag. It just looks like we know what we are doing now.' },
        { key: 'g-maneek4', who: MANEEK, text: 'Good week. Next week is launch prep and the investor meeting. Keep it boring.' },
        { key: 'g-maya5', who: MAYA, text: 'Boring is the plan.' },
      ],
    },

    // ── Day 7 ────────────────────────────────────────────────────────────────
    {
      space: 'product', day: 7, start: [9, 40], posts: [
        { key: 'p-final', who: MAYA, text: 'Final pricing, for the log: Solo $149 per clinic per month, Clinic $399 up to four locations, Multi-site from $1,200 for five or more, annual.' },
        { key: 'p-noah3', who: NOAH, text: '$149 is 30% above what I floated. I need a one-pager for the two clinics that asked, or I will look like I invented it on the call.' },
        { key: 'p-unlimited', who: MANEEK, text: 'Write it as per clinic, per month, unlimited appointments. Unlimited is the story.' },
        { key: 'p-sms', who: LEO, text: 'Fair use on SMS? That is a real cost.' },
        { key: 'p-metered', who: MAYA, text: '1,000 reminder texts per clinic included, then metered at a published rate. It goes on the pricing page, not in a contract footnote.', thread: [
          { who: NOAH, text: 'I will take the one-pager. Both demos next week will ask about it.' },
          { who: MAYA, text: 'I will send it tonight. Do not quote a number for a 12-location group until we have the annual number agreed.' },
        ] },
        { key: 'p-footnote', who: AMINA, text: 'Then the tier cards need a footnote row. Footnotes are where trust lives.' },
        { key: 'p-log', who: MAYA, text: 'Decision log updated with the rejected alternatives: $99, usage-based, and per-provider pricing.' },
      ],
    },
    {
      space: 'dmNoah', day: 7, start: [16, 0], posts: [
        { key: 'dn-1', who: NOAH, text: 'One of the multi-site demos is a 12-location dental group. They will want Multi-site pricing and a security review.' },
        { key: 'dn-2', who: MANEEK, text: 'Timeline?' },
        { key: 'dn-3', who: NOAH, text: 'Q1. They are replacing a system they hate, which is the best kind of buyer.' },
        { key: 'dn-4', who: MANEEK, text: 'Get the security questionnaire early. Do not let it surface in December.' },
        { key: 'dn-5', who: NOAH, text: 'Sending it today.' },
        { key: 'dn-6', who: MANEEK, text: 'And do not quote a number for 12 locations. Bring it to me.' },
      ],
    },

    // ── Day 8 ────────────────────────────────────────────────────────────────
    {
      space: 'engineering', day: 8, start: [10, 10], posts: [
        { key: 'e-latency', who: LEO, text: 'Observability: booking latency p95 is 240ms, p99 610ms. Before the lock it was p95 310ms, so the lock is cheaper than the bug.' },
        { key: 'e-dash', who: LEO, text: 'Added a dashboard: bookings per minute, conflicts, and lock wait time. All tenant-scoped.' },
        { key: 'e-maya4', who: MAYA, text: 'Can I get conflicts by clinic in that dashboard?' },
        { key: 'e-zero', who: LEO, text: 'You can. It will be zero, which is the point.' },
        { key: 'e-badge', who: AMINA, text: 'Can the conflict count show in the UI for front desks? "Attempted, already taken" is reassuring when it is explicit.' },
        { key: 'e-maneek3', who: MANEEK, text: 'Ship the badge with the onboarding work. Do not make a separate project out of it.' },
      ],
    },
    {
      space: 'launch', day: 8, start: [15, 0], posts: [
        { key: 'l-confirm', who: MANEEK, pin: true, text: 'Confirming for the record: Flow v2 launches November 11.' },
        { key: 'l-review', who: MAYA, text: 'Launch review on the 6th, go/no-go on the 9th. Both on the calendar with the checklist attached.' },
        { key: 'l-codefreeze', who: LEO, text: 'Code freeze on the 9th at 18:00. Only sev-1 fixes after that, and I sign off on each one.' },
        { key: 'l-designfreeze', who: AMINA, text: 'Design freeze on the 6th. One item in flight: onboarding empty states.' },
        { key: 'l-comms', who: NOAH, text: 'Comms go out the 11th at 09:30 IST. Pilot clinics get a personal note the night before, from me and Maya.' },
        { key: 'l-slip', who: MANEEK, text: 'Investors will ask what happens if it slips. The answer is that it does not. We already moved it once.', thread: [
          { who: MAYA, text: 'That is the line. I will use it verbatim.' },
          { who: DEFTY, text: 'Launch record as I have it:\n• Flow v2 launches Wednesday, November 11.\n• Design freeze Nov 6; code freeze Nov 9 at 18:00; launch review Nov 6; go/no-go Nov 9.\n• Comms at 09:30 IST on the 11th; pilot clinics get a personal note the night before.\nSuggested tasks: "Book launch-day support rota" (Noah) and "Prepare sev-1 escalation card for launch week" (Leo).' },
        ] },
      ],
    },

    // ── Day 9 ────────────────────────────────────────────────────────────────
    {
      space: 'design', day: 9, start: [11, 30], posts: [
        { key: 'd-wizard', who: AMINA, text: 'Onboarding wizard: four steps, six fields, one "import later" escape hatch. Median pilot setup was 9 days; the wizard should get the setup itself under 10 minutes.' },
        { key: 'd-maya6', who: MAYA, text: 'That is a big claim. What was taking nine days?' },
        { key: 'd-waiting', who: AMINA, text: 'Waiting for someone to email us a spreadsheet, mostly. The wizard lets them skip and fix it later, so the clock stops.' },
        { key: 'd-leo5', who: LEO, text: 'Import later means we keep the mapping job. No schema changes?' },
        { key: 'd-sameorder', who: AMINA, text: 'None. Same columns, better order, honest defaults.' },
        { key: 'd-clinicname', who: MANEEK, text: 'Put the clinic name on the first screen. People trust a product that already knows who they are.' },
        { key: 'd-already', who: AMINA, text: 'Already there. It is the only sentence in 24px.' },
      ],
    },
    {
      space: 'leadership', day: 9, start: [17, 20], posts: [
        { key: 'ld-1', who: MANEEK, text: 'Investor meeting tomorrow at 3. Deck is nine slides. Maya has the plan, Noah has numbers, I have the narrative.' },
        { key: 'ld-2', who: MAYA, text: 'Slides: problem, product, pilots, pricing, launch, pipeline, team, ask, appendix. No roadmap slide. Roadmaps invite arguments about dates we have not committed to.' },
        { key: 'ld-3', who: NOAH, text: 'Pilot numbers are slide four. ARR pipeline is $186k weighted, $410k unweighted including Northside.' },
        { key: 'ld-4', who: MANEEK, text: 'Use weighted. Never show a number we cannot defend line by line.' },
        { key: 'ld-5', who: NOAH, text: 'Agreed. I will footnote the assumptions and keep the sheet open on my laptop.' },
        { key: 'ld-6', who: MAYA, text: 'One risk: they will ask why three clinics and not thirty.' },
        { key: 'ld-7', who: MANEEK, text: 'Because we spent the quarter making the product not double-book. That is the answer, and it is a good one.' },
      ],
    },

    // ── Day 10 ───────────────────────────────────────────────────────────────
    {
      space: 'product', day: 10, start: [10, 20], posts: [
        { key: 'p-checklist', who: MAYA, text: 'Launch checklist is in the wiki. 34 items, 21 done, 9 in flight, 4 blocked on external.' },
        { key: 'p-blocked', who: MAYA, text: 'Blocked: two DNS records, the pricing page legal review, and SMS sender registration.' },
        { key: 'p-dns', who: LEO, text: 'DNS is mine. Doing it today.' },
        { key: 'p-legal', who: NOAH, text: 'Legal said Thursday for the pricing page.' },
        { key: 'p-sms2', who: MANEEK, text: 'SMS registration is the one that worries me. If reminders do not send on day one, the demo is dead.' },
        { key: 'p-chase', who: LEO, text: 'Submitted nine days ago. I will chase the provider today and put the ticket number in the checklist.' },
        { key: 'p-red', who: MAYA, text: 'I will keep it red until it clears. Red items get looked at; amber items get ignored.' },
      ],
    },
    {
      space: 'random', day: 10, start: [18, 10], posts: [
        { key: 'r-plant', who: AMINA, text: 'The new office plant is called Gerald and he is thriving.' },
        { key: 'r-noah3', who: NOAH, text: 'Gerald has better posture than most of us.' },
        { key: 'r-leo3', who: LEO, text: 'Gerald does not have a p99 latency problem.' },
        { key: 'r-maneek2', who: MANEEK, text: 'Gerald is not on the cap table. Back to work.' },
        { key: 'r-maya3', who: MAYA, text: 'It is 6pm on a Friday.' },
        { key: 'r-maneek3', who: MANEEK, text: 'Gerald knows.' },
      ],
    },

    // ── Day 11 ───────────────────────────────────────────────────────────────
    {
      space: 'growth', day: 11, start: [9, 55], posts: [
        { key: 'gr-week', who: NOAH, text: 'Pipeline this week: 14 in conversation, 5 pilot-ready, 2 multi-site. Weighted ARR pipeline moved from $152k to $186k.' },
        { key: 'gr-northside', who: NOAH, text: 'Northside Pediatrics verbally agreed to a January pilot. That is the fifth.' },
        { key: 'gr-maya4', who: MAYA, text: 'January gives us time. Do not onboard them during launch week.' },
        { key: 'gr-feb', who: NOAH, text: 'February. I will tell them capacity, not enthusiasm.' },
        { key: 'gr-maneek4', who: MANEEK, text: 'What is our capacity, honestly?' },
        { key: 'gr-cap', who: NOAH, text: 'Three onboardings at once, one new clinic a week after that. Beyond that, support breaks and the product gets blamed for our staffing.', thread: [
          { who: MANEEK, text: 'Then that is the number we say out loud. Five by Q1, ten by Q2, and we hire ahead of the tenth.' },
          { who: MAYA, text: 'I will put the support hire in the plan with a start date, not a maybe.' },
        ] },
      ],
    },
    {
      space: 'engineering', day: 11, start: [15, 30], posts: [
        { key: 'e-triage', who: LEO, text: 'Bug triage: 14 open, 3 sev-2, 11 cosmetic. Nothing blocking launch.' },
        { key: 'e-sev2', who: LEO, text: 'The sev-2s: a timezone edge on recurring appointments, a stale cache after rescheduling a provider, and the Safari date input.' },
        { key: 'e-maya5', who: MAYA, text: `${at(LEO)} the timezone one is sev-1 for a multi-site clinic.` },
        { key: 'e-tz', who: LEO, text: 'It is sev-1 for exactly one configuration. The fix is two lines and it is in review now.' },
        { key: 'e-safari', who: AMINA, text: 'Safari date input is mine to spec. The native picker is unusable on iOS and the front desk knows it.' },
        { key: 'e-maneek4', who: MANEEK, text: 'Fix the sev-2s, ship cosmetics after launch. No exceptions this week.' },
      ],
    },

    // ── Day 12 ───────────────────────────────────────────────────────────────
    {
      space: 'general', day: 12, start: [10, 0], posts: [
        { key: 'g-investor', who: MANEEK, pin: true, text: 'Advisor session with Meera went well. They asked good questions, which is better than polite ones.' },
        { key: 'g-pilots', who: MAYA, text: 'They pushed on pilot count twice.' },
        { key: 'g-honest', who: MANEEK, text: 'I gave them the honest answer: three pilots, deep, not thirty shallow. They nodded, which I am choosing to interpret positively.' },
        { key: 'g-arr', who: NOAH, text: 'Did they react to $186k weighted?' },
        { key: 'g-breaks', who: MANEEK, text: 'They asked what breaks first if we triple. Answer: support. That is why hiring is on the list.' },
        { key: 'g-bugq', who: LEO, text: 'Did they ask about the double booking?' },
        { key: 'g-disclose', who: MANEEK, text: 'Yes. I told them we found it, fixed it, wrote the test, and credited the clinic. That is the whole story.', thread: [
          { who: AMINA, text: 'Being boring about incidents is underrated. Panic ages badly in a diligence folder.' },
          { who: DEFTY, text: 'Advisor session recap from the thread:\n• Three live pilots, 41 providers, 1,840 appointments booked through Flow.\n• Weighted pipeline $186k; five pilots targeted by Q1, ten by Q2.\n• Double-booking incident disclosed with fix, test, and credit.\nOpen actions: support hire role and band (Maya, this week); one-pager for the two clinics that asked about pricing (Noah); security questionnaire for the 12-location group (Noah, this week).' },
        ] },
      ],
    },
    {
      space: 'dmMaya', day: 12, start: [18, 0], posts: [
        { key: 'dm-m6', who: MANEEK, text: '1:1 tomorrow. Two things: launch ownership and the support hire.' },
        { key: 'dm-m7', who: MAYA, text: 'I want launch ownership in writing. Right now three people think they own the checklist.' },
        { key: 'dm-m8', who: MANEEK, text: 'You own it. I will say it in #launch-v2 so nobody has to guess.' },
        { key: 'dm-m9', who: MAYA, text: 'Second: the support hire is a Q1 cost, not a Q4 maybe. If we triple pilots on current support, we lose a clinic.' },
        { key: 'dm-m10', who: MANEEK, text: 'Draft the role and the band. I will approve both this week.' },
        { key: 'dm-m11', who: MAYA, text: 'And one personal thing. I am taking the 14th off.' },
        { key: 'dm-m12', who: MANEEK, text: 'Take the 15th too.' },
      ],
    },

    // ── Day 13 — yesterday ───────────────────────────────────────────────────
    {
      space: 'launch', day: 13, start: [9, 40], posts: [
        { key: 'l-gonogo', who: MAYA, text: `${at(MANEEK)} go/no-go is Monday and the call is yours. Criteria: all sev-1 closed, onboarding wizard through QA, pricing page live, SMS registration approved.` },
        { key: 'l-owner', who: MAYA, text: 'Also, for the record: I own the launch checklist. If you want something on it, tell me. If you want something off it, tell me earlier.' },
        { key: 'l-tz', who: LEO, text: 'Sev-1s: one open, the timezone fix. Merged, waiting on QA sign-off. I will not mark it closed myself.' },
        { key: 'l-mobile', who: AMINA, text: 'Wizard is through QA on desktop. Mobile has one layout bug at 375px.' },
        { key: 'l-blocker', who: MAYA, text: 'Is it a blocker?' },
        { key: 'l-4px', who: AMINA, text: 'A button overlaps a label by 4px. It is not a blocker, but I am fixing it because I have to look at it.' },
        { key: 'l-smsok', who: NOAH, text: 'SMS registration approved this morning. Confirmation is in my inbox and the ticket is updated.', thread: [
          { who: MANEEK, text: 'Then we are green on Monday unless something new breaks. Nobody adds scope between now and then. That includes clever ideas.' },
          { who: DEFTY, text: 'Go/no-go status, compiled from this thread:\n• Sev-1: timezone fix merged, awaiting QA sign-off.\n• Onboarding wizard: desktop passed; one 375px overlap, being fixed.\n• Pricing page: copy final, legal review due Thursday.\n• SMS sender registration: approved.\nI can post this as the Monday checklist and ping owners at 09:00 IST.' },
        ] },
      ],
    },
    {
      space: 'product', day: 13, start: [16, 40], posts: [
        { key: 'p-copy', who: MAYA, text: 'Pricing page copy, second draft. Headline: "Scheduling that keeps up with your front desk." Three tier cards, one comparison table, one FAQ.' },
        { key: 'p-unlimited2', who: NOAH, text: 'Add "unlimited appointments" under every price. It is the objection killer. Nobody believes a scheduler that meters bookings.' },
        { key: 'p-12px', who: AMINA, text: 'And put the per-clinic clarifying line at 12px, not 10px. We are not hiding it.' },
        { key: 'p-smsrate', who: LEO, text: 'Metered SMS needs a real number in the FAQ. "1,000 included, then $0.012 per message." Anything vaguer reads like a trap.' },
        { key: 'p-confirm', who: MAYA, text: `${at(NOAH)} I will confirm the rate with the provider before publishing. Publish Monday if it holds.` },
        { key: 'p-maneek5', who: MANEEK, text: 'Publish Monday. If the rate changes, we change the page. It is a web page, not a treaty.' },
      ],
    },
  ];

  // Insert in chronological order; thread replies land right after their parent.
  for (const scene of scenes) {
    const dayOffset = historyDays[scene.day];
    if (dayOffset === undefined) throw new Error(`bad history day index ${scene.day}`);
    let cursor = scene.start[0] * 60 + scene.start[1];
    for (const post of scene.posts) {
      const at = Math.min(cursor, 18 * 60 + 45);
      const createdAt = atIST(dayOffset, Math.floor(at / 60), at % 60);
      const parentId = await insertMessage(scene.space, post.who, post.text, createdAt);
      messageIds.set(post.key, { id: parentId, spaceId: spaceIds[scene.space], createdAt });
      cursor += 2 + (post.text.length % 3);

      for (const [index, reply] of (post.thread ?? []).entries()) {
        const replyAt = Math.min(at + index + 1, 18 * 60 + 55);
        const replyTime = atIST(dayOffset, Math.floor(replyAt / 60), replyAt % 60);
        const replyId = await insertMessage(scene.space, reply.who, reply.text, replyTime, parentId);
        messageIds.set(`${post.key}-r${index + 1}`, { id: replyId, spaceId: spaceIds[scene.space], createdAt: replyTime });
      }
      cursor += 1;
    }
  }

  if (messageIds.size < 150) throw new Error(`expected a rich history, got ${messageIds.size} messages`);

  // ── Reactions, pins, bookmarks ────────────────────────────────────────────
  const reactionPlan: Array<[string, string, string]> = [
    ['g-standup', LEO, '👍'], ['g-standup', NOAH, '☕'],
    ['g-pilot4', NOAH, '🎉'],
    ['g-leo-bug', MANEEK, '👀'],
    ['g-amina-audit', MAYA, '🙏'],
    ['gr-pipeline', MANEEK, '📈'],
    ['gr-target', MAYA, '💪'],
    ['e-locks', MANEEK, '✅'], ['e-locks', MAYA, '🙏'],
    ['p-amina', MANEEK, '😄'],
    ['d-audit', MAYA, '😬'], ['d-tokens', LEO, '👍'],
    ['e-bug', MAYA, '🚨'], ['e-bug', MANEEK, '🚨'],
    ['g-fix', MAYA, '✅'], ['g-fix', NOAH, '🔥'],
    ['g-empty', MANEEK, '👍'],
    ['l-date', MAYA, '✅'], ['l-date', LEO, '👍'], ['l-date', AMINA, '🎯'],
    ['p-price2', MAYA, '👀'],
    ['p-99', MANEEK, '🚫'],
    ['p-names', NOAH, '👍'],
    ['r-coffee', AMINA, '☕'], ['r-coffee', LEO, '😐'],
    ['r-maneek', MAYA, '😂'],
    ['d-publish', MAYA, '🎨'], ['d-publish', LEO, '👍'],
    ['d-subtract', MANEEK, '🔥'],
    ['gr-numbers', MANEEK, '📈'], ['gr-numbers', MAYA, '💪'],
    ['g-friday', MANEEK, '✅'], ['g-friday', NOAH, '🎉'],
    ['p-final', NOAH, '💰'], ['p-final', AMINA, '👍'],
    ['e-latency', MAYA, '📊'],
    ['l-confirm', MAYA, '✅'], ['l-confirm', NOAH, '🚀'],
    ['d-wizard', MANEEK, '👏'],
    ['gr-week', MANEEK, '📈'],
    ['g-investor', MAYA, '🎉'], ['g-investor', NOAH, '🚀'],
    ['l-gonogo', MANEEK, '✅'],
    ['p-copy', AMINA, '👍'], ['p-copy', NOAH, '🔥'],
  ];
  let reactionCount = 0;
  for (const [key, userId, emoji] of reactionPlan) {
    const message = messageIds.get(key);
    if (!message) throw new Error(`reaction target "${key}" does not exist`);
    const ok = await withSavepoint(db, async () => {
      await db.insert(schema.reactions).values({ message_id: message.id, user_id: userId, emoji });
      return true;
    });
    if (ok) {
      reactionCount += 1;
      bump('reactions');
    } else {
      console.log(`[reactions] skipped duplicate ${emoji} on ${key}`);
    }
  }

  const pinPlan: Array<[string, string]> = [
    ['d-publish', AMINA],
    ['g-friday', MAYA],
    ['l-confirm', MANEEK],
    ['g-investor', MANEEK],
  ];
  for (const [key, userId] of pinPlan) {
    const message = messageIds.get(key);
    if (!message) throw new Error(`pin target "${key}" does not exist`);
    await db.insert(schema.pinnedMessages).values({
      message_id: message.id,
      space_id: message.spaceId,
      pinned_by: userId,
      pinned_at: message.createdAt,
    });
    bump('pinned_messages');
  }

  for (const key of ['d-publish', 'p-final', 'ld-2']) {
    const message = messageIds.get(key);
    if (!message) throw new Error(`bookmark target "${key}" does not exist`);
    await db.insert(schema.messageBookmarks).values({
      org_id: ORG_ID,
      user_id: MANEEK,
      message_id: message.id,
      space_id: message.spaceId,
      created_at: new Date(message.createdAt.getTime() + 30 * MINUTE),
    });
    bump('message_bookmarks');
  }

  console.log(`[seed] added ${reactionCount} reactions, ${pinPlan.length} pins, 3 bookmarks`);

  console.log(`[seed] inserted ${messageCount} messages`);
  bump('messages', messageCount);

  // ── Projects, labels, tasks ───────────────────────────────────────────────
  type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  type TaskPriority = 'p0' | 'p1' | 'p2' | 'p3';
  type TaskDef = {
    key: string;
    title: string;
    desc: string;
    status: TaskStatus;
    priority: TaskPriority;
    assignee: string | null;
    due: { day: number; hour: number; minute?: number } | null;
    labels: string[];
    createdDay: number;
    parent?: string;
    sourceMessage?: string;
  };

  const v2Tasks: TaskDef[] = [
    { key: 'price-copy', title: 'Pricing page copy — final pass', desc: 'Three tier cards, comparison table, FAQ. Headline: "Scheduling that keeps up with your front desk." Unlimited appointments under every price, per-clinic line at 12px.', status: 'in_progress', priority: 'p1', assignee: MAYA, due: { day: 2, hour: 17 }, labels: ['pricing', 'launch'], createdDay: -6, sourceMessage: 'p-final' },
    { key: 'tier-config', title: 'Configure three pricing tiers in billing', desc: 'Solo $149, Clinic $399 up to four locations, Multi-site from $1,200 annual. 1,000 reminder texts included per clinic, then metered at the published rate.', status: 'todo', priority: 'p1', assignee: LEO, due: { day: 4, hour: 17 }, labels: ['pricing', 'infra'], createdDay: -6 },
    { key: 'regression', title: 'Regression test: concurrent slot booking', desc: 'Two writes race for one provider slot. Asserts exactly one booking lands and the loser gets 409. Fails if the availability read ever leaves the write transaction again.', status: 'in_review', priority: 'p0', assignee: LEO, due: { day: 1, hour: 16 }, labels: ['bug'], createdDay: -3, parent: 'slot-migration', sourceMessage: 'e-bug' },
    { key: 'slot-migration', title: 'Ship slot-lock migration for booking writes', desc: 'Advisory lock keyed on clinic, provider, and day. All booking writes go through one path. Old path deleted after the pilot weekend.', status: 'done', priority: 'p0', assignee: LEO, due: { day: -2, hour: 18 }, labels: ['infra', 'bug'], createdDay: -5 },
    { key: 'checklist', title: 'Launch checklist sign-off', desc: '34 items. Needs all sev-1 closed, onboarding wizard through QA, pricing page live, and SMS registration approved before Monday go/no-go.', status: 'in_progress', priority: 'p0', assignee: MANEEK, due: { day: 0, hour: 17 }, labels: ['launch'], createdDay: -6, sourceMessage: 'p-checklist' },
    { key: 'comms', title: 'Launch comms: email, in-app, and pilot notes', desc: 'Announcement at 09:30 IST on launch day. Personal note to each pilot clinic the night before from Maneek and Maya. No discounts in the copy.', status: 'todo', priority: 'p1', assignee: NOAH, due: { day: 5, hour: 12 }, labels: ['launch', 'customer'], createdDay: -5, sourceMessage: 'l-comms' },
    { key: 'onboarding', title: 'Onboarding wizard: clinic setup under ten minutes', desc: 'Four steps, six fields, import-later escape hatch. Clinic name on the first screen. Desktop passed QA; one 375px overlap left to fix.', status: 'in_progress', priority: 'p1', assignee: AMINA, due: { day: 6, hour: 17 }, labels: ['design', 'launch'], createdDay: -8, sourceMessage: 'd-wizard' },
    { key: 'billing-edge', title: 'Billing edge cases for multi-location clinics', desc: 'Proration when a location is added mid-cycle, failed payment retries, and seat changes for front-desk staff. Post-launch unless a pilot hits it.', status: 'backlog', priority: 'p2', assignee: LEO, due: { day: 10, hour: 17 }, labels: ['pricing', 'infra'], createdDay: -8 },
    { key: 'release-notes', title: 'v2 release notes and changelog', desc: 'Plain language, one screenshot per section. Lead with the scheduling grid and onboarding wizard; mention the lock fix as a reliability improvement.', status: 'todo', priority: 'p2', assignee: MAYA, due: { day: 8, hour: 17 }, labels: ['launch'], createdDay: -4 },
    { key: 'load-test', title: 'Load test: 500 concurrent clinic calendars', desc: 'Mixed read and booking load for 30 minutes. Target p95 under 400ms and zero lost writes. Baseline for the post-launch dashboard.', status: 'done', priority: 'p1', assignee: LEO, due: { day: -5, hour: 17 }, labels: ['infra'], createdDay: -12 },
    { key: 'pricing-log', title: 'Update pricing decision log in the wiki', desc: 'Record the final three tiers, the rejected alternatives ($99, usage-based, per-provider), and the reasoning. Link it from the pricing page project notes.', status: 'done', priority: 'p2', assignee: MAYA, due: { day: -1, hour: 17 }, labels: ['pricing'], createdDay: -5 },
    { key: 'investor-walkthrough', title: 'Rehearse the board deck with Maya', desc: 'Run the board narrative end to end: pilots, pricing, launch date, hiring. Time it at 20 minutes and cut anything that needs a caveat.', status: 'in_progress', priority: 'p0', assignee: MANEEK, due: { day: 1, hour: 14 }, labels: ['launch'], createdDay: -3 },
    { key: 'runbook', title: 'Launch-day runbook and rollback plan', desc: 'Deploy order, smoke tests, escalation tree, and the flag flip that reverts the new grid. One page, printed and pinned in the launch room.', status: 'in_review', priority: 'p1', assignee: LEO, due: { day: 3, hour: 17 }, labels: ['launch', 'infra'], createdDay: -5 },
    { key: 'analytics', title: 'Analytics events for the activation funnel', desc: 'Track signup, clinic created, first provider added, first appointment booked. Must be tenant-scoped and documented in the metrics page.', status: 'in_progress', priority: 'p2', assignee: LEO, due: { day: 4, hour: 17 }, labels: ['launch', 'infra'], createdDay: -7 },
    { key: 'data-room', title: 'Investor data room: metrics and cohort table', desc: 'Pilot cohort by start date, weekly active providers, appointments per clinic, and net revenue retention assumptions with footnotes.', status: 'todo', priority: 'p0', assignee: MANEEK, due: { day: 3, hour: 12 }, labels: ['launch', 'pricing'], createdDay: -4, sourceMessage: 'ld-3' },
    { key: 'metrics-snapshot', title: 'Weekly metrics snapshot for investors', desc: 'One page: pilots, providers, appointments booked, weighted pipeline, burn. Send Friday afternoon so the numbers do not drift in the retelling.', status: 'in_progress', priority: 'p1', assignee: MANEEK, due: { day: 0, hour: 18 }, labels: ['pricing'], createdDay: -2 },
    { key: 'livestream', title: 'Launch livestream with clinic advisors', desc: 'Cancelled. Two advisors could not commit to a date, and a rushed livestream would look worse than none. Revisit for the Q1 webinar instead.', status: 'cancelled', priority: 'p3', assignee: NOAH, due: { day: 7, hour: 17 }, labels: ['launch'], createdDay: -9 },
  ];

  const pilotTasks: TaskDef[] = [
    { key: 'lakeview-followup', title: 'Lakeview Physio: incident follow-up and credit', desc: 'Call Dana, apologise plainly, apply one month free, and confirm the two rescheduled patients were seen. Log the conversation in the pilot notes.', status: 'done', priority: 'p0', assignee: MANEEK, due: { day: -1, hour: 17 }, labels: ['customer', 'bug'], createdDay: -3 },
    { key: 'brightside-onboard', title: 'Brightside Dental onboarding call notes', desc: 'Two locations, three providers, 14 staff. They want SMS reminders first and reporting second. Notes shared with Amina for the onboarding copy.', status: 'done', priority: 'p1', assignee: MAYA, due: { day: -4, hour: 17 }, labels: ['customer'], createdDay: -8 },
    { key: 'harbor-import', title: 'Harbor Family Clinic: import 2,300 appointments', desc: 'Four sheets, inconsistent provider names, one timezone mismatch. Import into staging first, reconcile counts, then load for the Monday onboarding.', status: 'in_progress', priority: 'p1', assignee: LEO, due: { day: 3, hour: 17 }, labels: ['customer', 'infra'], createdDay: -6, sourceMessage: 'gr-pipeline' },
    { key: 'lakeview-checkin', title: 'Lakeview Physio weekly check-in', desc: 'Confirm booking volume is back to normal, ask whether the "slot just taken" state has appeared, and float the same-day view concept.', status: 'todo', priority: 'p1', assignee: NOAH, due: { day: 0, hour: 16 }, labels: ['customer'], createdDay: -1 },
    { key: 'survey', title: 'Pilot feedback survey — round two', desc: 'Five questions, no more. Focus on front-desk time saved, trust in the grid, and what they would remove. Send to all three live clinics.', status: 'in_progress', priority: 'p2', assignee: MAYA, due: { day: 6, hour: 17 }, labels: ['customer'], createdDay: -4 },
    { key: 'brightside-sms', title: 'Brightside Dental: SMS reminders not sending', desc: 'Provider rate limit hit during their Monday morning batch. Add exponential backoff, a retry queue, and a visible failure count for the clinic admin.', status: 'in_review', priority: 'p1', assignee: LEO, due: { day: 2, hour: 17 }, labels: ['bug', 'customer'], createdDay: -2 },
    { key: 'pricing-letters', title: 'Pilot pricing letters for three live clinics', desc: 'One page each. State the renewal price, what is included, and the date it starts. No apology, no discount, no surprises.', status: 'todo', priority: 'p0', assignee: MANEEK, due: { day: 2, hour: 11 }, labels: ['pricing', 'customer'], createdDay: -3, sourceMessage: 'p-final' },
    { key: 'onboarding-playbook', title: 'Clinic onboarding playbook v2', desc: 'Rewrite around the wizard: pre-call checklist, live call, import-later path, and the 7-day check-in. Add the escalation table we used for Lakeview.', status: 'in_progress', priority: 'p2', assignee: MAYA, due: { day: 7, hour: 17 }, labels: ['customer'], createdDay: -9 },
    { key: 'od-import', title: 'Open Dental import mapping', desc: 'Map their patient and appointment exports to the Flow schema. Needed for two of the five pipeline clinics; not a launch dependency.', status: 'backlog', priority: 'p2', assignee: LEO, due: { day: 11, hour: 17 }, labels: ['infra'], createdDay: -7 },
    { key: 'incident-summary', title: 'Send Lakeview incident summary to the other pilots', desc: 'Plain-language note: what happened, what we changed, what we will do differently. Maya drafts, Maneek signs off. No legal hedging.', status: 'todo', priority: 'p0', assignee: MANEEK, due: { day: -2, hour: 18 }, labels: ['customer', 'bug'], createdDay: -4 },
    { key: 'nps', title: 'Collect pilot NPS baseline', desc: 'Ask the three live clinics the same question before launch so we have a before-and-after. Store responses in the pilot notes, not a spreadsheet nobody opens.', status: 'todo', priority: 'p2', assignee: NOAH, due: { day: -3, hour: 17 }, labels: ['customer'], createdDay: -5 },
    { key: 'access-audit', title: 'Access audit for pilot clinic accounts', desc: 'Confirm every clinic admin has the right role, remove two stale contractor accounts, and verify org isolation with a test login from each clinic.', status: 'done', priority: 'p1', assignee: LEO, due: { day: -6, hour: 17 }, labels: ['infra'], createdDay: -10 },
    { key: 'renewal', title: 'Brightside renewal conversation', desc: 'They are the strongest reference. Open with adoption numbers, not price. Target an annual Clinic plan at $399 with a January start.', status: 'todo', priority: 'p1', assignee: NOAH, due: { day: 13, hour: 15 }, labels: ['customer', 'pricing'], createdDay: -2 },
    { key: 'expansion', title: 'Pilot expansion decision: five clinics by Q1', desc: 'Capacity is three concurrent onboardings and one new clinic per week after that. Decision memo covers the support hire, the intake checklist, and what we say no to.', status: 'in_progress', priority: 'p0', assignee: MANEEK, due: { day: 9, hour: 12 }, labels: ['customer'], createdDay: -3, sourceMessage: 'gr-cap' },
    { key: 'playbook-sms', title: 'Add SMS template review to onboarding doc', desc: 'Front desks copy the worst reminder text you have ever read. Add a template review step to the onboarding call and a short bank of approved messages.', status: 'todo', priority: 'p3', assignee: MAYA, due: { day: 6, hour: 17 }, labels: ['customer'], createdDay: -5, parent: 'onboarding-playbook' },
  ];

  const designTasks: TaskDef[] = [
    { key: 'tokens', title: 'Publish design tokens v2.0', desc: '16 colors, 8 spacing stops on a 4px base, 4 type sizes, 3 radii, 3 elevations. Package @flow/tokens 2.0.0, no hex codes in feature code.', status: 'done', priority: 'p1', assignee: AMINA, due: { day: -3, hour: 17 }, labels: ['design'], createdDay: -12 },
    { key: 'grid-migration', title: 'Migrate scheduling grid to the 8px spacing scale', desc: 'Replace 6px gutters. Rows get 2px taller, which fixes truncated provider names at 1280px. No structural changes — this is a visual pass.', status: 'in_progress', priority: 'p1', assignee: AMINA, due: { day: 5, hour: 17 }, labels: ['design'], createdDay: -4 },
    { key: 'empty-states', title: 'Empty states for the clinic dashboard', desc: 'First-run, no-providers, no-appointments, and "slot just taken". Each one should tell the front desk what to do next, not just that something is empty.', status: 'todo', priority: 'p2', assignee: AMINA, due: { day: 8, hour: 17 }, labels: ['design'], createdDay: -5 },
    { key: 'contrast', title: 'Color contrast audit across the product', desc: 'Fixed 14 pairs below 4.5:1, mostly muted text on tinted rows. All new semantic tokens pass AA in both default and focus states.', status: 'done', priority: 'p1', assignee: AMINA, due: { day: -7, hour: 17 }, labels: ['design'], createdDay: -14 },
    { key: 'docs', title: 'Component docs site refresh', desc: 'Each component gets a usage note, a do/don\'t pair, and a link to the token it consumes. Remove the four components we no longer ship.', status: 'in_progress', priority: 'p3', assignee: AMINA, due: { day: 10, hour: 17 }, labels: ['design'], createdDay: -8 },
    { key: 'dark-mode', title: 'Dark mode palette exploration', desc: 'Post-launch exploration only. Start from the semantic tokens, not the hex values. No commitment until the launch retro.', status: 'backlog', priority: 'p3', assignee: AMINA, due: { day: 14, hour: 17 }, labels: ['design'], createdDay: -9 },
    { key: 'type-scale', title: 'Typography scale: four sizes only', desc: '12, 14, 20, 24. Two weights. Removes six ad-hoc sizes currently in the appointment cards. In review with Maya and Leo.', status: 'in_review', priority: 'p2', assignee: AMINA, due: { day: 1, hour: 17 }, labels: ['design'], createdDay: -4 },
    { key: 'figma', title: 'Figma library handoff for new tokens', desc: 'Rebuild the library against @flow/tokens 2.0.0 and archive the old styles so nobody reaches for a stale color.', status: 'todo', priority: 'p2', assignee: AMINA, due: { day: -1, hour: 18 }, labels: ['design'], createdDay: -8 },
    { key: 'crit-notes', title: 'Design crit notes for token rollout', desc: 'Write up the crit decisions: why 16 colors, why four type sizes, and the grid gutter trade-off. Post to #design so the reasoning survives us.', status: 'todo', priority: 'p3', assignee: AMINA, due: { day: -5, hour: 17 }, labels: ['design'], createdDay: -10 },
    { key: 'snapshots', title: 'Update scheduling grid snapshots', desc: 'Regenerate visual snapshots after the gutter change. Review each one for unintended reflow before approving.', status: 'todo', priority: 'p2', assignee: AMINA, due: { day: 4, hour: 17 }, labels: ['design'], createdDay: -3, parent: 'grid-migration' },
  ];

  const projectDefs = [
    {
      key: 'v2',
      name: 'Flow v2 Launch',
      description: 'Everything that has to be true on November 11: scheduling grid, three-tier pricing, onboarding wizard, design tokens, and launch comms.',
      prefix: 'FLOW',
      icon: '🚀',
      color: '#2563EB',
      lead: MANEEK,
      spaces: ['product', 'launch', 'engineering'] as SpaceKey[],
      tasks: v2Tasks,
    },
    {
      key: 'pilot',
      name: 'Clinic Pilot Program',
      description: 'Three live clinic pilots, the Harbor onboarding, and the decision on how many clinics we can actually support next quarter.',
      prefix: 'PILOT',
      icon: '🏥',
      color: '#0D9488',
      lead: MAYA,
      spaces: ['growth', 'product'] as SpaceKey[],
      tasks: pilotTasks,
    },
    {
      key: 'design',
      name: 'Design System 2.0',
      description: 'Tokens, typography, and the visual pass that makes Flow look like one product instead of four.',
      prefix: 'DS',
      icon: '🎨',
      color: '#DB2777',
      lead: AMINA,
      spaces: ['design'] as SpaceKey[],
      tasks: designTasks,
    },
  ];

  const taskIds = new Map<string, string>();
  const projectIds = new Map<string, string>();

  for (const project of projectDefs) {
    const [inserted] = await db.insert(schema.projects).values({
      org_id: ORG_ID,
      name: project.name,
      description: project.description,
      prefix: project.prefix,
      icon: project.icon,
      color: project.color,
      lead_id: project.lead,
      task_counter: project.tasks.length,
      created_at: atIST(-20, 10, 0),
      updated_at: now,
    }).returning({ id: schema.projects.id });
    projectIds.set(project.key, inserted!.id);
    bump('projects');

    for (const spaceKey of project.spaces) {
      await db.insert(schema.projectSpaces).values({ project_id: inserted!.id, space_id: spaceIds[spaceKey] });
      bump('project_spaces');
    }

    // Parents must exist before children; numbering still follows the authored order.
    const ordered = [...project.tasks.filter((task) => !task.parent), ...project.tasks.filter((task) => task.parent)];
    for (const task of ordered) {
      const number = project.tasks.indexOf(task) + 1;
      const parentId = task.parent ? taskIds.get(`${project.key}:${task.parent}`) : undefined;
      if (task.parent && !parentId) throw new Error(`missing parent task ${task.parent} for ${task.key}`);
      const sourceMessage = task.sourceMessage ? messageIds.get(task.sourceMessage) : undefined;
      if (task.sourceMessage && !sourceMessage) throw new Error(`missing source message ${task.sourceMessage} for ${task.key}`);
      const [taskRow] = await db.insert(schema.tasks).values({
        org_id: ORG_ID,
        project_id: inserted!.id,
        number,
        title: task.title,
        description: task.desc,
        status: task.status,
        priority: task.priority,
        assignee_id: task.assignee,
        created_by: MANEEK,
        due_date: task.due ? atIST(task.due.day, task.due.hour, task.due.minute ?? 0) : null,
        sort_order: number,
        parent_task_id: parentId ?? null,
        source_message_id: sourceMessage?.id ?? null,
        created_at: atIST(task.createdDay, 10, 15),
        updated_at: atIST(Math.min(task.createdDay + 3, -1), 16, 0),
      }).returning({ id: schema.tasks.id });
      taskIds.set(`${project.key}:${task.key}`, taskRow!.id);
      bump('tasks');
    }
  }

  const labelDefs: Array<[string, string]> = [
    ['launch', '#2563EB'],
    ['bug', '#DC2626'],
    ['customer', '#F97316'],
    ['design', '#DB2777'],
    ['pricing', '#10B981'],
    ['infra', '#6366F1'],
  ];
  const labelIds = new Map<string, string>();
  for (const [name, color] of labelDefs) {
    const [label] = await db.insert(schema.labels).values({ org_id: ORG_ID, name, color }).returning({ id: schema.labels.id });
    labelIds.set(name, label!.id);
    bump('labels');
  }

  const taskLabelPlan: Array<[string, string[], string]> = projectDefs.flatMap((project) =>
    project.tasks.map((task) => [`${project.key}:${task.key}`, task.labels, task.title] as [string, string[], string]),
  );
  for (const [taskKey, labels, title] of taskLabelPlan) {
    const taskId = taskIds.get(taskKey);
    if (!taskId) throw new Error(`missing task ${taskKey}`);
    for (const label of labels) {
      const labelId = labelIds.get(label);
      if (!labelId) throw new Error(`missing label ${label} on ${title}`);
      await db.insert(schema.taskLabels).values({ task_id: taskId, label_id: labelId });
      bump('task_labels');
    }
  }

  // Additional assignees (never the primary assignee).
  const extraAssignees: Array<[string, string]> = [
    ['v2:price-copy', NOAH],
    ['v2:comms', MAYA],
    ['v2:data-room', MAYA],
    ['v2:onboarding', MAYA],
    ['pilot:harbor-import', MAYA],
    ['pilot:expansion', NOAH],
    ['design:grid-migration', LEO],
  ];
  for (const [taskKey, userId] of extraAssignees) {
    await db.insert(schema.taskAssignees).values({ task_id: taskIds.get(taskKey)!, user_id: userId });
    bump('task_assignees');
  }

  // Blocking relationships.
  await db.insert(schema.taskRelationships).values([
    { source_task_id: taskIds.get('v2:slot-migration')!, target_task_id: taskIds.get('v2:runbook')!, type: 'blocks' },
    { source_task_id: taskIds.get('v2:tier-config')!, target_task_id: taskIds.get('v2:price-copy')!, type: 'blocks' },
  ]);
  bump('task_relationships', 2);

  // Watchers.
  const watcherPlan: Array<[string, string]> = [
    ['v2:checklist', MANEEK], ['v2:checklist', MAYA], ['v2:checklist', LEO], ['v2:checklist', NOAH], ['v2:checklist', AMINA],
    ['v2:regression', MANEEK], ['v2:regression', MAYA],
    ['v2:runbook', MANEEK], ['v2:runbook', MAYA],
    ['v2:data-room', MAYA], ['v2:metrics-snapshot', NOAH],
    ['pilot:incident-summary', MAYA], ['pilot:incident-summary', NOAH],
    ['pilot:harbor-import', MAYA],
    ['pilot:expansion', MAYA], ['pilot:expansion', NOAH],
    ['design:grid-migration', MANEEK], ['design:grid-migration', LEO],
  ];
  for (const [taskKey, userId] of watcherPlan) {
    await db.insert(schema.taskWatchers).values({ task_id: taskIds.get(taskKey)!, user_id: userId });
    bump('task_watchers');
  }

  // Comments.
  const commentPlan: Array<{ task: string; who: string; days: number; hour: number; text: string }> = [
    { task: 'v2:price-copy', who: MAYA, days: -4, hour: 11, text: 'Third revision is up. The comparison table is doing most of the work; the cards just need to not contradict it.' },
    { task: 'v2:price-copy', who: NOAH, days: -3, hour: 15, text: 'Unlimited appointments line is in. I would also add "no per-provider fees" to the Clinic card — two clinics asked.' },
    { task: 'v2:tier-config', who: LEO, days: -4, hour: 16, text: 'All three products and prices exist in the billing test account. The annual Multi-site price is still a placeholder; I will not touch production until Maya confirms it.' },
    { task: 'v2:regression', who: LEO, days: -2, hour: 10, text: 'The test fails on main before the lock and passes with it. I ran it 200 times to make sure it is not flaky. It is not.' },
    { task: 'v2:slot-migration', who: LEO, days: -2, hour: 22, text: 'Deployed at 22:40 IST. Lock wait p99 is 8ms. Two 409s in the first hour, both legitimate — someone else got the slot first.' },
    { task: 'v2:checklist', who: MAYA, days: -2, hour: 9, text: '21 of 34 done. Red items: SMS sender registration and pricing page legal. Everything else is green or has an owner with a date.' },
    { task: 'v2:comms', who: NOAH, days: -1, hour: 14, text: 'Pilot notes drafted. Each one names their own adoption number, which is the part that makes it feel written for them and not a mail merge.' },
    { task: 'v2:onboarding', who: AMINA, days: -2, hour: 17, text: 'Desktop is through QA. The 375px overlap is the step label wrapping under the button; fixing with a shorter label, not a layout change.' },
    { task: 'v2:load-test', who: LEO, days: -6, hour: 18, text: '500 calendars, 10k bookings over 30 minutes. p95 380ms, zero lost writes, one 409 storm that turned out to be the test harness, not us.' },
    { task: 'v2:runbook', who: LEO, days: -1, hour: 16, text: 'Rollback is a flag flip on the grid and a redeploy of the previous image for everything else. Both under five minutes. I am not pretending a database rollback is fast.' },
    { task: 'v2:data-room', who: MANEEK, days: -1, hour: 9, text: 'Needs a cohort retention table by pilot start week, not a single blended number. If we cannot explain the shape, we do not show the chart.' },
    { task: 'v2:metrics-snapshot', who: MAYA, days: -1, hour: 11, text: 'Numbers as of Friday: 3 pilots, 41 providers, 1,840 appointments, $186k weighted pipeline. I will keep the same definition every week so the trend means something.' },
    { task: 'pilot:lakeview-followup', who: MANEEK, days: -1, hour: 15, text: 'Called Dana. She accepted the credit but was clear that a second incident ends the pilot. Fair. I told her it would not happen and why.' },
    { task: 'pilot:harbor-import', who: LEO, days: -2, hour: 13, text: '2,300 rows in staging. 47 provider names do not match anything, so I am mapping those by hand. Counts reconcile to their sheet, which is the important part.' },
    { task: 'pilot:lakeview-checkin', who: NOAH, days: -1, hour: 12, text: 'Dana asked whether the front desk can keep a same-day list open. That is the second clinic to ask for it this month.' },
    { task: 'pilot:brightside-sms', who: LEO, days: -1, hour: 18, text: 'Provider rate limit is the cause. Backoff and a retry queue are in review. I am also exposing failure counts so we stop finding out from a patient.' },
    { task: 'pilot:pricing-letters', who: MANEEK, days: -2, hour: 10, text: 'Keep it to one page. Price, what is included, start date. No apology and no discount — they are getting a better product than they piloted.' },
    { task: 'pilot:onboarding-playbook', who: MAYA, days: -1, hour: 10, text: 'Adding the import-later path and the escalation table. The old version assumed the clinic had their data ready, which was true for exactly one of three.' },
    { task: 'pilot:incident-summary', who: MANEEK, days: -2, hour: 19, text: 'Sent to all three clinics. Two replied within the hour, both appreciative. The third has not replied, which is fine.' },
    { task: 'pilot:renewal', who: NOAH, days: -1, hour: 17, text: 'They want to talk annual after launch. I am not opening with a discount; I am opening with their adoption number and the support they get.' },
    { task: 'pilot:expansion', who: MANEEK, days: -1, hour: 9, text: 'Five by Q1, ten by Q2, hire ahead of the tenth. Anyone who wants a different number needs to bring a support plan with it.' },
    { task: 'design:tokens', who: AMINA, days: -3, hour: 15, text: 'Published. 47 colors down to 16, and the only place a hex value is allowed is the token package itself.' },
    { task: 'design:grid-migration', who: AMINA, days: -1, hour: 14, text: 'Two columns done. The 8px gutter fixes the truncated names and makes the row rhythm feel intentional. One more pass on the header.' },
    { task: 'design:contrast', who: AMINA, days: -7, hour: 12, text: 'Fixed 14 pairs. Most were muted text on tinted rows; two were buttons that looked disabled when they were not. All pass AA now.' },
    { task: 'design:type-scale', who: AMINA, days: -1, hour: 11, text: 'Four sizes: 12, 14, 20, 24. Two weights. It feels restrictive for about a day and then everything gets easier.' },
    { task: 'design:figma', who: AMINA, days: -2, hour: 16, text: 'Library is a mess. 63 color styles, half of them unnamed. I am archiving everything and rebuilding against the tokens rather than cleaning by hand.' },
    { task: 'design:crit-notes', who: MAYA, days: -2, hour: 17, text: 'Great crit. The part I want written down is why we chose 16 colors and not 22 — that argument will come back in three months.' },
  ];
  for (const comment of commentPlan) {
    await db.insert(schema.taskComments).values({
      org_id: ORG_ID,
      task_id: taskIds.get(comment.task)!,
      user_id: comment.who,
      content: comment.text,
      created_at: atIST(comment.days, comment.hour, 20),
    });
    bump('task_comments');
  }

  // Activity history.
  const activityPlan: Array<{ task: string; who: string | null; action: string; field?: string; oldValue?: string; newValue?: string; days: number }> = [
    { task: 'v2:price-copy', who: MAYA, action: 'created', days: -6 },
    { task: 'v2:price-copy', who: MANEEK, action: 'priority_changed', field: 'priority', oldValue: 'p2', newValue: 'p1', days: -4 },
    { task: 'v2:tier-config', who: LEO, action: 'created', days: -6 },
    { task: 'v2:slot-migration', who: LEO, action: 'status_changed', field: 'status', oldValue: 'in_progress', newValue: 'done', days: -2 },
    { task: 'v2:slot-migration', who: LEO, action: 'created', days: -5 },
    { task: 'v2:regression', who: LEO, action: 'created', days: -3 },
    { task: 'v2:regression', who: LEO, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_progress', days: -2 },
    { task: 'v2:regression', who: LEO, action: 'status_changed', field: 'status', oldValue: 'in_progress', newValue: 'in_review', days: -1 },
    { task: 'v2:checklist', who: MANEEK, action: 'created', days: -6 },
    { task: 'v2:checklist', who: MAYA, action: 'assigned', field: 'assignee_id', oldValue: null as unknown as string, newValue: MANEEK, days: -6 },
    { task: 'v2:runbook', who: LEO, action: 'status_changed', field: 'status', oldValue: 'in_progress', newValue: 'in_review', days: -1 },
    { task: 'v2:data-room', who: MANEEK, action: 'created', days: -4 },
    { task: 'v2:data-room', who: MAYA, action: 'priority_changed', field: 'priority', oldValue: 'p1', newValue: 'p0', days: -3 },
    { task: 'v2:metrics-snapshot', who: MANEEK, action: 'created', days: -2 },
    { task: 'v2:livestream', who: NOAH, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'cancelled', days: -7 },
    { task: 'pilot:lakeview-followup', who: MANEEK, action: 'status_changed', field: 'status', oldValue: 'in_progress', newValue: 'done', days: -1 },
    { task: 'pilot:brightside-sms', who: LEO, action: 'status_changed', field: 'status', oldValue: 'in_progress', newValue: 'in_review', days: -1 },
    { task: 'pilot:brightside-sms', who: MAYA, action: 'priority_changed', field: 'priority', oldValue: 'p2', newValue: 'p1', days: -2 },
    { task: 'pilot:harbor-import', who: LEO, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_progress', days: -2 },
    { task: 'pilot:pricing-letters', who: MANEEK, action: 'created', days: -3 },
    { task: 'pilot:expansion', who: MANEEK, action: 'created', days: -3 },
    { task: 'pilot:renewal', who: NOAH, action: 'created', days: -2 },
    { task: 'pilot:access-audit', who: LEO, action: 'status_changed', field: 'status', oldValue: 'in_review', newValue: 'done', days: -6 },
    { task: 'design:tokens', who: AMINA, action: 'status_changed', field: 'status', oldValue: 'in_review', newValue: 'done', days: -3 },
    { task: 'design:grid-migration', who: AMINA, action: 'status_changed', field: 'status', oldValue: 'todo', newValue: 'in_progress', days: -1 },
    { task: 'design:type-scale', who: AMINA, action: 'status_changed', field: 'status', oldValue: 'in_progress', newValue: 'in_review', days: -1 },
    { task: 'design:contrast', who: AMINA, action: 'status_changed', field: 'status', oldValue: 'in_review', newValue: 'done', days: -7 },
    { task: 'design:snapshots', who: AMINA, action: 'created', days: -3 },
  ];
  for (const entry of activityPlan) {
    await db.insert(schema.taskActivity).values({
      org_id: ORG_ID,
      task_id: taskIds.get(entry.task)!,
      user_id: entry.who,
      action: entry.action,
      field: entry.field ?? null,
      old_value: entry.oldValue ?? null,
      new_value: entry.newValue ?? null,
      created_at: atIST(entry.days, 11, 5),
    });
    bump('task_activity');
  }

  console.log(`[seed] created ${projectDefs.length} projects, ${taskIds.size} tasks, ${commentPlan.length} comments`);

  // ── Wiki pages ────────────────────────────────────────────────────────────
  const wikiDefs: Array<{
    key: string;
    title: string;
    type: 'concept' | 'entity' | 'decision' | 'resource' | 'procedure' | 'preference' | 'fact';
    author: string;
    summary: string;
    tags: string[];
    content: string;
  }> = [
    {
      key: 'strategy',
      title: 'Product strategy',
      type: 'concept',
      author: MANEEK,
      summary: 'Who Flow is for, why scheduling is the wedge, and what we are deliberately not building this year.',
      tags: ['strategy', 'positioning'],
      content: `# Product strategy

Flow is scheduling software for outpatient clinics with two to twenty providers. Dental, physio, family medicine, paediatrics. The kind of clinic where the front desk is one or two people, the schedule lives in a system nobody likes, and a double booking is a patient sitting in a waiting room getting angrier.

## The problem we actually sell against

Clinics do not buy scheduling software because they want software. They buy it because their current system loses appointments. A slot goes empty because a cancellation was not backfilled. A patient gets booked twice because two receptionists were on the phone at the same time. A provider's recurring block is wrong after a holiday and nobody notices for a week.

Every one of those is a revenue leak the owner can feel. Our pitch is not features. It is: your schedule stops leaking.

## Who we serve

Our buyer is the owner-operator of a clinic with two to ten locations. They are close enough to the front desk to know the pain, and far enough away to want a report about it. The daily user is the front-desk coordinator. If the coordinator hates us, the owner churns. That is why so much of our design effort goes into the booking grid and the empty states around it.

## The wedge

Scheduling is the wedge because it is the one workflow every clinic runs every day, and because the data it produces — appointments, no-shows, provider utilisation — is the foundation for everything else we might sell later. We are not building a full practice management suite. We are building the best schedule, then earning the right to expand.

## What we sell

Three tiers: Solo at $149 per clinic per month, Clinic at $399 for up to four locations, Multi-site from $1,200 for five or more. Unlimited appointments at every tier, 1,000 reminder texts included per clinic. Pricing is per clinic, not per provider, because owner-operators think in locations and we do not want to punish them for hiring.

## The next twelve months

- November 11: Flow v2 launches with the new grid, onboarding wizard, and three-tier pricing.
- Q1: five live pilots, a support hire, and the first annual contracts.
- Q2: ten clinics, a self-serve trial, and the reporting surface that owners keep asking for.
- Second half: decide whether the next expansion is payments or multi-site operations. Not before we have the data.

## Non-goals

No EHR. No billing engine. No patient app this year. No custom enterprise deployments. Every one of these has been asked for, and every one of them would turn a focused product into a services business before we have earned it.

## How we know it is working

Three numbers: percentage of a clinic's appointments booked through Flow, time from signup to first booking, and net revenue retention after six months. If those three move, everything else is detail.`,
    },
    {
      key: 'launch-plan',
      title: 'Flow v2 launch plan',
      type: 'procedure',
      author: MAYA,
      summary: 'The November 11 launch: scope, freeze dates, checklist, day-of sequence, and rollback.',
      tags: ['launch', 'planning'],
      content: `# Flow v2 launch plan

**Launch date: Wednesday, November 11.** It moved once, from November 4, and it will not move again without a written decision from Maneek and me.

## Scope

In: the rebuilt scheduling grid, the onboarding wizard, three-tier pricing, design tokens, and launch comms.

Out: dark mode, saved views, bulk reschedule, the same-day view, and Open Dental import mapping. The cut list is public on purpose. Investors and the team should both be able to see what we chose not to do.

## Timeline

| Date | Milestone | Owner |
| --- | --- | --- |
| Nov 3 | Pricing page copy frozen | Maya |
| Nov 6 | Design freeze; launch review 16:00 IST | Amina / Maya |
| Nov 9 | Go/no-go 15:00 IST; code freeze 18:00 IST | Maneek / Leo |
| Nov 10 | Pilot clinic notes sent the night before | Noah |
| Nov 11 | Launch, comms at 09:30 IST | Everyone |

## Launch criteria

1. Zero open sev-1 bugs.
2. Onboarding wizard through QA on desktop and mobile.
3. Pricing page live with legal-approved copy.
4. SMS sender registration approved and a test message delivered.
5. Rollback rehearsed at least once by Leo, not just written down.

If any criterion is red on Monday, we delay by a week. We do not launch with a red item and a hopeful paragraph.

## Day-of sequence

- 08:00 — Leo checks the deploy, the dashboards, and the SMS queue.
- 09:00 — Maya posts the launch checklist status in #launch-v2.
- 09:30 — Comms go out: email, in-app banner, pilot notes already delivered.
- 10:00 — Support rota starts. Noah owns the first two hours, Maya the next two.
- 17:00 — Day-one retro in #general. Numbers, surprises, and what we tell clinics tomorrow.

## Rollback

The grid ships behind a flag. If booking writes fail or latency crosses p95 600ms for ten minutes, Leo flips the flag and redeploys the previous image. Target recovery: under five minutes. The database migration is additive and does not need reversing for a rollback.

## Communication

Pilot clinics hear from a person, not a campaign. Internal comms stay in #launch-v2 until launch day, then move to #general. If something goes wrong, we say what happened in plain language within the hour. The Lakeview incident set that standard and it is now the norm.`,
    },
    {
      key: 'pricing',
      title: 'Pricing decision log',
      type: 'decision',
      author: MAYA,
      summary: 'Why Flow sells three tiers at $149 / $399 / $1,200+, and which alternatives we rejected.',
      tags: ['pricing', 'decision'],
      content: `# Pricing decision log

**Decision (October):** three tiers, priced per clinic, unlimited appointments at every tier.

| Tier | Price | Who it is for |
| --- | --- | --- |
| Solo | $149 / clinic / month | Single-location clinics, one to three providers |
| Clinic | $399 / month | Up to four locations, shared reporting |
| Multi-site | from $1,200 / month, annual | Five or more locations, SSO and a named contact |

1,000 reminder texts per clinic are included each month; additional messages are metered at the published rate. All tiers include unlimited appointments, because metering bookings makes a scheduler feel like a taxi meter.

## Alternatives considered

**$99 launch price.** Noah argued for it: faster pilots, more logos, price later. Rejected. Clinics that book patients for a living read a low price as a low-stakes product. We would have spent a year climbing out of a discount we chose on purpose.

**Usage-based pricing.** Rejected because the buyer cannot forecast it. An owner-operator wants to know what the schedule costs before they approve it, not after a busy month.

**Per-provider pricing.** Rejected because it punishes hiring. A clinic adding a fourth dentist should feel like growth, not a bill.

**Two tiers plus "contact us".** Rejected on presentation grounds as much as economics: two cards and a phone number reads like an unfinished pricing page. Three named tiers also fit one row on a laptop, which sounds trivial until you watch a demo wrap to a second line.

## Why per clinic

Owners think in locations. Front desks think in providers. We price in the unit the person signing the cheque uses.

## Risks

- $149 may be low for multi-provider Solo clinics. Watch utilisation per clinic and revisit at the Q1 pricing review.
- The SMS overage rate is a trust issue. Publish it clearly and never let it appear as a surprise line item.
- Multi-site is a negotiated price, not a list price. Every deal above five locations comes to Maneek.

## Reopen conditions

We revisit pricing if any of the following is true: fewer than 30% of demos convert at list price, more than half of pilots ask for a discount, or net revenue retention falls below 100% for two consecutive quarters. Absent those, the tiers stay stable through Q2.`,
    },
    {
      key: 'pilot-playbook',
      title: 'Clinic pilot playbook',
      type: 'procedure',
      author: MAYA,
      summary: 'How a clinic goes from signed pilot to daily Flow usage in nine days, and what to do when it does not.',
      tags: ['pilot', 'customer'],
      content: `# Clinic pilot playbook

A pilot is not a trial. It is a short, supervised implementation with a named owner on both sides and a decision date at the end. If we cannot name the person at the clinic who will be embarrassed if it fails, we do not start.

## Stages

**1. Qualification (day -5).** Locations, providers, current system, who runs the front desk, and what breaks today. If they cannot describe a specific scheduling failure from the last month, they are curious, not ready.

**2. Data and access (day -3).** Export or screenshots of the current schedule. We accept a spreadsheet. We do not accept "we will set it up live on the call".

**3. Onboarding call (day 0).** 45 minutes. We create the clinic, add providers, set hours, and book one real appointment together. The wizard should get us to the first booking inside ten minutes; the rest of the call is reminders and roles.

**4. First week (days 1–7).** Front desk runs Flow in parallel with the old system. We check in on day 1, day 3, and day 7. The day-3 call is not optional and is not an email.

**5. Decision (day 9–14).** Adoption number, front-desk feedback, and a clear yes or no. A maybe is a no with extra meetings.

## Success metrics

- At least 70% of appointments booked through Flow by day 14.
- Time to first booking under two days from onboarding.
- Front-desk coordinator says they would be annoyed if we took it away. This is qualitative and it is the most predictive signal we have.

## Escalation

Anything that blocks booking is a sev-1 for the pilot: Leo within 30 minutes, Maya within the hour, the clinic told what is happening before they ask. The Lakeview double booking is the reference case. We called within an hour, credited a month, and wrote the regression test.

## What we do not do

We do not discount to save a pilot that is not adopting. We do not extend a pilot to avoid a decision. We do not onboard a new clinic during a launch week, because the support load is real and the product gets blamed for our calendar.`,
    },
    {
      key: 'personas',
      title: 'Customer personas',
      type: 'resource',
      author: AMINA,
      summary: 'The four people who decide whether Flow survives contact with a clinic.',
      tags: ['research', 'personas'],
      content: `# Customer personas

These are working personas, not marketing fiction. Every one is drawn from pilot calls and demo recordings.

## Dana — practice manager, two-location physio

Dana runs the front desk and the schedule. She is the person who gets yelled at when a booking goes wrong, and the person who quietly keeps the clinic running. She does not care about our architecture. She cares whether the grid loads fast, whether a cancelled slot is easy to backfill, and whether she has to explain a new system to a patient.

What wins her: predictable behaviour, keyboard shortcuts, and an explicit "this slot was just taken" state. What loses her: surprises, modal dialogs, and anything that requires a training session.

## Marcus — owner-operator, four dental locations

Marcus signs the cheque and visits each location once a week. He thinks in revenue per chair per day. He wants to know which location is under-booked before it becomes a bad month. He will sit through a 30-minute demo and ask two questions, both about money.

What wins him: a per-location view, utilisation reporting, and a price he can repeat from memory. What loses him: per-provider fees and a pricing page that requires a call.

## Priya — front-desk coordinator, family clinic

Priya is 24, fast on a keyboard, and manages three phone lines. She is the daily user and the toughest critic. She will adopt anything that saves her a step and quietly abandon anything that adds one. She does not read release notes.

What wins her: fewer clicks, reminders that send reliably, and a same-day view she can keep open. What loses her: an empty state that does not tell her what to do next.

## Elena — operations lead, 12-location group

Elena is the buyer we are not ready for yet. She needs SSO, a security review, role-based access, and a named support contact. She evaluates in quarters, not weeks, and she will read the contract.

What wins her: evidence. A pilot with three clinics and a written incident process beats a beautiful demo. We should not chase her until the support model can survive her.`,
    },
    {
      key: 'runbook',
      title: 'Engineering runbook',
      type: 'procedure',
      author: LEO,
      summary: 'Deploys, the booking invariant, incident severity, on-call expectations, and the double-booking postmortem.',
      tags: ['infra', 'incident', 'on-call'],
      content: `# Engineering runbook

## Services

The web app and API run as one deployable. Postgres is the only stateful dependency. Background jobs run in-process against the Postgres queue. There is no Redis, no message broker, and no cross-instance websocket adapter — one instance is a deliberate constraint until we need otherwise.

## Deploy

1. Merge to main only with a green suite, including the booking concurrency test.
2. Deploy during IST business hours unless it is a sev-1 fix.
3. Watch booking p95, 409 rate, and job queue depth for ten minutes.
4. Feature flags are the first rollback, image redeploy is the second. Database migrations are additive; we do not run destructive migrations during a launch window.

## The booking invariant

**A booking write must acquire the slot lock inside the same transaction that checks availability.** One path, one lock key per clinic, provider, and day. If a second request cannot take the lock, it returns 409 and the UI explains that the slot was just taken.

This invariant exists because we broke it. In October, two requests for the same provider slot both passed the availability check and both wrote a booking. Lakeview Physio found it before we did.

## Postmortem: the double booking

- **Impact:** one confirmed double booking, two patients rescheduled, no clinical harm.
- **Cause:** the availability read ran outside the write transaction; the write path had no lock.
- **Fix:** advisory locks on the write path, deployed the same evening.
- **Prevention:** a regression test that fails if the availability read ever leaves the transaction, plus a dashboard for conflicts and lock wait time.
- **Response:** clinic called within the hour, one month credited, other pilots told proactively.

The uncomfortable lesson is that the code looked correct in review. The test, not the review, is what prevents a repeat.

## Severity

- **Sev-1:** booking writes failing, data loss, or a clinic unable to see its schedule. Page Leo. Update the clinic within the hour.
- **Sev-2:** a core workflow is degraded but workable. Fix within the day.
- **Sev-3:** cosmetic or single-user. Next sprint.

## On-call

One engineer, one week, IST hours. If a sev-1 runs past 30 minutes, escalate to Leo directly. Postmortem within 48 hours, written in this page, not in a doc nobody reads.`,
    },
    {
      key: 'onboarding-guide',
      title: 'Onboarding guide',
      type: 'procedure',
      author: MAYA,
      summary: 'First week at Northstar: what to read, who to meet, and what good looks like at 30, 60, and 90 days.',
      tags: ['hiring', 'process'],
      content: `# Onboarding guide

Welcome to Northstar Labs. We build Flow, scheduling software for clinics. Five people, three live pilots, and a launch on November 11. You will have real work in your first week, because we are too small for a shadow period.

## Day one

- Read this wiki in this order: Product strategy, Flow v2 launch plan, Clinic pilot playbook, Engineering runbook (or Design principles if you are on design).
- Meet your buddy for 30 minutes. Ask the questions you think are too obvious.
- Get access: workspace, repository, staging, and the shared metrics sheet.
- Post an introduction in #general. One paragraph, not a resume.

## First week

- Ship one small thing. A copy fix, a test, a component, a call note. Shipping beats observing.
- Sit in on one pilot call or one demo. Listen for the moment the customer hesitates; that is where the product work is.
- Read the last two weeks of #general and your team channel. You do not need the whole history, but you need the tone.

## Rituals

- Daily standup at 10:00 IST in #general. Three lines: yesterday, today, blockers.
- Friday note in #general. What moved, what broke, what is next.
- Launch review and go/no-go are open to everyone.
- No meetings before 09:30 IST unless a customer asks.

## What good looks like

**At 30 days:** you have shipped something a customer used, and you can explain what Flow does without reading the homepage.

**At 60 days:** you own a surface or a workstream. People come to you with questions about it. You are raising risks early rather than reporting them late.

**At 90 days:** you have made one decision that stuck. Not a big decision — a real one — and you can explain why.

## How we work

Write it down. Decide with the person closest to the problem. Escalate when a decision affects a customer promise or a launch date. We optimise for boring reliability over heroic launches. The best week here is one where nothing dramatic happens and the numbers move.`,
    },
    {
      key: 'design-principles',
      title: 'Design principles',
      type: 'concept',
      author: AMINA,
      summary: 'Six principles that decide arguments about the Flow interface when taste is not enough.',
      tags: ['design', 'principles'],
      content: `# Design principles

## 1. The schedule is the product

Most screens exist to get someone back to the grid. Do not spend the user's attention on chrome, onboarding tours, or decorative headers. If a change does not make the grid faster to read or faster to act on, it is probably not worth shipping before launch.

## 2. Subtraction is a feature

We had 47 colors and four different paddings on the same card. Now we have 16 colors and one spacing scale. Restraint does not make a product feel cheap; inconsistency does. When two options are equally good, choose the one that removes a decision from the next designer.

## 3. Say what happened, then what to do

An error that says "conflict" is a dead end. "This slot was just taken — pick another time" is a next step. Every empty state, error, and disabled control should answer two questions: what is going on, and what do I do now.

## 4. Density with breathing room

Front-desk staff scan a schedule for eight hours. They need more information per screen than a consumer app, and they need it to stay legible. We use a 4px base with 8px gutters, 12/14px body text, and one bold weight for the thing that matters. Dense is not the same as cramped.

## 5. Design for the second week

The first-run experience matters, but retention lives in the second week, when the novelty is gone and the schedule is full of real patients. Optimise for the repeated task, not the demo. If a screen looks better in a screenshot than in daily use, it is wrong.

## 6. Opinionated, not clever

We pick a default and explain it. Three tiers, four type sizes, one primary action per screen. A clever interaction that requires discovery is a tax on every new user. Boring, predictable, and fast is the goal — and when we break this rule, we should be able to say why in one sentence.

## Using these

In a crit, name the principle you are arguing from. "This violates say-what-happened" is a better conversation than "I do not like it". If two principles conflict, the schedule wins.`,
    },
    {
      key: 'competitive',
      title: 'Competitive landscape',
      type: 'resource',
      author: NOAH,
      summary: 'Who clinics compare us to, what they actually say on calls, and where Flow wins and loses.',
      tags: ['research', 'competitive'],
      content: `# Competitive landscape

Clinics rarely compare us to one product. They compare us to the system they already hate, a spreadsheet, and whatever their practice-management vendor bundles.

## The categories

**Legacy practice management suites (CareGrid, Praxos).** Broad, expensive, sold through resellers. Scheduling is one module among twenty and feels like it. They win on trust and integration. They lose on speed, onboarding time, and the fact that a front-desk change takes a support ticket.

**Standalone schedulers (Slotwise, Appointa).** Fast to set up, consumer-grade, priced per provider. They win demos and lose on clinic-specific needs: recurring provider blocks, multi-location reporting, and the front desk's habit of booking three people at once.

**Spreadsheets and paper.** Still the most common competitor in our pipeline, especially at two- to five-provider clinics. They are free, flexible, and fail silently. Our best demos are the ones where we reconstruct a real double booking from their own sheet.

## What we hear on calls

- "We tried Slotwise but it could not handle our provider rotations."
- "CareGrid does everything, we use four percent of it, and we pay for all of it."
- "The last system took six weeks to set up. If this takes six weeks, we are not doing it."
- "Can it tell me which location is under-booked?"

The third quote is why the onboarding wizard exists. The fourth is why reporting is on the Q2 list.

## Where Flow wins

Setup time, grid speed, and the honesty of the pricing page. Clinics that switch tell us the schedule feels like it was built by someone who has actually worked a front desk.

## Where we lose

Security reviews, SSO, and anything a 12-location group needs before a pilot. We are also weaker on reporting today, which is the most common reason a pilot says "not yet" rather than "no".

## Positioning

The fastest schedule for multi-location clinics, priced per clinic, set up in a day. We are not the cheapest and we are not the fullest suite. We are the one the front desk does not want taken away. That is a defensible position only if we keep shipping reliability work that nobody puts on a slide.`,
    },
    {
      key: 'weekly-metrics',
      title: 'Weekly metrics',
      type: 'resource',
      author: NOAH,
      summary: 'The weekly scoreboard for pilots, activation, pipeline, and spend. One definition per metric, kept stable.',
      tags: ['metrics', 'investors'],
      content: `# Weekly metrics

Definitions are deliberately boring and do not change week to week. If a definition changes, the old series is restated and the change is noted here.

| Metric | W40 | W41 | W42 | W43 | Definition |
| --- | --- | --- | --- | --- | --- |
| Live pilots | 2 | 2 | 3 | 3 | Clinic actively booking real patients |
| Providers on Flow | 19 | 26 | 38 | 41 | Distinct providers with at least one booking |
| Appointments booked | 412 | 780 | 1,390 | 1,840 | Cumulative, all pilots |
| Median setup (days) | 11 | 10 | 9 | 9 | Contract signed to first booking |
| Weighted pipeline | $84k | $120k | $152k | $186k | Pilot-ready × probability |
| Demos booked | 3 | 5 | 8 | 11 | First calls in the week |
| Burn (monthly) | $62k | $61k | $63k | $63k | Cash operating cost |

## What moved

Appointments crossed 1,800. Brightside went from 61% to 92% of appointments booked through Flow in three weeks, which is the strongest adoption curve we have seen. Setup time held at nine days, and the onboarding wizard has not shipped yet, so we expect that number to fall — not because we got better at calls, but because the product stopped waiting on spreadsheets.

## What did not move

Demo to pilot conversion is flat at 36%. The pricing page and the three-tier structure should help, but we will not know until after launch. Northside Pediatrics is verbal and not counted as live until they book.

## What worries me

Five clinics by Q1 is a support constraint, not a demand constraint. Every additional pilot adds onboarding calls, data imports, and front-desk questions. The support hire is in the plan; if it slips, the pipeline number is fiction.

## How to read this page

Use the weighted pipeline number in investor conversations, never the unweighted one. Use appointments booked as a cumulative figure and providers as the active measure. If you need a slice by clinic, ask me rather than deriving it from this table — the denominators are not obvious.`,
    },
    {
      key: 'hiring',
      title: 'Hiring plan',
      type: 'resource',
      author: MANEEK,
      summary: 'Who we hire next, in what order, and what each hire unlocks.',
      tags: ['hiring', 'planning'],
      content: `# Hiring plan

We are five people. The next three hires are chosen for what they unblock, not for what sounds impressive in a deck.

## 1. Support and onboarding lead (Q1)

**Why now:** Noah is doing demos, onboarding, and support. That is three jobs and one of them is always late. Every new pilot adds calls without adding capacity.

**What they own:** onboarding calls, data imports, the first-week check-ins, and the support inbox. They write the playbook updates, not Maya.

**Profile:** has run a front desk or supported clinic software. Patient with people who are having a bad day. Does not need to be technical, but must be comfortable in a spreadsheet and a settings screen.

**Unlocks:** five pilots by Q1 without the product getting blamed for our calendar.

## 2. Full-stack engineer (Q1–Q2)

**Why now:** Leo is the only engineer. He is also the on-call rotation, the release process, and the person who writes the postmortems. That is a single point of failure with a launch on the calendar.

**What they own:** the reporting surface and the integration work, then a share of on-call.

**Profile:** comfortable with Postgres, boring infrastructure, and writing tests for concurrency. We will ask about a bug they shipped and how they found it.

**Unlocks:** Q2 reporting without pausing product work.

## 3. Designer (Q2)

**Why now:** Amina owns the entire design surface and the design system. The grid migration, the same-day view, and reporting are already queued behind launch.

**What they own:** the same-day view and the reporting interface, with Amina owning the system.

**Profile:** systems thinker who can work inside a token set without needing to redesign it. Strong opinions about density and empty states.

**Unlocks:** shipping two surfaces in a quarter instead of one.

## What we are not hiring

No sales team until the pricing is proven across ten clinics. No customer success manager until onboarding is a repeatable process rather than a person. No engineering manager until there are more engineers than Leo can reasonably talk to in a week.

## Budget

Three hires at market rate add roughly $46k per month at full load. That extends runway by reducing the support bottleneck rather than by growing headcount for its own sake. If we miss the Q1 pipeline target, the designer hire moves to Q3 and the other two stay — support and engineering capacity are not optional at this stage.`,
    },
    {
      key: 'meeting-notes',
      title: 'Meeting notes index',
      type: 'resource',
      author: MAYA,
      summary: 'Where the decisions live. One row per recurring or consequential meeting.',
      tags: ['process', 'decisions'],
      content: `# Meeting notes index

We do not keep notes in five places. Decisions go in the relevant wiki page; this index links to them so nobody has to reconstruct a conversation from chat.

| Meeting | Cadence | Owner | Where the notes live |
| --- | --- | --- | --- |
| Daily standup | 10:00 IST, weekdays | Maya | #general, three lines per person |
| Launch review | Weekly until Nov 11 | Maya | Flow v2 launch plan |
| Go/no-go | Nov 9, 15:00 IST | Maneek | Flow v2 launch plan |
| Design crit | Weekly, Thursday | Amina | #design, then Design principles |
| Pilot check-ins | Weekly per clinic | Noah | Clinic pilot playbook and the task board |
| Investor update | Monthly | Maneek | Founder notes, shared externally as a PDF |
| 1:1s | Weekly, 30 minutes | Maneek | Private notes, decisions copied to the relevant page |
| Retro | After each incident | Leo | Engineering runbook, postmortem section |

## Rules

1. If a meeting produces a decision, it goes in a wiki page the same day. A decision that only exists in a call did not happen.
2. If a meeting produces work, it becomes a task with an owner and a date before the meeting ends.
3. If a meeting produces neither, we stop having it. The calendar is not a museum.

## Recent decisions

- **Pricing:** three tiers at $149 / $399 / $1,200+. See Pricing decision log.
- **Launch date:** November 11, moved from November 4. See Flow v2 launch plan.
- **Scope cuts:** dark mode, saved views, bulk reschedule, same-day view. See the launch plan cut list.
- **Support hire:** approved for Q1, role drafted by Maya. See Hiring plan.
- **Incident response:** clinic called within the hour, credit issued without negotiation, regression test before the postmortem. See Engineering runbook.

## Finding things

Start with the page, not the search. The wiki is small on purpose: twelve pages that are maintained beat two hundred that are stale. If a page has not been touched in a quarter, either update it or delete it.`,
    },
  ];

  const wikiIds = new Map<string, string>();
  for (const [index, page] of wikiDefs.entries()) {
    const [inserted] = await db.insert(schema.wikiPages).values({
      org_id: ORG_ID,
      scope: 'org',
      type: page.type,
      title: page.title,
      slug: slugify(page.title),
      summary: page.summary,
      content: page.content,
      user_id: page.author,
      origin_user_id: page.author,
      created_via: 'manual',
      confidence: 0.95,
      tags: page.tags,
      created_at: atIST(-20 + index, 11, 30),
      updated_at: atIST(-2 + (index % 3), 15, 0),
    }).returning({ id: schema.wikiPages.id });
    wikiIds.set(page.key, inserted!.id);
    bump('wiki_pages');
  }

  const wikiLinkPlan: Array<[string, string, string]> = [
    ['strategy', 'launch-plan', 'The launch plan is the current expression of the strategy'],
    ['strategy', 'competitive', 'Positioning is defined against these categories'],
    ['launch-plan', 'pricing', 'Pricing ships as part of v2'],
    ['launch-plan', 'runbook', 'Launch-day rollback and severity definitions'],
    ['pricing', 'weekly-metrics', 'Pipeline and conversion tracking for the tiers'],
    ['pilot-playbook', 'personas', 'The people the pilot process is designed for'],
    ['pilot-playbook', 'onboarding-guide', 'Internal onboarding mirrors the clinic process'],
    ['design-principles', 'personas', 'Design decisions are justified against these users'],
    ['runbook', 'launch-plan', 'Freeze dates and rollback expectations'],
    ['onboarding-guide', 'meeting-notes', 'Where decisions from rituals are recorded'],
    ['hiring', 'weekly-metrics', 'Support capacity is the constraint on the pipeline'],
    ['competitive', 'strategy', 'Where we choose to compete, and where we do not'],
  ];
  for (const [source, target, context] of wikiLinkPlan) {
    await db.insert(schema.wikiLinks).values({
      org_id: ORG_ID,
      source_page_id: wikiIds.get(source)!,
      target_page_id: wikiIds.get(target)!,
      context,
    });
    bump('wiki_links');
  }

  // Cross-references: messages and tasks pointing at wiki knowledge.
  const crossRefPlan: Array<{ sourceType: 'message' | 'task'; sourceKey: string; page: string; context: string; createdBy: string }> = [
    { sourceType: 'message', sourceKey: 'e-bug', page: 'runbook', context: 'Double-booking report is the incident the runbook documents', createdBy: LEO },
    { sourceType: 'message', sourceKey: 'p-final', page: 'pricing', context: 'Final tier prices announced in #product', createdBy: MAYA },
    { sourceType: 'message', sourceKey: 'd-publish', page: 'design-principles', context: 'Token rollout follows the subtraction principle', createdBy: AMINA },
    { sourceType: 'message', sourceKey: 'l-confirm', page: 'launch-plan', context: 'Launch date confirmation', createdBy: MANEEK },
    { sourceType: 'message', sourceKey: 'gr-cap', page: 'hiring', context: 'Support capacity drives the hiring plan', createdBy: NOAH },
    { sourceType: 'task', sourceKey: 'v2:data-room', page: 'weekly-metrics', context: 'Data room uses the weekly metric definitions', createdBy: MANEEK },
    { sourceType: 'task', sourceKey: 'v2:tier-config', page: 'pricing', context: 'Billing configuration must match the decision log', createdBy: LEO },
    { sourceType: 'task', sourceKey: 'pilot:expansion', page: 'pilot-playbook', context: 'Expansion is gated by the pilot process', createdBy: MANEEK },
    { sourceType: 'task', sourceKey: 'pilot:onboarding-playbook', page: 'onboarding-guide', context: 'Playbook v2 and internal onboarding share the same stages', createdBy: MAYA },
    { sourceType: 'task', sourceKey: 'v2:metrics-snapshot', page: 'weekly-metrics', context: 'Weekly snapshot uses these definitions', createdBy: MANEEK },
  ];
  for (const ref of crossRefPlan) {
    const sourceId = ref.sourceType === 'message' ? messageIds.get(ref.sourceKey)?.id : taskIds.get(ref.sourceKey);
    if (!sourceId) throw new Error(`cross-reference source ${ref.sourceKey} does not exist`);
    await db.insert(schema.crossReferences).values({
      org_id: ORG_ID,
      source_type: ref.sourceType,
      source_id: sourceId,
      target_type: 'wiki_page',
      target_id: wikiIds.get(ref.page)!,
      context: ref.context,
      created_by: ref.createdBy,
    });
    bump('cross_references');
  }

  // ── Notes (Maneek / Founder) ──────────────────────────────────────────────
  const [folder] = await db.insert(schema.noteFolders).values({
    org_id: ORG_ID,
    user_id: MANEEK,
    name: 'Founder',
    icon: '🧭',
    sort_order: 0,
  }).returning({ id: schema.noteFolders.id });
  bump('note_folders');

  const noteDefs: Array<{ title: string; icon: string; pinned: boolean; content: string }> = [
    {
      title: 'Investor update draft (October)',
      icon: '📈',
      pinned: true,
      content: `<h1>October investor update</h1>
<p>Three live pilots, 41 providers, 1,840 appointments booked through Flow. Weighted pipeline moved from $152k to $186k. Pricing settled on three tiers. Launch date locked for November 11.</p>
<h2>What went well</h2>
<ul>
<li>Brightside Dental moved from 61% to 92% of appointments through Flow in three weeks.</li>
<li>Design system v2 shipped; the product finally looks like one product.</li>
<li>Lakeview stayed after a production incident. That is a reference, not just a retention save.</li>
</ul>
<h2>What went badly</h2>
<p>We shipped a booking race condition. Two appointments, one slot. We found it because a customer told us. Fixed the same evening, credited a month, wrote the test that should have existed. I would rather report this than have it surface in diligence.</p>
<h2>Asks</h2>
<p>Intros to clinic groups with 5–15 locations. We are not ready for 30-location enterprises yet, and I will say that on the call.</p>
<h2>Next month</h2>
<p>Launch, five pilots by Q1, and a support hire that keeps the pipeline from becoming fiction.</p>`,
    },
    {
      title: 'Board meeting prep',
      icon: '🗂️',
      pinned: true,
      content: `<h1>Board meeting prep</h1>
<h2>Opening (5 min)</h2>
<p>Three pilots, launch on November 11, one incident handled properly. Lead with the incident; do not let it be discovered in the appendix.</p>
<h2>Numbers (10 min)</h2>
<ul>
<li>1,840 appointments booked, 41 providers, 3 live clinics.</li>
<li>Weighted pipeline $186k. Support capacity, not demand, is the constraint.</li>
<li>Burn $63k/month. Runway comfortable through the launch quarter.</li>
</ul>
<h2>Decisions I want ratified</h2>
<ol>
<li>Three-tier pricing at $149 / $399 / $1,200+.</li>
<li>Support and onboarding hire in Q1, before the fifth pilot.</li>
<li>No enterprise motion until the support model can survive a security review.</li>
</ol>
<h2>Questions I expect</h2>
<p><strong>Why only three pilots?</strong> Because we spent the quarter making the product not double-book. Depth is the strategy.</p>
<p><strong>What if launch slips?</strong> It does not. We already moved it once and cut scope to protect the date.</p>
<p><strong>What breaks at 3x?</strong> Support. That is the hire.</p>
<h2>What I need from the board</h2>
<p>Two clinic-group intros and one candidate for the support lead role. Nothing else.</p>`,
    },
    {
      title: '1:1 notes with Maya',
      icon: '🗒️',
      pinned: false,
      content: `<h1>1:1 — Maya</h1>
<h2>Launch ownership</h2>
<p>Maya owns the launch checklist, in writing, announced in #launch-v2. Three people thought they owned it. That is on me for not saying it once, clearly.</p>
<h2>Support hire</h2>
<p>Q1 cost, not a Q4 maybe. Maya drafts the role and the band this week. If we triple pilots on current support we lose a clinic, and the product gets blamed for a staffing decision.</p>
<h2>Feedback</h2>
<p>She is doing the work of a head of product and a program manager. The fix is a hire, not more process. I told her to stop covering the gap silently and start naming it in leadership.</p>
<h2>Personal</h2>
<p>Taking the 14th off; I told her to take the 15th too. She will not, but the offer matters.</p>
<h2>Follow-ups</h2>
<ul>
<li>Announce launch ownership in #launch-v2. Done.</li>
<li>Approve support role and band by Friday.</li>
<li>Ask Noah to hand off onboarding calls once the hire starts, not before.</li>
</ul>`,
    },
    {
      title: 'Launch go/no-go checklist',
      icon: '✅',
      pinned: true,
      content: `<h1>Go/no-go — Monday</h1>
<h2>Must be true</h2>
<ul>
<li>Zero open sev-1 bugs.</li>
<li>Onboarding wizard through QA on desktop and mobile.</li>
<li>Pricing page live, legal-reviewed, with the metered SMS rate confirmed.</li>
<li>SMS sender registration approved and a test message delivered.</li>
<li>Rollback rehearsed by Leo, not just documented.</li>
</ul>
<h2>Current status</h2>
<ul>
<li>Sev-1: timezone fix merged, waiting on QA sign-off.</li>
<li>Wizard: desktop passed; one 375px overlap being fixed.</li>
<li>Pricing page: copy final, legal due Thursday.</li>
<li>SMS: approved, confirmation in Noah's inbox.</li>
<li>Rollback: rehearsed once, will rehearse again Monday morning.</li>
</ul>
<h2>If red</h2>
<p>Delay one week. No heroics, no "we will monitor it closely". A launch with a red item is a launch we spend the next month apologising for.</p>
<h2>Decision</h2>
<p>Maneek, Maya, Leo. 15:00 IST Monday. Decision recorded in the launch plan, not in chat.</p>`,
    },
    {
      title: 'Ideas backlog',
      icon: '💡',
      pinned: false,
      content: `<h1>Ideas backlog</h1>
<p>Things worth remembering, not yet worth scheduling. If an idea survives two months and a customer asks for it twice, it graduates to a task.</p>
<h2>Product</h2>
<ul>
<li><strong>Same-day view.</strong> A persistent list the front desk keeps open. Two clinics asked independently. Likely first post-launch feature.</li>
<li><strong>Self-serve trial.</strong> 14 days, one location, no card. Would reduce Noah's demo load, but support load may offset it.</li>
<li><strong>Waitlist backfill.</strong> When a slot opens, text the three people most likely to take it. High value, high trust risk if the messaging is clumsy.</li>
<li><strong>Provider utilisation report.</strong> Marcus asked for it in every call. Q2.</li>
</ul>
<h2>Business</h2>
<ul>
<li>Annual prepay discount of 10%, only after the first renewal cohort proves retention.</li>
<li>Clinic-group referral programme. Brightside's practice manager has already referred two clinics for free. Fix that.</li>
<li>Partner with a billing vendor rather than building billing. Revisit in Q2.</li>
</ul>
<h2>Rejected for now</h2>
<ul>
<li>Patient-facing app. Too much surface, too little revenue at our stage.</li>
<li>AI scheduling assistant. Interesting, not the bottleneck. The bottleneck is trust in the grid.</li>
<li>Dark mode. Ask me in January.</li>
</ul>`,
    },
    {
      title: 'Pilot customer call notes',
      icon: '📞',
      pinned: false,
      content: `<h1>Pilot calls — week of launch prep</h1>
<h2>Lakeview Physio — Dana</h2>
<p>Back to normal volume after the double booking. Accepted the credit, was clear that a second incident ends the pilot. Asked for a same-day list the front desk can keep open. Interested in annual pricing after launch, not before.</p>
<h2>Brightside Dental — practice manager</h2>
<p>92% of appointments now through Flow. Reminder texts failed once on a Monday batch; Leo is fixing the rate limit. They want reporting by location next. Strongest reference we have; renewal conversation after launch.</p>
<h2>Harbor Family Clinic — operations</h2>
<p>Onboarding Monday. Four spreadsheets, 2,300 appointments, 47 provider names that do not match anything. Leo is mapping by hand. They are nervous about the first week, which is reasonable. I will join the day-3 check-in personally.</p>
<h2>Northside Pediatrics</h2>
<p>Verbal yes for January. I told them February capacity rather than overpromising. They appreciated the honesty, or at least did not argue with it.</p>
<h2>Pattern across all four</h2>
<p>Nobody asks for more features. They ask for reliability, reporting, and fewer places to look. That is the roadmap, whether or not it makes a good slide.</p>`,
    },
  ];

  const noteIds = new Map<string, string>();
  for (const [index, note] of noteDefs.entries()) {
    const [inserted] = await db.insert(schema.notes).values({
      org_id: ORG_ID,
      user_id: MANEEK,
      folder_id: folder!.id,
      title: note.title,
      icon: note.icon,
      content: note.content,
      is_pinned: note.pinned,
      visibility: 'private',
      version: 1,
      created_at: atIST(-18 + index * 2, 9, 40),
      updated_at: atIST(-1 - (index % 4), 18, 10),
    }).returning({ id: schema.notes.id });
    noteIds.set(note.title, inserted!.id);
    bump('notes');
  }

  // ── Tags + entity tags ────────────────────────────────────────────────────
  const tagDefs: Array<[string, string]> = [
    ['launch', '#2563EB'],
    ['pricing', '#10B981'],
    ['pilot', '#F97316'],
    ['design', '#DB2777'],
    ['infra', '#6366F1'],
    ['hiring', '#0EA5E9'],
    ['metrics', '#EAB308'],
    ['research', '#8B5CF6'],
  ];
  const tagIds = new Map<string, string>();
  for (const [name, color] of tagDefs) {
    const [inserted] = await db.insert(schema.tags).values({ org_id: ORG_ID, name, color }).returning({ id: schema.tags.id });
    tagIds.set(name, inserted!.id);
    bump('tags');
  }

  const entityTagPlan: Array<{ tag: string; type: 'message' | 'task' | 'note'; key: string }> = [
    { tag: 'launch', type: 'task', key: 'v2:checklist' },
    { tag: 'launch', type: 'task', key: 'v2:runbook' },
    { tag: 'launch', type: 'message', key: 'l-confirm' },
    { tag: 'pricing', type: 'task', key: 'v2:tier-config' },
    { tag: 'pricing', type: 'message', key: 'p-final' },
    { tag: 'pricing', type: 'note', key: 'Investor update draft (October)' },
    { tag: 'pilot', type: 'task', key: 'pilot:harbor-import' },
    { tag: 'pilot', type: 'task', key: 'pilot:expansion' },
    { tag: 'pilot', type: 'message', key: 'gr-numbers' },
    { tag: 'design', type: 'task', key: 'design:tokens' },
    { tag: 'design', type: 'message', key: 'd-publish' },
    { tag: 'infra', type: 'task', key: 'v2:regression' },
    { tag: 'infra', type: 'task', key: 'pilot:access-audit' },
    { tag: 'hiring', type: 'note', key: 'Board meeting prep' },
    { tag: 'metrics', type: 'note', key: 'Investor update draft (October)' },
    { tag: 'research', type: 'note', key: 'Pilot customer call notes' },
  ];
  for (const binding of entityTagPlan) {
    const entityId = binding.type === 'message'
      ? messageIds.get(binding.key)?.id
      : binding.type === 'task'
        ? taskIds.get(binding.key)
        : noteIds.get(binding.key);
    if (!entityId) throw new Error(`entity tag target ${binding.key} does not exist`);
    const ok = await withSavepoint(db, async () => {
      await db.insert(schema.entityTags).values({
        org_id: ORG_ID,
        tag_id: tagIds.get(binding.tag)!,
        entity_type: binding.type,
        entity_id: entityId,
      });
      return true;
    });
    if (ok) bump('entity_tags');
  }

  console.log(`[seed] created ${wikiDefs.length} wiki pages, ${noteDefs.length} notes, ${tagDefs.length} tags`);

  // ── Calendar ──────────────────────────────────────────────────────────────
  const launchDate = nextNovember11();
  const atISTOn = (date: Date, hour: number, minute = 0): Date => {
    const parts = istParts(date);
    return new Date(Date.UTC(parts.y, parts.m, parts.d, hour, minute) - IST_OFFSET);
  };

  const pilotCallDays = workingDaysAhead(9);
  const oneOnOneDays = workingDaysAhead(4);
  const designCritDay = workingDaysAhead(5)[3]!;

  type EventDef = {
    slug: string;
    title: string;
    body: string;
    start: Date;
    end: Date;
    location: string;
    attendees: string[];
    allDay?: boolean;
  };
  const eventDefs: EventDef[] = [];

  for (const [index, dayOffset] of workingDaysAhead(10).entries()) {
    eventDefs.push({
      slug: `standup-${index + 1}`,
      title: 'Daily standup',
      body: 'Three lines each: yesterday, today, blockers. Ten minutes, no slides.',
      start: atIST(dayOffset, 10, 0),
      end: atIST(dayOffset, 10, 20),
      location: 'Google Meet',
      attendees: ['Maneek Mohan', 'Maya Rao', 'Leo Park', 'Amina Shah', 'Noah Chen'],
    });
  }

  eventDefs.push(
    {
      slug: 'investor-meeting',
      title: 'Investor meeting',
      body: 'Nine slides: problem, product, pilots, pricing, launch, pipeline, team, ask, appendix. Weighted pipeline only.',
      start: atIST(1, 15, 0),
      end: atIST(1, 16, 0),
      location: 'Google Meet',
      attendees: ['Maneek Mohan', 'Maya Rao', 'Noah Chen'],
    },
    {
      slug: 'launch-review',
      title: 'Flow v2 launch review',
      body: 'Walk the 34-item checklist, confirm the freeze, and decide whether Monday is still green.',
      start: atISTOn(new Date(launchDate.getTime() - 5 * DAY), 16, 0),
      end: atISTOn(new Date(launchDate.getTime() - 5 * DAY), 17, 0),
      location: 'Google Meet',
      attendees: ['Maneek Mohan', 'Maya Rao', 'Leo Park', 'Amina Shah', 'Noah Chen'],
    },
    {
      slug: 'pilot-call-brightside',
      title: 'Brightside Dental pilot call',
      body: 'Adoption review, SMS retry fix, and the reporting request. Renewal conversation waits until after launch.',
      start: atIST(pilotCallDays[2]!, 11, 0),
      end: atIST(pilotCallDays[2]!, 11, 30),
      location: 'Google Meet',
      attendees: ['Noah Chen', 'Maya Rao'],
    },
    {
      slug: 'pilot-call-lakeview',
      title: 'Lakeview Physio check-in',
      body: 'Confirm booking volume is back to normal and discuss the same-day view request.',
      start: atIST(pilotCallDays[4]!, 15, 0),
      end: atIST(pilotCallDays[4]!, 15, 30),
      location: 'Google Meet',
      attendees: ['Noah Chen', 'Maneek Mohan'],
    },
    {
      slug: 'pilot-call-harbor',
      title: 'Harbor Family Clinic onboarding',
      body: 'Day-3 check-in after Monday onboarding. Verify imported appointments and provider mapping.',
      start: atIST(pilotCallDays[7]!, 10, 30),
      end: atIST(pilotCallDays[7]!, 11, 15),
      location: 'Google Meet',
      attendees: ['Noah Chen', 'Maya Rao', 'Leo Park'],
    },
    {
      slug: 'design-crit',
      title: 'Design crit',
      body: 'Onboarding wizard at 375px, grid rhythm after the gutter change, and the same-day view concept.',
      start: atIST(designCritDay, 14, 0),
      end: atIST(designCritDay, 15, 0),
      location: 'Room 2 / Google Meet',
      attendees: ['Amina Shah', 'Maya Rao', 'Maneek Mohan'],
    },
    {
      slug: 'launch-day',
      title: 'Flow v2 launch',
      body: 'Comms at 09:30 IST. Support rota from 10:00. Day-one retro at 17:00 in #general.',
      start: atISTOn(launchDate, 9, 0),
      end: atISTOn(launchDate, 17, 30),
      location: 'Northstar Labs',
      attendees: ['Maneek Mohan', 'Maya Rao', 'Leo Park', 'Amina Shah', 'Noah Chen'],
    },
  );

  const oneOnOnePeople: Array<[string, string, number, number]> = [
    [MAYA, 'Maya Rao', 17, 0],
    [LEO, 'Leo Park', 17, 30],
    [AMINA, 'Amina Shah', 17, 0],
    [NOAH, 'Noah Chen', 17, 30],
  ];
  for (const [index, [userId, name, hour, minute]] of oneOnOnePeople.entries()) {
    eventDefs.push({
      slug: `one-on-one-${slugify(name)}`,
      title: `1:1 — Maneek & ${name.split(' ')[0]}`,
      body: 'Weekly 30 minutes. Bring one decision, one risk, and one thing that is working.',
      start: atIST(oneOnOneDays[index]!, hour, minute),
      end: atIST(oneOnOneDays[index]!, hour, minute + 30),
      location: 'Google Meet',
      attendees: ['Maneek Mohan', name],
    });
    if (!userId) throw new Error('missing 1:1 owner');
  }

  const seenExternalIds = new Set<string>();
  for (const event of eventDefs) {
    const externalId = `investor-${istDateStamp(event.start)}-${event.slug}`;
    if (seenExternalIds.has(externalId)) throw new Error(`duplicate calendar external id ${externalId}`);
    seenExternalIds.add(externalId);
    await db.insert(schema.events).values({
      org_id: ORG_ID,
      source: 'native',
      event_type: 'calendar_event',
      external_id: externalId,
      title: event.title,
      body: event.body,
      url: null,
      actor: 'maneek@northstarlabs.example',
      timestamp: event.start,
      user_id: MANEEK,
      metadata: {
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        location: event.location,
        attendees: event.attendees,
        organizer: 'maneek@northstarlabs.example',
        hangoutLink: event.location.includes('Meet') ? 'https://meet.example.com/northstar-flow' : null,
        status: 'confirmed',
        allDay: event.allDay ?? false,
        feedLabel: 'Native Deft calendar',
        seed: SEED_MARKER,
      },
      created_at: atIST(-7, 12, 0),
      updated_at: now,
    }).onConflictDoNothing();
    bump('events');
  }
  console.log(`[seed] created ${eventDefs.length} calendar events`);

  // ── Standups — last five working days, one per person ────────────────────
  type StandupLines = { yesterday: string; today: string; blockers: string };
  const standupPeople: Array<{ id: string; name: string; lines: StandupLines[] }> = [
    {
      id: MANEEK, name: 'Maneek Mohan', lines: [
        { yesterday: 'Pricing debate, investor deck outline, Lakeview call', today: 'Decide the three tiers, review the deck, call Dana at 14:00', blockers: 'Waiting on final pipeline numbers from Noah' },
        { yesterday: 'Pricing decision, launch date moved to November 11', today: 'Write the narrative for the investor meeting, review launch scope', blockers: 'None' },
        { yesterday: 'Investor prep with Maya and Noah, pricing log review', today: 'Dry-run the demo path, approve the support hire band', blockers: 'Need the final SMS rate for the pricing FAQ' },
        { yesterday: 'Investor meeting, pipeline review, 1:1 with Maya', today: 'Approve launch checklist red items, review data room', blockers: 'Legal timing on the pricing page' },
        { yesterday: 'Go/no-go prep, investor follow-ups, hiring plan', today: 'Confirm Monday go/no-go, keep scope frozen', blockers: 'Nothing new. That is the point.' },
      ],
    },
    {
      id: MAYA, name: 'Maya Rao', lines: [
        { yesterday: 'Scope freeze, launch plan update, pilot intake checklist', today: 'Pricing decision log, Harbor intake review', blockers: 'Need engineering estimate on the grid freeze' },
        { yesterday: 'Pricing options review, launch plan rewrite', today: 'Finalise three-tier structure, update the checklist', blockers: 'SMS overage rate from Leo' },
        { yesterday: 'Onboarding copy, pilot survey draft', today: 'Launch comms review with Noah, pilot check-in notes', blockers: 'None' },
        { yesterday: 'Investor slides, launch review prep', today: 'Chase legal on pricing page, update checklist status', blockers: 'Legal review is due Thursday' },
        { yesterday: 'Go/no-go criteria, support role draft', today: 'Publish Monday checklist, confirm owners', blockers: 'Onboarding wizard mobile bug is still open' },
      ],
    },
    {
      id: LEO, name: 'Leo Park', lines: [
        { yesterday: 'Slot service refactor, advisory locks behind the flag', today: 'Reproduce the Lakeview double booking, ship the fix', blockers: 'Need a production replay window' },
        { yesterday: 'Shipped the lock, replayed 40k concurrent requests', today: 'Write the regression test, add conflict dashboard', blockers: 'None, but the test needs to be deterministic' },
        { yesterday: 'Conflict dashboard, booking latency baseline', today: 'Merge timezone fix, triage sev-2s', blockers: 'QA sign-off on the timezone edge case' },
        { yesterday: 'Harbor import mapping, SMS retry queue', today: 'Chase SMS sender registration, review runbook', blockers: 'Provider support has not replied yet' },
        { yesterday: 'Rollback rehearsal, load test review', today: 'Final pre-freeze checks, on-call handover notes', blockers: 'None. Freeze at 18:00 Monday.' },
      ],
    },
    {
      id: AMINA, name: 'Amina Shah', lines: [
        { yesterday: 'Component audit, token proposal, provider name truncation', today: 'Publish token draft, spec the grid gutter change', blockers: 'Grid is frozen — need a migration window after launch' },
        { yesterday: 'Token package build, contrast pairing', today: 'Onboarding empty states, contrast fixes', blockers: 'None' },
        { yesterday: 'Onboarding wizard layout, mobile breakpoint review', today: 'Fix the 375px overlap, review tokens in the app', blockers: 'Waiting on Leo to merge the grid spacing change' },
        { yesterday: 'Same-day view concept, component docs outline', today: 'Design crit prep, grid migration pass', blockers: 'One open question on row height at 1024px' },
        { yesterday: 'Grid snapshots, wizard QA on mobile', today: 'Finish the overlap fix, hand off the Figma library', blockers: 'None before design freeze' },
      ],
    },
    {
      id: NOAH, name: 'Noah Chen', lines: [
        { yesterday: 'Pipeline review, two demos, Brightside check-in', today: 'Harbor onboarding prep, pricing one-pager request', blockers: 'No per-location price to quote yet' },
        { yesterday: 'Brightside adoption review, Northside follow-up', today: 'Draft pilot pricing letters, update pipeline sheet', blockers: 'Need Maya to confirm the renewal price' },
        { yesterday: 'Demo with the 12-location dental group, security questionnaire', today: 'Follow up on the security review, pilot survey sends', blockers: 'Waiting on our security answers for SSO' },
        { yesterday: 'Investor meeting, pipeline numbers, launch comms draft', today: 'Launch comms final copy, Lakeview check-in', blockers: 'None' },
        { yesterday: 'Northside capacity conversation, renewal prep', today: 'Finalise comms, support rota for launch week', blockers: 'Support rota depends on the new hire start date' },
      ],
    },
  ];

  const standupDays = workingDaysBack(5).reverse();
  for (const [dayIndex, dayOffset] of standupDays.entries()) {
    for (const person of standupPeople) {
      const lines = person.lines[dayIndex]!;
      await db.insert(schema.standups).values({
        org_id: ORG_ID,
        date: atIST(dayOffset, 9, 30),
        generated_by: person.id,
        summary: `${person.name}: ${lines.today}. Blocker: ${lines.blockers}`,
        raw_data: {
          name: person.name,
          user_id: person.id,
          yesterday: lines.yesterday,
          today: lines.today,
          blockers: lines.blockers,
          source: SEED_MARKER,
        },
        created_at: atIST(dayOffset, 9, 35),
        updated_at: atIST(dayOffset, 9, 35),
      });
      bump('standups');
    }
  }
  console.log(`[seed] created ${standupDays.length * standupPeople.length} standups`);

  // ── Contacts (only if the Contacts module is installed in this org) ──────
  const [contactsInstallation] = await db
    .select({ id: schema.moduleInstallations.id })
    .from(schema.moduleInstallations)
    .where(sql`${schema.moduleInstallations.org_id} = ${ORG_ID}
      and ${schema.moduleInstallations.module_id} = 'com.deft.contacts'
      and ${schema.moduleInstallations.is_deleted} = false`)
    .limit(1);

  if (!contactsInstallation) {
    console.log('[contacts] no com.deft.contacts module installed in this org - skipped');
  } else {
    const versions = await db
      .select({ id: schema.moduleVersions.id, isActive: schema.moduleVersions.is_active, createdAt: schema.moduleVersions.created_at })
      .from(schema.moduleVersions)
      .where(sql`${schema.moduleVersions.org_id} = ${ORG_ID}
        and ${schema.moduleVersions.installation_id} = ${contactsInstallation.id}`);
    const activeVersion = versions.find((version) => version.isActive)
      ?? [...versions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!activeVersion) {
      console.log('[contacts] module installed but has no version row - skipped');
    } else {
      const crmRecords = await db
        .select({
          id: schema.moduleRecords.id,
          collectionKey: schema.moduleRecords.collection_key,
          data: schema.moduleRecords.data,
          revision: schema.moduleRecords.revision,
          validatedVersionId: schema.moduleRecords.validated_version_id,
          createdByActorType: schema.moduleRecords.created_by_actor_type,
          createdByActorId: schema.moduleRecords.created_by_actor_id,
          updatedByActorType: schema.moduleRecords.updated_by_actor_type,
          updatedByActorId: schema.moduleRecords.updated_by_actor_id,
          isDeleted: schema.moduleRecords.is_deleted,
        })
        .from(schema.moduleRecords)
        .where(sql`${schema.moduleRecords.org_id} = ${ORG_ID}
          and ${schema.moduleRecords.installation_id} = ${contactsInstallation.id}`);
      // Visible records are reused; record shapes may also come from ones the fresh cleanup hid.
      const byCollection = new Map<string, typeof crmRecords>();
      const shapeByCollection = new Map<string, (typeof crmRecords)[number]>();
      for (const record of crmRecords) {
        if (!shapeByCollection.has(record.collectionKey)) shapeByCollection.set(record.collectionKey, record);
        if (record.isDeleted) continue;
        const bucket = byCollection.get(record.collectionKey) ?? [];
        bucket.push(record);
        byCollection.set(record.collectionKey, bucket);
      }
      const shapeFor = (collectionKey: string) => shapeByCollection.get(collectionKey) ?? crmRecords[0];
      const relationEdges = await db
        .select({ fieldKey: schema.moduleRecordRelations.field_key })
        .from(schema.moduleRecordRelations)
        .where(sql`${schema.moduleRecordRelations.org_id} = ${ORG_ID}
          and ${schema.moduleRecordRelations.installation_id} = ${contactsInstallation.id}
          and ${schema.moduleRecordRelations.is_deleted} = false`);
      const relationFields = new Set(relationEdges.map((edge) => edge.fieldKey));
      relationFields.add('company_id');
      relationFields.add('primary_contact_id');
      relationFields.add('contact_id');
      relationFields.add('deal_id');

      const insertCrmRecord = async (
        collectionKey: string,
        values: Record<string, unknown>,
        title: string,
        subtitle: string | null,
        createdAt: Date,
      ): Promise<{ id: string; inserted: boolean }> => {
        const [duplicate] = await db
          .select({ id: schema.moduleRecords.id })
          .from(schema.moduleRecords)
          .where(sql`${schema.moduleRecords.org_id} = ${ORG_ID}
            and ${schema.moduleRecords.installation_id} = ${contactsInstallation.id}
            and ${schema.moduleRecords.collection_key} = ${collectionKey}
            and ${schema.moduleRecords.is_deleted} = false
            and (
              ${schema.moduleRecords.search_title} = ${title}
              or ${schema.moduleRecords.data}->>'name' = ${title}
              or ${schema.moduleRecords.data}->>'subject' = ${title}
            )`)
          .limit(1);
        if (duplicate) return { id: duplicate.id, inserted: false };

        const shape = shapeFor(collectionKey);
        const base = shape?.data && typeof shape.data === 'object' && !Array.isArray(shape.data)
          ? shape.data as Record<string, unknown>
          : {};
        const data: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(base)) {
          if (!relationFields.has(key)) data[key] = value;
        }
        for (const [key, value] of Object.entries(values)) {
          if (value !== undefined) data[key] = value;
        }
        const searchText = Object.values(data).filter((value) => typeof value === 'string').join(' ');
        const [inserted] = await db.insert(schema.moduleRecords).values({
          org_id: ORG_ID,
          installation_id: contactsInstallation.id,
          collection_key: collectionKey,
          validated_version_id: shape?.validatedVersionId ?? activeVersion.id,
          data,
          revision: shape?.revision ?? 1,
          search_title: title,
          search_subtitle: subtitle,
          search_text: searchText,
          created_by_actor_type: shape?.createdByActorType ?? 'user',
          created_by_actor_id: shape?.createdByActorId ?? MANEEK,
          updated_by_actor_type: shape?.updatedByActorType ?? 'user',
          updated_by_actor_id: shape?.updatedByActorId ?? MANEEK,
          created_at: createdAt,
          updated_at: now,
        }).returning({ id: schema.moduleRecords.id });
        bump('module_records');
        return { id: inserted!.id, inserted: true };
      };

      const linkCrmRecords = async (
        sourceRecordId: string,
        fieldKey: string,
        targetRecordId: string,
        position = 0,
      ): Promise<void> => {
        const inserted = await db.insert(schema.moduleRecordRelations).values({
          org_id: ORG_ID,
          installation_id: contactsInstallation.id,
          field_key: fieldKey,
          source_record_id: sourceRecordId,
          target_record_id: targetRecordId,
          position,
          created_by_actor_type: 'user',
          created_by_actor_id: MANEEK,
          updated_by_actor_type: 'user',
          updated_by_actor_id: MANEEK,
        }).onConflictDoNothing().returning({ id: schema.moduleRecordRelations.id });
        bump('module_record_relations', inserted.length);
      };

      // Companies are owned by the existing module data. Keep them untouched;
      // only create the standard twelve if the collection is completely empty.
      const companyNames = [
        'Lakeview Physio', 'Brightside Dental', 'Harbor Family Clinic',
        'Northside Pediatrics', 'Cedar Grove Clinics', 'Willow Dental Group',
        'Eastside Family Medicine', 'Sunrise Physio', 'Meridian Health Partners',
        'ClinicOps Collective', 'Northline Ventures', 'Riverbend Dental',
      ];
      const companyKey = (name: string) => name.trim().toLowerCase();
      const companyIds = new Map<string, string>();
      const companyIdsById = new Set<string>();
      for (const record of byCollection.get('companies') ?? []) {
        const name = typeof record.data.name === 'string' ? record.data.name : '';
        if (!name) continue;
        companyIds.set(companyKey(name), record.id);
        companyIdsById.add(record.id);
      }
      if (companyIds.size === 0) {
        for (const name of companyNames) {
          const created = await insertCrmRecord(
            'companies',
            { name, industry: 'Healthcare', status: 'prospect', owner: MANEEK, tags: [], notes: 'Clinic group in the Northstar pipeline.' },
            name,
            'Healthcare',
            atIST(-14, 11, 0),
          );
          companyIds.set(companyKey(name), created.id);
          companyIdsById.add(created.id);
          console.log(`[contacts] created company "${name}" (collection was empty)`);
        }
      }
      console.log(`[contacts] keeping ${companyIds.size} companies`);

      // Copy the company-link mechanism from an existing contact: if a relation
      // edge already points at a company, use that field key; otherwise the
      // module's declared `company_id` relation.
      let companyRelationField = 'company_id';
      const existingContact = byCollection.get('contacts')?.[0];
      if (existingContact) {
        const edges = await db
          .select({ fieldKey: schema.moduleRecordRelations.field_key, targetRecordId: schema.moduleRecordRelations.target_record_id })
          .from(schema.moduleRecordRelations)
          .where(sql`${schema.moduleRecordRelations.org_id} = ${ORG_ID}
            and ${schema.moduleRecordRelations.installation_id} = ${contactsInstallation.id}
            and ${schema.moduleRecordRelations.source_record_id} = ${existingContact.id}
            and ${schema.moduleRecordRelations.is_deleted} = false`);
        const companyEdge = edges.find((edge) => companyIdsById.has(edge.targetRecordId));
        if (companyEdge) companyRelationField = companyEdge.fieldKey;
      }

      const contactDefs: Array<{ name: string; role: string; company: string; email: string; phone: string; notes: string }> = [
        { name: 'Dana Whitfield', role: 'Practice Manager', company: 'Lakeview Physio', email: 'dana@lakeviewphysio.example', phone: '+91 80 4000 1101', notes: 'Pilot clinic. Two locations. Primary contact for scheduling.' },
        { name: 'Marcus Bell', role: 'Owner', company: 'Brightside Dental', email: 'marcus@brightsidedental.example', phone: '+91 80 4000 1102', notes: 'Pilot clinic. Four locations. Strongest reference.' },
        { name: 'Ishaan Rao', role: 'Operations Lead', company: 'Harbor Family Clinic', email: 'ishaan@harborfamily.example', phone: '+91 80 4000 1103', notes: 'Onboarding this week. 2,300 appointments to import.' },
        { name: 'Dr. Anita Menon', role: 'Owner', company: 'Northside Pediatrics', email: 'anita@northsidepeds.example', phone: '+91 80 4000 1104', notes: 'Verbal yes for a January pilot. Wait for February capacity.' },
        { name: 'Rahul Iyer', role: 'Managing Partner', company: 'Cedar Grove Clinics', email: 'rahul@cedargrove.example', phone: '+91 80 4000 1105', notes: 'Six locations. Demo scheduled. Asked about per-location pricing.' },
        { name: 'Sofia Marchetti', role: 'Operations Director', company: 'Willow Dental Group', email: 'sofia@willowdental.example', phone: '+91 80 4000 1106', notes: '12 locations. Security review first, pricing second.' },
        { name: 'Ben Okafor', role: 'Practice Manager', company: 'Eastside Family Medicine', email: 'ben@eastsidefamily.example', phone: '+91 80 4000 1107', notes: 'Currently on spreadsheets. Wants reminders more than reporting.' },
        { name: 'Kavya Nair', role: 'Clinic Director', company: 'Sunrise Physio', email: 'kavya@sunrisephysio.example', phone: '+91 80 4000 1108', notes: 'Three locations. Evaluating two vendors, decision in Q1.' },
        { name: 'Tom Alvarez', role: 'Partner', company: 'Meridian Health Partners', email: 'tom@meridianhp.example', phone: '+91 80 4000 1109', notes: 'Referral partner. Introduced Brightside and Northside.' },
        { name: 'Elena Farrow', role: 'Partner', company: 'Northline Ventures', email: 'elena@northlinevc.example', phone: '+91 80 4000 1111', notes: 'Investor contact. Monthly update recipient. Interested in clinic retention data.' },
      ];

      const contactIds = new Map<string, string>();
      for (const contact of contactDefs) {
        const subtitle = [contact.role, contact.company].filter(Boolean).join(' · ');
        const created = await insertCrmRecord(
          'contacts',
          {
            name: contact.name,
            role: contact.role,
            company: contact.company,
            email: contact.email,
            phone: contact.phone,
            status: 'active',
            owner: MANEEK,
            tags: ['pilot'],
            notes: contact.notes,
          },
          contact.name,
          subtitle || null,
          atIST(-12, 14, 0),
        );
        contactIds.set(contact.name, created.id);
        const companyId = companyIds.get(companyKey(contact.company));
        if (companyId) await linkCrmRecords(created.id, companyRelationField, companyId);
      }
      console.log(`[contacts] seeded ${contactDefs.length} people`);

      const dealDefs: Array<{ name: string; company: string; contact: string; value: number; stage: string; closeDay: number; notes: string }> = [
        { name: 'Lakeview Physio - Annual Solo', company: 'Lakeview Physio', contact: 'Dana Whitfield', value: 49, stage: 'won', closeDay: -1, notes: 'Annual Solo plan at $49 per clinic per month. One location renewed after the incident fix.' },
        { name: 'Brightside Dental - Clinic expansion', company: 'Brightside Dental', contact: 'Marcus Bell', value: 149, stage: 'negotiation', closeDay: 5, notes: 'Clinic plan at $149 per clinic per month. Two locations, annual start after launch.' },
        { name: 'Willow Dental Group - Multi-site custom', company: 'Willow Dental Group', contact: 'Sofia Marchetti', value: 1200, stage: 'proposal', closeDay: 14, notes: 'Custom multi-site tier for 12 locations. Security review before commercial terms.' },
        { name: 'Northside Pediatrics - January pilot', company: 'Northside Pediatrics', contact: 'Dr. Anita Menon', value: 49, stage: 'qualified', closeDay: 20, notes: 'Solo tier at $49. January pilot, February onboarding capacity.' },
      ];
      const dealIds = new Map<string, string>();
      for (const deal of dealDefs) {
        const subtitle = [deal.stage, `$${deal.value}`].join(' · ');
        const created = await insertCrmRecord(
          'deals',
          {
            name: deal.name,
            value: deal.value,
            currency: 'usd',
            stage: deal.stage,
            close_date: istDateStamp(atIST(deal.closeDay, 12, 0)),
            owner: MANEEK,
            tags: ['pricing'],
            notes: deal.notes,
          },
          deal.name,
          subtitle,
          atIST(-9, 16, 0),
        );
        dealIds.set(deal.name, created.id);
        const companyId = companyIds.get(companyKey(deal.company));
        if (companyId) await linkCrmRecords(created.id, 'company_id', companyId);
        const contactId = contactIds.get(deal.contact);
        if (contactId) await linkCrmRecords(created.id, 'primary_contact_id', contactId);
      }
      console.log(`[contacts] seeded ${dealDefs.length} deals`);

      const activityDefs: Array<{ subject: string; kind: string; outcome: string; day: number; hour: number; contact: string; company: string; deal: string; notes: string }> = [
        { subject: 'Call with Dana Whitfield - Lakeview recovery check-in', kind: 'call', outcome: 'completed', day: -13, hour: 11, contact: 'Dana Whitfield', company: 'Lakeview Physio', deal: 'Lakeview Physio - Annual Solo', notes: 'Booking volume back to normal. Dana accepted the credit and asked for the same-day view.' },
        { subject: 'Email to Marcus Bell - Brightside renewal pack', kind: 'email', outcome: 'completed', day: -11, hour: 15, contact: 'Marcus Bell', company: 'Brightside Dental', deal: 'Brightside Dental - Clinic expansion', notes: 'Sent adoption numbers and the annual Clinic proposal. Marcus is discussing with his partner.' },
        { subject: 'Meeting with Ishaan Rao - Harbor import review', kind: 'meeting', outcome: 'completed', day: -9, hour: 10, contact: 'Ishaan Rao', company: 'Harbor Family Clinic', deal: 'Northside Pediatrics - January pilot', notes: 'Reconciled 2,300 appointments in staging. 47 provider names still need mapping.' },
        { subject: 'Call with Sofia Marchetti - Willow security review', kind: 'call', outcome: 'completed', day: -6, hour: 14, contact: 'Sofia Marchetti', company: 'Willow Dental Group', deal: 'Willow Dental Group - Multi-site custom', notes: 'Security questionnaire is the gate. Pricing follows once SSO answers are ready.' },
        { subject: 'Email to Dr. Anita Menon - Northside January capacity', kind: 'email', outcome: 'completed', day: -4, hour: 9, contact: 'Dr. Anita Menon', company: 'Northside Pediatrics', deal: 'Northside Pediatrics - January pilot', notes: 'Confirmed February onboarding capacity rather than overpromising January.' },
        { subject: 'Meeting with Tom Alvarez - partner referral review', kind: 'meeting', outcome: 'planned', day: -2, hour: 16, contact: 'Tom Alvarez', company: 'Meridian Health Partners', deal: 'Brightside Dental - Clinic expansion', notes: 'Review the two referrals Tom introduced and agree the co-marketing next step.' },
      ];
      for (const activity of activityDefs) {
        const occurredAt = atIST(activity.day, activity.hour, 0);
        const created = await insertCrmRecord(
          'activities',
          {
            subject: activity.subject,
            kind: activity.kind,
            outcome: activity.outcome,
            occurred_at: occurredAt.toISOString(),
            owner: MANEEK,
            notes: activity.notes,
          },
          activity.subject,
          [activity.kind, activity.outcome].join(' · '),
          occurredAt,
        );
        const contactId = contactIds.get(activity.contact);
        if (contactId) await linkCrmRecords(created.id, 'contact_id', contactId);
        const companyId = companyIds.get(companyKey(activity.company));
        if (companyId) await linkCrmRecords(created.id, 'company_id', companyId);
        const dealId = dealIds.get(activity.deal);
        if (dealId) await linkCrmRecords(created.id, 'deal_id', dealId);
      }
      console.log(`[contacts] seeded ${activityDefs.length} activities`);
    }
  }

  // ── Maneek's attention surface: notifications + reminders ─────────────────
  const gonogoMessage = messageIds.get('l-gonogo');
  if (!gonogoMessage) throw new Error('missing l-gonogo message for the attention plan');

  const taskIdentifier = new Map<string, string>();
  for (const project of projectDefs) {
    project.tasks.forEach((task, index) => {
      taskIdentifier.set(`${project.key}:${task.key}`, `${project.prefix}-${index + 1}`);
    });
  }
  const taskLink = (key: string): string => {
    const id = taskIds.get(key);
    if (!id) throw new Error(`missing task ${key} in the attention plan`);
    return `/tasks?task=${id}`;
  };
  const taskRef = (key: string): string => {
    const label = taskIdentifier.get(key);
    if (!label) throw new Error(`missing task ${key} in the attention plan`);
    return label;
  };

  type AttentionNotification = {
    type: 'mention' | 'task_assigned' | 'task_updated' | 'agent_suggestion' | 'reminder' | 'task';
    title: string;
    body: string;
    link: string;
    is_read: boolean;
    minutesAgo: number;
    metadata: Record<string, unknown>;
  };

  const notificationPlan: AttentionNotification[] = [
    {
      type: 'mention',
      title: 'Maya mentioned you in #launch-v2',
      body: 'Go/no-go is Monday and the call is yours. Criteria: all sev-1 closed, onboarding wizard through QA, pricing page live, SMS registration approved.',
      link: `/chat?space=${gonogoMessage.spaceId}&message=${gonogoMessage.id}`,
      is_read: false,
      minutesAgo: 45,
      metadata: { seed: SEED_MARKER, actor_id: MAYA, space_id: gonogoMessage.spaceId, message_id: gonogoMessage.id, source: 'mention' },
    },
    {
      type: 'task_assigned',
      title: `Maya assigned you ${taskRef('v2:checklist')} · Launch checklist sign-off`,
      body: '34 items. All sev-1 closed, onboarding wizard through QA, pricing page live, and SMS registration approved before Monday go/no-go. Due today at 17:00 IST.',
      link: taskLink('v2:checklist'),
      is_read: false,
      minutesAgo: 135,
      metadata: { seed: SEED_MARKER, actor_id: MAYA, task_id: taskIds.get('v2:checklist'), source: 'task_assigned' },
    },
    {
      type: 'agent_suggestion',
      title: 'Defty drafted the Monday go/no-go checklist',
      body: 'Eight items compiled from #launch-v2 and #engineering. Approve to post it in #launch-v2 at 09:00 IST on Monday, or edit it first.',
      link: `/chat?space=${gonogoMessage.spaceId}&message=${gonogoMessage.id}`,
      is_read: false,
      minutesAgo: 180,
      metadata: { seed: SEED_MARKER, actor_id: DEFTY, space_id: gonogoMessage.spaceId, message_id: gonogoMessage.id, source: 'agent_suggestion' },
    },
    {
      type: 'task_updated',
      title: `Leo moved ${taskRef('pilot:brightside-sms')} to In review`,
      body: 'Brightside Dental: SMS reminders not sending. Exponential backoff, retry queue, and a visible failure count for the clinic admin are in review.',
      link: taskLink('pilot:brightside-sms'),
      is_read: true,
      minutesAgo: 300,
      metadata: { seed: SEED_MARKER, actor_id: LEO, task_id: taskIds.get('pilot:brightside-sms'), source: 'task_updated' },
    },
    {
      type: 'reminder',
      title: 'Reminder: investor data room due Thursday',
      body: 'Metrics and cohort table due Thursday 12:00 IST. Elena asked for the retention assumptions with footnotes, not a summary slide.',
      link: taskLink('v2:data-room'),
      is_read: true,
      minutesAgo: 26 * 60,
      metadata: { seed: SEED_MARKER, task_id: taskIds.get('v2:data-room'), source: 'reminder' },
    },
    {
      type: 'task',
      title: `Due today: ${taskRef('v2:metrics-snapshot')} · Weekly metrics snapshot for investors`,
      body: 'Pilots, providers, appointments booked, weighted pipeline, burn. One page, sent Friday afternoon so the numbers do not drift in the retelling.',
      link: taskLink('v2:metrics-snapshot'),
      is_read: true,
      minutesAgo: 30 * 60,
      metadata: { seed: SEED_MARKER, task_id: taskIds.get('v2:metrics-snapshot'), source: 'due_soon' },
    },
  ];

  for (const entry of notificationPlan) {
    if (!entry.link) throw new Error(`notification "${entry.title}" has no link`);
    const metadata = entry.metadata as Record<string, unknown>;
    if (!metadata.task_id && !metadata.message_id && !metadata.space_id) {
      throw new Error(`notification "${entry.title}" is not linked to a seeded entity`);
    }
    const createdAt = new Date(now.getTime() - entry.minutesAgo * MINUTE);
    await db.insert(schema.notifications).values({
      org_id: ORG_ID,
      user_id: MANEEK,
      type: entry.type,
      title: entry.title,
      body: entry.body,
      link: entry.link,
      is_read: entry.is_read,
      metadata: entry.metadata,
      created_at: createdAt,
      updated_at: createdAt,
    });
    bump('notifications');
  }
  const unreadCount = notificationPlan.filter((entry) => !entry.is_read).length;
  console.log(`[seed] created ${notificationPlan.length} notifications (${unreadCount} unread)`);

  const reminderDays = workingDaysAhead(2);
  const reminderPlan: Array<{ message: string; remindAt: Date; sourceMessageId: string | null }> = [
    { message: 'Sign off the launch checklist before the Monday go/no-go', remindAt: atIST(reminderDays[0]!, 9, 0), sourceMessageId: gonogoMessage.id },
    { message: 'Send the investor metrics snapshot to Elena at Northline', remindAt: atIST(reminderDays[1]!, 16, 0), sourceMessageId: null },
  ];
  for (const reminder of reminderPlan) {
    await db.insert(schema.reminders).values({
      org_id: ORG_ID,
      user_id: MANEEK,
      message: reminder.message,
      remind_at: reminder.remindAt,
      source_message_id: reminder.sourceMessageId,
      is_sent: false,
      created_at: now,
      updated_at: now,
    });
    bump('reminders');
  }
  console.log(`[seed] created ${reminderPlan.length} pending reminders`);

  printCounts(tracker.counts);
  return { status: 'seeded', counts: tracker.counts, cleanup };
}

// ════════════════════════════════════════════════════════════════════════════
// --self-test fixtures
// ════════════════════════════════════════════════════════════════════════════
type SelfTestFixtureInfo = {
  generalSpaceId: string;
  patternTaskTitles: string[];
  patternProjectId: string;
  staleWikiId: string;
  staleNoteId: string;
  staleSpaceId: string;
  staleDmSpaceId: string;
  unreferencedAgentSpaceId: string;
  referencedAgentSpaceId: string;
  crmInstallationId: string | null;
  crmCompanyIds: string[];
  crmSyntheticCompanyId: string | null;
  crmTaggedContactId: string | null;
  crmExistingContactId: string | null;
};

const SELF_TEST_CLEANUP_PATTERNS = [
  'Controlled ',
  'Synthetic ',
  'Deft Email demo evidence',
  'Developer Preview Acceptance',
  'Email Sideload',
  'Release triage',
  'Release pilot',
  'Sol 5.6',
  'acceptance',
  'REL26',
  'LIVE26',
  '[REL',
];

async function ensureSelfTestFixtures(db: Db): Promise<SelfTestFixtureInfo> {
  const stamp = Math.random().toString(36).slice(2, 8);
  await resolveDeftyIdentity(db);

  const [org] = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.id, ORG_ID));
  if (!org) {
    const slugTaken = await db.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.slug, 'northstar-labs'));
    await db.insert(schema.orgs).values({
      id: ORG_ID,
      name: 'Northstar Labs (fixture)',
      slug: slugTaken.length > 0 ? `northstar-labs-fixture-${stamp}` : 'northstar-labs',
      timezone: 'Asia/Kolkata',
      trust_level: 'standard',
    });
  }

  const people: Array<[string, string, boolean]> = [
    [MANEEK, 'Maneek Mohan', false],
    [MAYA, 'Maya Rao', false],
    [LEO, 'Leo Park', false],
    [AMINA, 'Amina Shah', false],
    [NOAH, 'Noah Chen', false],
    [PRIYA, 'Priya Das', false],
    [DEFTY, 'Defty', true],
    [SCOUT_USER, 'Hermes', true],
  ];
  for (const [id, name, isAgent] of people) {
    const [found] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id));
    if (found) continue;
    await db.insert(schema.users).values({
      id,
      name,
      email: id === DEFTY ? 'deft-agent@system.local' : `demo.${id.slice(0, 8)}.${stamp}@northstar.test`,
      kind: isAgent ? 'agent' : 'human',
      is_agent: isAgent,
      email_verified: true,
      title: null,
    }).onConflictDoNothing();
  }

  const members: Array<[string, 'owner' | 'admin' | 'member']> = [
    [MANEEK, 'owner'],
    [MAYA, 'admin'],
    [LEO, 'member'],
    [AMINA, 'member'],
    [NOAH, 'member'],
    [DEFTY, 'member'],
  ];
  for (const [userId, role] of members) {
    await db.insert(schema.orgMembers).values({ org_id: ORG_ID, user_id: userId, role }).onConflictDoNothing();
  }

  const [scout] = await db
    .select({ id: schema.agentEmployees.id })
    .from(schema.agentEmployees)
    .where(sql`${schema.agentEmployees.org_id} = ${ORG_ID} and ${schema.agentEmployees.slug} = ${SCOUT_SLUG}`);
  if (!scout) {
    await db.insert(schema.agentEmployees).values({
      org_id: ORG_ID,
      user_id: SCOUT_USER,
      name: 'Hermes',
      slug: SCOUT_SLUG,
      role: 'custom',
      system_prompt: 'Research agent for market and competitor analysis.',
      expertise_description: 'Hermes research runtime',
      created_by: MANEEK,
    });
  }

  // A pre-existing #general that must be reused, not duplicated.
  const [existingGeneral] = await db
    .select({ id: schema.spaces.id })
    .from(schema.spaces)
    .where(sql`${schema.spaces.org_id} = ${ORG_ID}
      and ${schema.spaces.type} = 'public'
      and ${schema.spaces.is_archived} = false
      and lower(regexp_replace(btrim(${schema.spaces.name}), '^#+', '')) = 'general'`)
    .limit(1);
  let generalSpaceId = existingGeneral?.id;
  if (!generalSpaceId) {
    const [inserted] = await db.insert(schema.spaces).values({
      org_id: ORG_ID,
      name: '#general',
      type: 'public',
      is_default: true,
      created_by: MANEEK,
    }).returning({ id: schema.spaces.id });
    generalSpaceId = inserted!.id;
  }

  // One matched task plus a matched project for every cleanup pattern.
  const patternProjectName = 'Release triage fixture project';
  const [existingPatternProject] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(sql`${schema.projects.org_id} = ${ORG_ID} and ${schema.projects.name} = ${patternProjectName}`);
  let patternProjectId = existingPatternProject?.id;
  if (!patternProjectId) {
    const [inserted] = await db.insert(schema.projects).values({
      org_id: ORG_ID,
      name: patternProjectName,
      description: 'Self-test cleanup fixture.',
      prefix: `FIX${stamp.slice(0, 3).toUpperCase()}`,
      lead_id: MANEEK,
      task_counter: SELF_TEST_CLEANUP_PATTERNS.length,
      created_at: atIST(-2, 9, 0),
      updated_at: new Date(),
    }).returning({ id: schema.projects.id });
    patternProjectId = inserted!.id;
  }

  const patternTaskTitles: string[] = [];
  for (const [index, pattern] of SELF_TEST_CLEANUP_PATTERNS.entries()) {
    const title = `${pattern}${pattern.endsWith(' ') ? '' : ' '}self-test fixture ${index + 1}`;
    patternTaskTitles.push(title);
    const [existing] = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(sql`${schema.tasks.org_id} = ${ORG_ID} and ${schema.tasks.title} = ${title}`);
    if (existing) continue;
    await db.insert(schema.tasks).values({
      org_id: ORG_ID,
      project_id: patternProjectId,
      number: index + 1,
      title,
      description: 'Planted by the self-test to prove the cleanup pattern matches.',
      status: 'backlog',
      priority: 'p3',
      assignee_id: null,
      created_by: MANEEK,
      created_at: atIST(-2, 10, 0),
      updated_at: atIST(-2, 10, 0),
    });
  }

  // Matched wiki page and note.
  const staleWikiTitle = 'REL261018 release checklist';
  const [staleWiki] = await db
    .select({ id: schema.wikiPages.id })
    .from(schema.wikiPages)
    .where(sql`${schema.wikiPages.org_id} = ${ORG_ID} and ${schema.wikiPages.title} = ${staleWikiTitle}`);
  let staleWikiId = staleWiki?.id;
  if (!staleWikiId) {
    const [inserted] = await db.insert(schema.wikiPages).values({
      org_id: ORG_ID,
      type: 'procedure',
      title: staleWikiTitle,
      slug: `rel261018-release-checklist-${stamp}`,
      content: 'Stale release checklist planted by the self-test.',
      summary: 'Self-test cleanup candidate',
      user_id: MAYA,
    }).returning({ id: schema.wikiPages.id });
    staleWikiId = inserted!.id;
  }

  const staleNoteTitle = 'REL26 self-test note';
  const [staleNote] = await db
    .select({ id: schema.notes.id })
    .from(schema.notes)
    .where(sql`${schema.notes.org_id} = ${ORG_ID} and ${schema.notes.title} = ${staleNoteTitle}`);
  let staleNoteId = staleNote?.id;
  if (!staleNoteId) {
    const [inserted] = await db.insert(schema.notes).values({
      org_id: ORG_ID,
      user_id: MANEEK,
      title: staleNoteTitle,
      content: 'Stale note planted by the self-test.',
      visibility: 'private',
      version: 1,
    }).returning({ id: schema.notes.id });
    staleNoteId = inserted!.id;
  }

  // Matched public space (with a message, proving soft-delete rather than a
  // hard delete), plus a matched DM.
  const [staleSpace] = await db
    .select({ id: schema.spaces.id })
    .from(schema.spaces)
    .where(sql`${schema.spaces.org_id} = ${ORG_ID} and ${schema.spaces.name} = 'LIVE26 demo room'`);
  let staleSpaceId = staleSpace?.id;
  if (!staleSpaceId) {
    const [inserted] = await db.insert(schema.spaces).values({
      org_id: ORG_ID,
      name: 'LIVE26 demo room',
      type: 'public',
      created_by: MANEEK,
    }).returning({ id: schema.spaces.id });
    staleSpaceId = inserted!.id;
    await db.insert(schema.messages).values({
      org_id: ORG_ID,
      space_id: staleSpaceId,
      user_id: MAYA,
      content: 'Old live-demo notes that must be soft-deleted, never hard-deleted.',
      metadata: { seed: 'self-test-fixture' },
    });
  }

  const [staleDm] = await db
    .select({ id: schema.spaces.id })
    .from(schema.spaces)
    .where(sql`${schema.spaces.org_id} = ${ORG_ID} and ${schema.spaces.name} = 'Synthetic dm fixture'`);
  let staleDmSpaceId = staleDm?.id;
  if (!staleDmSpaceId) {
    const [inserted] = await db.insert(schema.spaces).values({
      org_id: ORG_ID,
      name: 'Synthetic dm fixture',
      type: 'dm',
      created_by: MANEEK,
    }).returning({ id: schema.spaces.id });
    staleDmSpaceId = inserted!.id;
    await db.insert(schema.spaceMembers).values([
      { space_id: staleDmSpaceId, user_id: MANEEK },
      { space_id: staleDmSpaceId, user_id: MAYA },
    ]).onConflictDoNothing();
  }

  // Unreferenced agent_conversation -> matched, so it must be soft-deleted.
  const [unreferenced] = await db
    .select({ id: schema.spaces.id })
    .from(schema.spaces)
    .where(sql`${schema.spaces.org_id} = ${ORG_ID} and ${schema.spaces.name} = 'Email acceptance - Defty'`);
  let unreferencedAgentSpaceId = unreferenced?.id;
  if (!unreferencedAgentSpaceId) {
    const [inserted] = await db.insert(schema.spaces).values({
      org_id: ORG_ID,
      name: 'Email acceptance - Defty',
      type: 'agent_conversation',
      created_by: DEFTY,
    }).returning({ id: schema.spaces.id });
    unreferencedAgentSpaceId = inserted!.id;
    await db.insert(schema.messages).values({
      org_id: ORG_ID,
      space_id: unreferencedAgentSpaceId,
      user_id: DEFTY,
      content: 'Unreferenced agent conversation that the cleanup should soft-delete.',
      metadata: { seed: 'self-test-fixture' },
    });
  }

  // Referenced agent_conversation -> matched name, but an app_private_defty_seals
  // row points at it, so it survives and is renamed to "Defty".
  const [referenced] = await db
    .select({ id: schema.spaces.id })
    .from(schema.spaces)
    .where(sql`${schema.spaces.org_id} = ${ORG_ID} and ${schema.spaces.name} = 'Deft Email demo evidence - Defty'`);
  let referencedAgentSpaceId = referenced?.id;
  if (!referencedAgentSpaceId) {
    const [inserted] = await db.insert(schema.spaces).values({
      org_id: ORG_ID,
      name: 'Deft Email demo evidence - Defty',
      type: 'agent_conversation',
      created_by: DEFTY,
    }).returning({ id: schema.spaces.id });
    referencedAgentSpaceId = inserted!.id;
  }
  await db.insert(schema.appPrivateDeftySeals).values({
    org_id: ORG_ID,
    space_id: referencedAgentSpaceId,
    owner_user_id: MANEEK,
    defty_user_id: DEFTY,
  }).onConflictDoNothing();

  // Contacts module fixture: twelve companies, one existing contact with a
  // company relation, plus one name-matched and one tag-matched CRM record.
  let crmInstallationId: string | null = null;
  const crmCompanyIds: string[] = [];
  let crmSyntheticCompanyId: string | null = null;
  let crmTaggedContactId: string | null = null;
  let crmExistingContactId: string | null = null;
  const [existingInstallation] = await db
    .select({ id: schema.moduleInstallations.id })
    .from(schema.moduleInstallations)
    .where(sql`${schema.moduleInstallations.org_id} = ${ORG_ID}
      and ${schema.moduleInstallations.module_id} = 'com.deft.contacts'`)
    .limit(1);
  if (existingInstallation) {
    crmInstallationId = existingInstallation.id;
  } else {
    const [inserted] = await db.insert(schema.moduleInstallations).values({
      org_id: ORG_ID,
      module_id: 'com.deft.contacts',
      slug: 'contacts',
      source: 'bundled',
      is_enabled: true,
      agent_access: 'none',
      installed_by_user_id: MANEEK,
      installed_by_actor_type: 'user',
      installed_by_actor_id: MANEEK,
      updated_by_actor_type: 'user',
      updated_by_actor_id: MANEEK,
    }).returning({ id: schema.moduleInstallations.id });
    crmInstallationId = inserted!.id;
  }

  let crmVersionId: string | null = null;
  const [existingVersion] = await db
    .select({ id: schema.moduleVersions.id })
    .from(schema.moduleVersions)
    .where(sql`${schema.moduleVersions.org_id} = ${ORG_ID}
      and ${schema.moduleVersions.installation_id} = ${crmInstallationId}
      and ${schema.moduleVersions.is_active} = true`)
    .limit(1);
  if (existingVersion) {
    crmVersionId = existingVersion.id;
  } else {
    const manifest = {
      id: 'com.deft.contacts',
      name: 'Contacts',
      version: '1.8.0',
      schema_version: '1',
      collections: ['contacts', 'companies', 'deals', 'activities', 'outreach'].map((key) => ({ key })),
    };
    const manifestDigest = `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
    const [inserted] = await db.insert(schema.moduleVersions).values({
      org_id: ORG_ID,
      installation_id: crmInstallationId,
      version: '1.8.0',
      manifest,
      manifest_digest: manifestDigest,
      is_active: true,
      activated_at: new Date(),
      created_by_actor_type: 'user',
      created_by_actor_id: MANEEK,
    }).returning({ id: schema.moduleVersions.id });
    crmVersionId = inserted!.id;
  }

  const insertCrmFixture = async (
    collectionKey: string,
    data: Record<string, unknown>,
    title: string,
    subtitle: string | null,
  ): Promise<string> => {
    const searchText = Object.values(data).filter((value) => typeof value === 'string').join(' ');
    const [inserted] = await db.insert(schema.moduleRecords).values({
      org_id: ORG_ID,
      installation_id: crmInstallationId!,
      collection_key: collectionKey,
      validated_version_id: crmVersionId!,
      data,
      revision: 1,
      search_title: title,
      search_subtitle: subtitle,
      search_text: searchText,
      created_by_actor_type: 'user',
      created_by_actor_id: MANEEK,
      updated_by_actor_type: 'user',
      updated_by_actor_id: MANEEK,
    }).returning({ id: schema.moduleRecords.id });
    return inserted!.id;
  };

  const companyNames = [
    'Lakeview Physio', 'Brightside Dental', 'Harbor Family Clinic',
    'Northside Pediatrics', 'Cedar Grove Clinics', 'Willow Dental Group',
    'Eastside Family Medicine', 'Sunrise Physio', 'Meridian Health Partners',
    'ClinicOps Collective', 'Northline Ventures', 'Riverbend Dental',
  ];
  for (const name of companyNames) {
    const [found] = await db
      .select({ id: schema.moduleRecords.id })
      .from(schema.moduleRecords)
      .where(sql`${schema.moduleRecords.org_id} = ${ORG_ID}
        and ${schema.moduleRecords.installation_id} = ${crmInstallationId}
        and ${schema.moduleRecords.collection_key} = 'companies'
        and ${schema.moduleRecords.is_deleted} = false
        and ${schema.moduleRecords.data}->>'name' = ${name}`)
      .limit(1);
    if (found) {
      crmCompanyIds.push(found.id);
      continue;
    }
    const id = await insertCrmFixture(
      'companies',
      { name, industry: 'Healthcare', status: 'customer', owner: MANEEK, tags: [], notes: 'Self-test company.' },
      name,
      'Healthcare',
    );
    crmCompanyIds.push(id);
  }

  const [existingContact] = await db
    .select({ id: schema.moduleRecords.id })
    .from(schema.moduleRecords)
    .where(sql`${schema.moduleRecords.org_id} = ${ORG_ID}
      and ${schema.moduleRecords.installation_id} = ${crmInstallationId}
      and ${schema.moduleRecords.collection_key} = 'contacts'
      and ${schema.moduleRecords.is_deleted} = false
      and ${schema.moduleRecords.search_title} = 'Fixture Existing Contact'`)
    .limit(1);
  if (existingContact) {
    crmExistingContactId = existingContact.id;
  } else {
    crmExistingContactId = await insertCrmFixture(
      'contacts',
      { name: 'Fixture Existing Contact', role: 'Practice Manager', company: 'Lakeview Physio', email: 'fixture@lakeviewphysio.example', status: 'active', owner: MANEEK, tags: [] },
      'Fixture Existing Contact',
      'Practice Manager · Lakeview Physio',
    );
    if (crmCompanyIds[0]) {
      await db.insert(schema.moduleRecordRelations).values({
        org_id: ORG_ID,
        installation_id: crmInstallationId!,
        field_key: 'company_id',
        source_record_id: crmExistingContactId,
        target_record_id: crmCompanyIds[0],
        position: 0,
        created_by_actor_type: 'user',
        created_by_actor_id: MANEEK,
        updated_by_actor_type: 'user',
        updated_by_actor_id: MANEEK,
      }).onConflictDoNothing();
    }
  }

  const [syntheticCompany] = await db
    .select({ id: schema.moduleRecords.id })
    .from(schema.moduleRecords)
    .where(sql`${schema.moduleRecords.org_id} = ${ORG_ID}
      and ${schema.moduleRecords.installation_id} = ${crmInstallationId}
      and ${schema.moduleRecords.collection_key} = 'companies'
      and ${schema.moduleRecords.is_deleted} = false
      and ${schema.moduleRecords.search_title} = 'Synthetic Clinic Fixture'`)
    .limit(1);
  crmSyntheticCompanyId = syntheticCompany?.id ?? await insertCrmFixture(
    'companies',
    { name: 'Synthetic Clinic Fixture', industry: 'Healthcare', status: 'prospect', owner: MANEEK, tags: [] },
    'Synthetic Clinic Fixture',
    'Healthcare',
  );

  const [taggedContact] = await db
    .select({ id: schema.moduleRecords.id })
    .from(schema.moduleRecords)
    .where(sql`${schema.moduleRecords.org_id} = ${ORG_ID}
      and ${schema.moduleRecords.installation_id} = ${crmInstallationId}
      and ${schema.moduleRecords.collection_key} = 'contacts'
      and ${schema.moduleRecords.is_deleted} = false
      and ${schema.moduleRecords.search_title} = 'Fixture Tagged Contact'`)
    .limit(1);
  crmTaggedContactId = taggedContact?.id ?? await insertCrmFixture(
    'contacts',
    { name: 'Fixture Tagged Contact', role: 'Owner', company: 'Brightside Dental', email: 'tagged@brightsidedental.example', status: 'lead', owner: MANEEK, tags: ['REL26'] },
    'Fixture Tagged Contact',
    'Owner · Brightside Dental',
  );

  return {
    generalSpaceId,
    patternTaskTitles,
    patternProjectId,
    staleWikiId,
    staleNoteId,
    staleSpaceId,
    staleDmSpaceId,
    unreferencedAgentSpaceId,
    referencedAgentSpaceId,
    crmInstallationId,
    crmCompanyIds,
    crmSyntheticCompanyId,
    crmTaggedContactId,
    crmExistingContactId,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Self-test integrity checks
// ════════════════════════════════════════════════════════════════════════════
async function scalar(db: Db, query: SQL): Promise<number> {
  const result = await db.execute(query);
  const rows = result.rows as Array<Record<string, unknown>>;
  const first = rows[0];
  const value = first ? Object.values(first)[0] : 0;
  return Number(value ?? 0);
}

/**
 * Runs inside the self-test transaction only. Proves the demo data is
 * timezone-sane (weekday business hours, IST), bounded to the intended window,
 * and that the attention surface has the promised shape.
 */
async function verifyWorkspace(
  db: Db,
  counts: Counts,
  fixtures: SelfTestFixtureInfo,
  cleanup: CleanupResult,
): Promise<void> {
  const checks: Array<{ label: string; expected: string; actual: number }> = [];

  const check = async (label: string, expected: number, query: SQL): Promise<void> => {
    const actual = await scalar(db, query);
    checks.push({ label, expected: String(expected), actual });
    if (actual !== expected) {
      throw new Error(`self-test integrity check failed: ${label} — expected ${expected}, got ${actual}`);
    }
  };

  const checkAtLeast = async (label: string, minimum: number, query: SQL): Promise<void> => {
    const actual = await scalar(db, query);
    checks.push({ label, expected: `>= ${minimum}`, actual });
    if (actual < minimum) {
      throw new Error(`self-test integrity check failed: ${label} — expected at least ${minimum}, got ${actual}`);
    }
  };

  const seededMessages = sql`select count(*) from messages
    where org_id = ${ORG_ID} and metadata->>'seed' = ${SEED_MARKER}`;

  await check('messages carry metadata.seed', counts.messages ?? 0, seededMessages);
  await check('messages on a weekend (IST)', 0, sql`select count(*) from messages
    where org_id = ${ORG_ID} and metadata->>'seed' = ${SEED_MARKER}
      and extract(isodow from (created_at + interval '5 hours 30 minutes')) in (6, 7)`);
  await check('messages outside 09:00-19:00 IST', 0, sql`select count(*) from messages
    where org_id = ${ORG_ID} and metadata->>'seed' = ${SEED_MARKER}
      and (extract(hour from (created_at + interval '5 hours 30 minutes')) < 9
        or extract(hour from (created_at + interval '5 hours 30 minutes')) >= 19)`);
  await check('messages in the future', 0, sql`select count(*) from messages
    where org_id = ${ORG_ID} and metadata->>'seed' = ${SEED_MARKER} and created_at > now()`);
  await check('messages older than 23 days', 0, sql`select count(*) from messages
    where org_id = ${ORG_ID} and metadata->>'seed' = ${SEED_MARKER}
      and created_at < now() - interval '23 days'`);
  await checkAtLeast('messages with a parent (thread replies)', 15, sql`select count(*) from messages
    where org_id = ${ORG_ID} and metadata->>'seed' = ${SEED_MARKER} and parent_id is not null`);
  await checkAtLeast('threads with replies', 8, sql`select count(distinct parent_id) from messages
    where org_id = ${ORG_ID} and metadata->>'seed' = ${SEED_MARKER} and parent_id is not null`);

  await check('Maneek notifications', counts.notifications ?? 0, sql`select count(*) from notifications
    where org_id = ${ORG_ID} and user_id = ${MANEEK}`);
  await check('Maneek unread notifications', 3, sql`select count(*) from notifications
    where org_id = ${ORG_ID} and user_id = ${MANEEK} and is_read = false`);
  await check('pending reminders', counts.reminders ?? 0, sql`select count(*) from reminders
    where org_id = ${ORG_ID} and user_id = ${MANEEK} and is_sent = false`);
  await check('reminders already past due', 0, sql`select count(*) from reminders
    where org_id = ${ORG_ID} and user_id = ${MANEEK} and remind_at <= now()`);

  await check('tasks', counts.tasks ?? 0, sql`select count(*) from tasks
    where org_id = ${ORG_ID} and is_deleted = false`);
  await check('tasks due beyond 15 days', 0, sql`select count(*) from tasks
    where org_id = ${ORG_ID} and due_date > now() + interval '15 days'`);
  await check('tasks created before the window', 0, sql`select count(*) from tasks
    where org_id = ${ORG_ID} and created_at < now() - interval '23 days'`);

  await check('calendar events', counts.events ?? 0, sql`select count(*) from events
    where org_id = ${ORG_ID} and external_id like 'investor-%'`);
  await check('calendar events outside the window', 0, sql`select count(*) from events
    where org_id = ${ORG_ID} and external_id like 'investor-%'
      and (timestamp < now() - interval '23 days' or timestamp > now() + interval '15 days')`);

  // ── Cleanup proof: matched rows survive as soft-deleted, not hard-deleted ──
  const fixtureTitleList = sql.join(
    fixtures.patternTaskTitles.map((title) => sql`${title}`),
    sql`, `,
  );
  await check('cleanup fixture tasks still present and soft-deleted', fixtures.patternTaskTitles.length, sql`select count(*) from tasks
    where org_id = ${ORG_ID} and is_deleted = true
      and title in (${fixtureTitleList})`);
  await check('cleanup fixture tasks still active', 0, sql`select count(*) from tasks
    where org_id = ${ORG_ID} and is_deleted = false
      and title in (${fixtureTitleList})`);
  await check('cleanup fixture project soft-deleted', 1, sql`select count(*) from projects
    where org_id = ${ORG_ID} and id = ${fixtures.patternProjectId} and is_deleted = true`);
  await check('cleanup fixture wiki page soft-deleted', 1, sql`select count(*) from wiki_pages
    where org_id = ${ORG_ID} and id = ${fixtures.staleWikiId} and is_deleted = true`);
  await check('cleanup fixture note soft-deleted', 1, sql`select count(*) from notes
    where org_id = ${ORG_ID} and id = ${fixtures.staleNoteId} and is_deleted = true`);
  await check('cleanup fixture public space soft-deleted', 1, sql`select count(*) from spaces
    where org_id = ${ORG_ID} and id = ${fixtures.staleSpaceId} and is_archived = true`);
  await check('cleanup fixture dm soft-deleted', 1, sql`select count(*) from spaces
    where org_id = ${ORG_ID} and id = ${fixtures.staleDmSpaceId} and is_archived = true`);
  await check('unreferenced agent conversation soft-deleted', 1, sql`select count(*) from spaces
    where org_id = ${ORG_ID} and id = ${fixtures.unreferencedAgentSpaceId} and is_archived = true`);
  await check('referenced agent conversation survived', 1, sql`select count(*) from spaces
    where org_id = ${ORG_ID} and id = ${fixtures.referencedAgentSpaceId} and is_archived = false`);
  await check('referenced agent conversation renamed to Defty', 1, sql`select count(*) from spaces
    where org_id = ${ORG_ID} and id = ${fixtures.referencedAgentSpaceId} and name = 'Defty'`);
  await checkAtLeast('cleanup soft-deleted rows', SELF_TEST_CLEANUP_PATTERNS.length, sql`select ${cleanup.softDeleted}`);

  // ── #general reuse ────────────────────────────────────────────────────────
  await check('public #general spaces', 1, sql`select count(*) from spaces
    where org_id = ${ORG_ID} and type = 'public' and is_archived = false
      and lower(regexp_replace(btrim(name), '^#+', '')) = 'general'`);
  await check('existing #general reused', 1, sql`select count(*) from spaces
    where org_id = ${ORG_ID} and id = ${fixtures.generalSpaceId} and is_archived = false`);
  await checkAtLeast('seeded messages posted into the existing #general', 10, sql`select count(*) from messages
    where org_id = ${ORG_ID} and space_id = ${fixtures.generalSpaceId}
      and metadata->>'seed' = ${SEED_MARKER}`);

  // ── Notifications all point at a seeded entity ────────────────────────────
  await check('notifications with an entity id', counts.notifications ?? 0, sql`select count(*) from notifications
    where org_id = ${ORG_ID} and user_id = ${MANEEK}
      and link is not null
      and (metadata ? 'task_id' or metadata ? 'message_id' or metadata ? 'space_id')`);

  // ── Contacts module ───────────────────────────────────────────────────────
  if (fixtures.crmInstallationId) {
    await check('CRM companies kept', fixtures.crmCompanyIds.length, sql`select count(*) from module_records
      where org_id = ${ORG_ID} and installation_id = ${fixtures.crmInstallationId}
        and collection_key = 'companies' and is_deleted = false`);
    await checkAtLeast('CRM contacts', 11, sql`select count(*) from module_records
      where org_id = ${ORG_ID} and installation_id = ${fixtures.crmInstallationId}
        and collection_key = 'contacts' and is_deleted = false`);
    await checkAtLeast('CRM deals', 4, sql`select count(*) from module_records
      where org_id = ${ORG_ID} and installation_id = ${fixtures.crmInstallationId}
        and collection_key = 'deals' and is_deleted = false`);
    await checkAtLeast('CRM activities', 6, sql`select count(*) from module_records
      where org_id = ${ORG_ID} and installation_id = ${fixtures.crmInstallationId}
        and collection_key = 'activities' and is_deleted = false`);
    await checkAtLeast('CRM relations', 25, sql`select count(*) from module_record_relations
      where org_id = ${ORG_ID} and installation_id = ${fixtures.crmInstallationId} and is_deleted = false`);
    if (fixtures.crmSyntheticCompanyId) {
      await check('name-matched CRM record soft-deleted with revision bump', 1, sql`select count(*) from module_records
        where org_id = ${ORG_ID} and id = ${fixtures.crmSyntheticCompanyId}
          and is_deleted = true and revision > 1 and deleted_at is not null`);
    }
    if (fixtures.crmTaggedContactId) {
      await check('tag-matched CRM record soft-deleted', 1, sql`select count(*) from module_records
        where org_id = ${ORG_ID} and id = ${fixtures.crmTaggedContactId} and is_deleted = true`);
    }
    if (fixtures.crmExistingContactId) {
      await check('existing contact kept', 1, sql`select count(*) from module_records
        where org_id = ${ORG_ID} and id = ${fixtures.crmExistingContactId} and is_deleted = false`);
    }
  }

  console.log('\n[self-test] integrity checks:');
  for (const entry of checks) {
    console.log(`  ✓ ${entry.label}: ${entry.actual} (expected ${entry.expected})`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Entry points
// ════════════════════════════════════════════════════════════════════════════
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Every `timestamp` column in this schema is `timestamp without time zone`, and
 * the web client reads bare timestamps as UTC (`ensureUTC` in apps/web/src/lib/
 * time.ts). When a `Date` is passed to node-postgres it is serialised with the
 * *host* offset and Postgres then drops that offset, which silently bakes the
 * host timezone into the data. Force UTC wall-clock text instead so the demo
 * looks identical whether it was seeded from an IST laptop or a UTC server.
 */
function utcWallClock(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '');
}

function bindUtcTimestamps(client: pg.PoolClient): void {
  const original = client.query.bind(client);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).query = (config: any, params?: unknown[]) => {
    if (Array.isArray(params)) {
      return (original as any)(config, params.map((value) => (value instanceof Date ? utcWallClock(value) : value)));
    }
    return (original as any)(config, params);
  };
}

async function main(): Promise<void> {
  const selfTest = process.argv.includes('--self-test');
  const selfTestUrl = process.env.DEFT_INVESTOR_SEED_LOCAL_URL || 'postgres://deft:deft@127.0.0.1:5432/deft_test';
  const url = selfTest ? selfTestUrl : process.env.DATABASE_URL || '';

  if (!url) {
    throw new Error('DATABASE_URL is required (or DEFT_INVESTOR_SEED_LOCAL_URL with --self-test).');
  }
  if (selfTest && !isLocalUrl(url)) {
    throw new Error(`--self-test refuses non-local database host: ${url}`);
  }

  console.log(`Connecting to ${url.replace(/:\/\/[^@]*@/, '://***@')}`);
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  // Session-local only: keeps now()/timestamptz math aligned with the UTC wall
  // clock written above. Does not touch the database or other connections.
  await client.query("set time zone 'UTC'");
  bindUtcTimestamps(client);
  const db = drizzle(client, { schema });

  try {
    if (selfTest) {
      await client.query('BEGIN');
      try {
        console.log('[self-test] ensuring fixture rows (org, users, agent, #general, cleanup patterns, CRM)…');
        const fixtures = await ensureSelfTestFixtures(db);
        const first = await seedWorkspace(db);
        if (first.status !== 'seeded') {
          throw new Error('self-test expected a fresh seed, but the workspace was already seeded');
        }
        const second = await seedWorkspace(db);
        if (second.status !== 'already seeded') {
          throw new Error('idempotency check failed: second seed run was not a no-op');
        }
        console.log('[self-test] first run counts:');
        printCounts(first.counts);
        if (first.cleanup) {
          console.log('[self-test] cleanup counts:');
          console.log(`  soft-deleted ${first.cleanup.softDeleted}, renamed ${first.cleanup.renamed}`);
          for (const [table, rows] of Object.entries(first.cleanup.byTable).sort((a, b) => a[0].localeCompare(b[0]))) {
            console.log(`  ${table}: ${rows}`);
          }
        }
        console.log('[self-test] second run: no rows written (idempotent)');
        await verifyWorkspace(db, first.counts, fixtures, first.cleanup ?? { softDeleted: 0, renamed: 0, byTable: {} });
        await client.query('ROLLBACK');
        console.log('[self-test] ROLLBACK complete — nothing was persisted');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('[self-test] rolled back; nothing was persisted');
        throw error;
      }
    } else {
      await client.query('BEGIN');
      try {
        const result = await seedWorkspace(db);
        if (result.status === 'already seeded') {
          await client.query('ROLLBACK');
          process.exitCode = 0;
          return;
        }
        await client.query('COMMIT');
        console.log('\n✅ Northstar Labs investor demo seed complete (committed).');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('[seed] rolled back; nothing was persisted');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('\n❌ Investor demo seed failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
