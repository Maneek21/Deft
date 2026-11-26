/**
 * No code changes an event's workspace (events.org_id) after it is written.
 *
 * Why (M2 fix round 1, the controller's I1 ruling): document_event_links
 * names its event by id only, because events has no (org_id, id) key and an
 * add-only upgrade may not add one. A trigger on the link checks the event's
 * workspace when the link is written (the F2 precedent: document_shares and
 * drive_members check their principals the same way). What the trigger can't
 * see is an event moving to another workspace afterwards, so nothing may do
 * that: this test reads every source and SQL file under apps/, packages/ and
 * scripts/ (tests excluded) and fails on
 * - SQL that updates events and sets org_id (UPDATE events SET … org_id =,
 *   or INSERT INTO events … ON CONFLICT … DO UPDATE SET … org_id =);
 * - Drizzle update(events).set(…) or insert(events)….onConflictDoUpdate(…)
 *   whose values name org_id or orgId, written out or through an object the
 *   same file builds (a `const x = { org_id … }` literal, or `x.org_id = …`).
 * The detectors are checked on samples first, so the guard can't pass by
 * matching nothing.
 *
 * Run:
 *   pnpm --filter @deft/api test test/events-org-id-immutable.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../../..');
const SCANNED = ['apps', 'packages', 'scripts'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', 'test', 'tests', '__tests__', 'fixtures', 'e2e']);
const EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|sql)$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) sourceFiles(path, out);
    } else if (EXTENSIONS.test(name) && !TEST_FILE.test(name) && stat.size < 5_000_000) {
      out.push(path);
    }
  }
  return out;
}

/** The text from the bracket at `open` to its match (strings and comments skipped), or null. */
function balanced(text: string, open: number): string | null {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let at = open; at < text.length; at += 1) {
    const ch = text[at]!;
    if (ch === '\'' || ch === '"' || ch === '`') {
      let end = at + 1;
      while (end < text.length && text[end] !== ch) end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return null;
      at = end;
      continue;
    }
    if (ch === '/' && text[at + 1] === '/') { at = text.indexOf('\n', at); if (at < 0) return null; continue; }
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) return text.slice(open, at + 1);
    }
  }
  return null;
}

/** An `org_id` / `orgId` key (not `events.org_id`), written out or as a shorthand property. */
const ORG_KEY = /(?<![\w.$])(?:org_id|orgId)\s*(?::|,|\}|$)/u;

/** True when `values` (an object literal or an identifier) names org_id, following identifiers this file builds. */
function namesOrgId(file: string, values: string): boolean {
  if (ORG_KEY.test(values)) return true;
  const idents = [...values.matchAll(/(?:^|\.\.\.|[({,\s])([A-Za-z_$][\w$]*)\s*(?=[,})]|$)/gu)].map((m) => m[1]!)
    .filter((name) => !['true', 'false', 'null', 'undefined'].includes(name));
  for (const raw of new Set(idents)) {
    const name = raw.replace(/\$/gu, '\\$');
    if (new RegExp(`\\b${name}\\s*(?:\\.\\s*(?:org_id|orgId)|\\[\\s*['"](?:org_id|orgId)['"]\\s*\\])\\s*=(?!=)`, 'u').test(file)) return true;
    for (const decl of file.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^=;]*=\\s*`, 'gu'))) {
      const start = decl.index! + decl[0].length;
      if (file[start] === '{' && ORG_KEY.test(balanced(file, start) ?? '')) return true;
    }
  }
  return false;
}

const DRIZZLE_TABLE = String.raw`(?:[A-Za-z_$][\w$]*\.)?events`;

/** Every place in `file` that would write events.org_id. */
function orgIdWrites(file: string): string[] {
  const found: string[] = [];
  // Drizzle: update(events).set(…)
  for (const match of file.matchAll(new RegExp(String.raw`\bupdate\(\s*${DRIZZLE_TABLE}\s*\)\s*\.set\(`, 'gu'))) {
    const args = balanced(file, match.index! + match[0].length - 1);
    if (args && namesOrgId(file, args.slice(1, -1))) found.push(`update(events).set${args.slice(0, 80)}`);
  }
  // Drizzle: insert(events)….onConflictDoUpdate({ set: … }) within one statement.
  for (const match of file.matchAll(new RegExp(String.raw`\binsert\(\s*${DRIZZLE_TABLE}\s*\)`, 'gu'))) {
    const rest = file.slice(match.index!, match.index! + 4000);
    const end = rest.search(/;\s*(?:\r?\n|$)/u);
    const statement = end < 0 ? rest : rest.slice(0, end);
    const at = statement.indexOf('onConflictDoUpdate(');
    if (at < 0) continue;
    const args = balanced(statement, at + 'onConflictDoUpdate'.length);
    const setAt = args ? args.search(/(?<![\w.$])set\s*:/u) : -1;
    if (args && setAt >= 0) {
      const valueStart = args.indexOf(':', setAt) + 1;
      const value = args.slice(valueStart).trimStart();
      const body = value.startsWith('{') ? balanced(value, 0) ?? value : value.split(/[,}]/u)[0]!;
      if (namesOrgId(file, body.startsWith('{') ? body.slice(1, -1) : body)) found.push(`insert(events)….onConflictDoUpdate${args.slice(0, 80)}`);
    }
  }
  // SQL: UPDATE events SET … org_id = (also through ${events} / ${events.org_id} in a sql template).
  const sqlTable = String.raw`(?:(?:only\s+)?(?:public\.)?"?events"?|\$\{\s*${DRIZZLE_TABLE}\s*\})`;
  const sqlOrg = String.raw`(?:(?<![\w.])"?org_id"?|\$\{\s*${DRIZZLE_TABLE}\.org_id\s*\})\s*=`;
  // A statement ends at a semicolon, or at the backtick that closes its template string.
  const statementEnd = `(?:;|${String.fromCharCode(96)}|$)`;
  for (const match of file.matchAll(new RegExp(String.raw`\bupdate\s+${sqlTable}(?:\s+(?:as\s+)?\w+)?\s+set\b([\s\S]*?)(?:\bwhere\b|\bfrom\b|\breturning\b|${statementEnd})`, 'giu'))) {
    if (new RegExp(sqlOrg, 'iu').test(match[1]!)) found.push(match[0].slice(0, 80));
  }
  for (const match of file.matchAll(new RegExp(String.raw`\binsert\s+into\s+${sqlTable}[\s\S]*?${statementEnd}`, 'giu'))) {
    const upsert = /\bdo\s+update\s+set\b([\s\S]*)/iu.exec(match[0]);
    if (upsert && new RegExp(sqlOrg, 'iu').test(upsert[1]!)) found.push(match[0].slice(0, 80));
  }
  return found;
}

test('the detectors find every form of writing events.org_id, and not other columns or tables', () => {
  const caught = [
    `await db.update(events).set({ org_id: other }).where(eq(events.id, id));`,
    `await tx.update(schema.events).set({ title, orgId }).where(x);`,
    `const patch = { title: 'x', org_id: org };\nawait db.update(events).set(patch).where(y);`,
    `const row = { org_id: a, title: b };\nawait db.update(events).set({ ...row, external_id: e });`,
    `const updates: Record<string, any> = {};\nupdates.org_id = next;\nawait db.update(events).set(updates);`,
    `await db.insert(events).values(v).onConflictDoUpdate({ target: [events.id], set: { org_id: v.org_id, title } });`,
    `await client.query('UPDATE events SET title = $1, org_id = $2 WHERE id = $3', []);`,
    `UPDATE public.events e SET org_id = 'x' WHERE e.id = 'y';`,
    'await db.execute(sql`UPDATE ${events} SET ${events.org_id} = ${org} WHERE ${events.id} = ${id}`);',
    `INSERT INTO events (id, org_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id;`,
  ];
  for (const sample of caught) assert.notDeepEqual(orgIdWrites(sample), [], sample);
  const fine = [
    `await db.update(events).set({ title }).where(and(eq(events.id, id), eq(events.org_id, org)));`,
    `const patch = { title: 'x' };\nawait db.update(events).set(patch).where(eq(events.org_id, org));`,
    `await db.update(attentionEvents).set({ org_id: x });`,
    `await db.insert(events).values({ org_id: org, title }).onConflictDoUpdate({ target: [events.source, events.external_id], set: { title, body }, setWhere: eq(events.org_id, org) });`,
    `UPDATE attention_events SET org_id = 'x';`,
    `UPDATE events SET title = 'x' WHERE org_id = 'y';`,
    `INSERT INTO events (id, org_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title;`,
  ];
  for (const sample of fine) assert.deepEqual(orgIdWrites(sample), [], sample);
});

test('no code under apps/, packages/ or scripts/ changes an event\'s workspace (events.org_id)', () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir)));
  assert.ok(files.length > 500, `scanned ${files.length} files`);
  const offenders = files.flatMap((path) => orgIdWrites(readFileSync(path, 'utf8')).map((where) => `${relative(ROOT, path)}: ${where}`));
  assert.deepEqual(offenders, [], 'an event must keep its workspace: document_event_links checks it only when a link is written');
});
