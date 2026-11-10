import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as s from '@deft/db/schema';
import {
  FK_PAIRS,
  SKIPS,
  UNCONSTRAINED_REFS,
  buildChecks,
  formatSummary,
  maskTarget,
  parseArgs,
  runAudit,
  withReadOnlyTransaction,
} from '../src/scripts/audit-mixed-org-rows.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash && /^\/deft_test/u.test(url.pathname);
  } catch { return false; }
})();

const KEY_TABLES = ['orgs', 'users', 'org_members', 'spaces', 'space_members', 'messages', 'canvases', 'notes', 'note_shares'];

async function counts(client: pg.Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of KEY_TABLES) out[t] = Number((await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
  const rels = await client.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`);
  out.__relations = rels.rows[0].n;
  return out;
}

test('audit-mixed-org-rows: argument handling needs no database', () => {
  assert.throws(() => parseArgs(['--fix'], {}), /read-only/u);
  assert.throws(() => parseArgs(['--delete', '--database-url', 'postgres://x/y'], {}), /read-only/u);
  assert.throws(() => parseArgs(['--repair=1'], { DATABASE_URL: 'postgres://x/y' }), /read-only/u);
  assert.throws(() => parseArgs(['--bogus'], { DATABASE_URL: 'postgres://x/y' }), /unknown argument/u);
  assert.throws(() => parseArgs([], {}), /--database-url/u);
  assert.throws(() => parseArgs(['--limit', '-1', '--database-url', 'postgres://x/y'], {}), /--limit/u);
  const ok = parseArgs(['--database-url', 'postgres://u:secret@h:5/d', '--json', 'o.json', '--limit', '7'], {});
  assert.deepEqual([ok.jsonPath, ok.limit], ['o.json', 7]);
  assert.equal(parseArgs([], { DATABASE_URL: 'postgres://u@h/d' }).databaseUrl, 'postgres://u@h/d');
  const masked = maskTarget('postgres://user:secret@db.example:5432/deft?sslmode=require');
  assert.equal(masked, 'db.example:5432/deft');
  assert.ok(!masked.includes('secret') && !masked.includes('user'));
});

test('audit-mixed-org-rows: the check registry is read-only SELECT text', () => {
  const checks = buildChecks();
  assert.ok(checks.length > 150);
  for (const c of checks) {
    const sql = `${c.from} ${c.where} ${c.orgA} ${c.orgB ?? ''}`;
    assert.ok(!/\b(insert|update|delete|drop|alter|create|truncate|grant|copy)\b/iu.test(sql), c.id);
  }
});

test('audit-mixed-org-rows: database', { skip: !safe && 'needs DEFT_TEST_DATABASE_URL = DATABASE_URL on a local deft_test* database' }, async (t) => {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const fn of cleanups) await fn();
    await client.end();
  });

  // Completeness: every single-column FK between two org-scoped tables is
  // either a registered check or a documented skip.
  await t.test('registry covers every org-scoped foreign key in the live catalog', async () => {
    const r = await client.query<{ child: string; col: string; parent: string }>(
      `SELECT cl.relname AS child, a.attname AS col, pcl.relname AS parent
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_class pcl ON pcl.oid = con.confrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = con.conkey[1]
        WHERE con.contype = 'f' AND ns.nspname = 'public' AND array_length(con.conkey, 1) = 1
          AND a.attname <> 'org_id'
          AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = cl.oid AND x.attname = 'org_id' AND NOT x.attisdropped)
          AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = pcl.oid AND x.attname = 'org_id' AND NOT x.attisdropped)`,
    );
    const registered = new Set(FK_PAIRS.map(([c, col, p]) => `${c}.${col}->${p}`));
    const missing = r.rows.map((x) => `${x.child}.${x.col}->${x.parent}`).filter((k) => !registered.has(k));
    assert.deepEqual(missing, [], 'add these to FK_PAIRS (or document a skip in SKIPS)');
    const live = new Set(r.rows.map((x) => `${x.child}.${x.col}->${x.parent}`));
    const stale = [...registered].filter((k) => !live.has(k));
    assert.deepEqual(stale, [], 'FK_PAIRS lists a constraint that no longer exists');
    assert.ok(UNCONSTRAINED_REFS.length > 0 && SKIPS.length > 0);
  });

  const before = await counts(client);

  const clean = await runAudit(client, { limit: 5, target: maskTarget(target!) });
  // The API test runner seeds src/scripts/seed-test-fixtures.ts before any test.
  // That seed leads the org B fixture project with a user who is only a member
  // of org A, and the audit rightly lists it. It is the one tolerated baseline
  // row; on a plain db:push-full database the total is 0.
  const FIXTURE_ROW = 'projects.lead_id not member (none)';
  const baseline = new Map(clean.checks.filter((c) => c.severity === 'mismatch' && c.count > 0).map((c) => [c.id, c.count] as const));
  await t.test('(a) a fresh schema reports zero mismatches and no errored checks', () => {
    assert.equal(clean.transaction_read_only, 'on');
    assert.deepEqual(clean.checks.filter((c) => c.error).map((c) => `${c.id}: ${c.error}`), []);
    assert.deepEqual([...baseline.keys()].filter((id) => id !== FIXTURE_ROW), []);
    const fixture = clean.checks.find((c) => c.id === FIXTURE_ROW)!;
    assert.ok(fixture.count <= 1 && fixture.samples.every((x) => x.id === 'fixture-project-org-b'));
    assert.match(formatSummary(clean), /Not checked \(by design\)/u);
  });

  await t.test('(c) the audit performs no writes and its transaction rejects writes', async () => {
    assert.deepEqual(await counts(client), before);
    await assert.rejects(
      withReadOnlyTransaction(client, async () => {
        await client.query(`INSERT INTO orgs (id, name, slug) VALUES ('ro-probe', 'x', 'ro-probe')`);
      }),
      (err: any) => err.code === '25006',
    );
    await assert.rejects(
      withReadOnlyTransaction(client, async () => {
        await client.query('CREATE TABLE audit_ro_probe (id int)');
      }),
      (err: any) => err.code === '25006',
    );
    assert.deepEqual(await counts(client), before);
  });

  await t.test('(b) deliberate mismatches are reported exactly', async () => {
    const tag = randomUUID().slice(0, 8);
    const id = (p: string) => `${p}-${tag}`;
    const ids = {
      orgA: id('orgA'), orgB: id('orgB'), userA: id('userA'), userB: id('userB'), userX: id('userX'),
      spaceB: id('spaceB'), msg: id('msg'), canvas: id('canvas'), note: id('note'), share: id('share'), sm: id('sm'),
    };
    const db = drizzle(client, { schema: s });
    const cleanup = async () => {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('DELETE FROM note_shares WHERE id = $1', [ids.share]);
      await client.query('DELETE FROM notes WHERE id = $1', [ids.note]);
      await client.query('DELETE FROM space_members WHERE id = $1', [ids.sm]);
      await client.query('DELETE FROM canvases WHERE id = $1', [ids.canvas]);
      await client.query('DELETE FROM messages WHERE id = $1', [ids.msg]);
      await client.query('DELETE FROM spaces WHERE id = $1', [ids.spaceB]);
      await client.query('DELETE FROM org_members WHERE org_id = ANY($1)', [[ids.orgA, ids.orgB]]);
      await client.query('DELETE FROM users WHERE id = ANY($1)', [[ids.userA, ids.userB, ids.userX]]);
      await client.query('DELETE FROM orgs WHERE id = ANY($1)', [[ids.orgA, ids.orgB]]);
      await client.query('COMMIT');
    };
    cleanups.push(cleanup);

    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await db.insert(s.orgs).values([
      { id: ids.orgA, name: 'A', slug: id('a') }, { id: ids.orgB, name: 'B', slug: id('b') },
    ]);
    await db.insert(s.users).values([
      { id: ids.userA, name: 'a', email: `${ids.userA}@example.test` },
      { id: ids.userB, name: 'b', email: `${ids.userB}@example.test` },
      { id: ids.userX, name: 'x', email: `${ids.userX}@example.test` },
    ]);
    await db.insert(s.orgMembers).values([
      { org_id: ids.orgA, user_id: ids.userA }, { org_id: ids.orgB, user_id: ids.userB },
    ]);
    await db.insert(s.spaces).values({ id: ids.spaceB, org_id: ids.orgB, name: 'sb', created_by: ids.userB });
    // org A rows written against the org B space
    await db.insert(s.messages).values({ id: ids.msg, org_id: ids.orgA, space_id: ids.spaceB, user_id: ids.userA, content: 'm' });
    await db.insert(s.canvases).values({ id: ids.canvas, org_id: ids.orgA, space_id: ids.spaceB });
    await db.insert(s.spaceMembers).values({ id: ids.sm, space_id: ids.spaceB, user_id: ids.userA });
    // a note in org A shared with a user who is in no org
    await db.insert(s.notes).values({ id: ids.note, org_id: ids.orgA, user_id: ids.userA, title: 't' });
    await db.insert(s.noteShares).values({ id: ids.share, note_id: ids.note, shared_with_user_id: ids.userX });
    await client.query('COMMIT');

    const report = await runAudit(client, { limit: 10, target: 'test' });
    const hit = report.checks.filter((c) => c.severity === 'mismatch' && c.count - (baseline.get(c.id) ?? 0) > 0);
    assert.deepEqual(
      hit.map((c) => `${c.id}=${c.count}`).sort(),
      [
        'canvases.space_id->spaces=1',
        'messages.space_id->spaces=1',
        'note_shares.shared_with_user_id not member (none)=1',
        'space_members.user_id not member (none)=1',
      ],
    );
    assert.deepEqual(report.checks.filter((c) => c.error), []);
    const m = hit.find((c) => c.id === 'messages.space_id->spaces')!;
    assert.deepEqual(m.samples.map((x) => [x.id, x.org_a, x.org_b]), [[ids.msg, ids.orgA, ids.orgB]]);
    assert.ok(m.samples[0]!.created_at);
    // samples carry only id, orgs and created_at
    assert.deepEqual(Object.keys(m.samples[0]!).sort(), ['created_at', 'id', 'org_a', 'org_b']);
    assert.ok(!JSON.stringify(report).includes('"content"'));
    assert.equal(report.mismatch_rows - clean.mismatch_rows, 4);

    // --limit bounds samples but not counts
    const limited = await runAudit(client, { limit: 0, target: 'test' });
    assert.equal(limited.mismatch_rows - clean.mismatch_rows, 4);
    assert.ok(limited.checks.every((c) => c.samples.length === 0));

    // the audit itself still wrote nothing
    const mid = await counts(client);
    await runAudit(client, { limit: 10, target: 'test' });
    assert.deepEqual(await counts(client), mid);
  });
});
