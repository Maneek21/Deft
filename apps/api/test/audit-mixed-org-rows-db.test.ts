import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as s from '@deft/db/schema';
import {
  FK_PAIRS,
  SKIPS,
  USER_FK_SKIPS,
  catalogInfo,
  exitCodeFor,
  main,
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
  assert.throws(() => parseArgs(['--bogus'], { DATABASE_URL: 'postgres://x/y' }), /unknown argument at position 1/u);
  assert.throws(() => parseArgs([], {}), /--database-url/u);
  assert.throws(() => parseArgs(['--limit', '-1', '--database-url', 'postgres://x/y'], {}), /--limit/u);
  const ok = parseArgs(['--database-url', 'postgres://u:secret@h:5/d', '--json', 'o.json', '--limit', '7'], {});
  assert.deepEqual([ok.jsonPath, ok.limit], ['o.json', 7]);
  assert.equal(parseArgs([], { DATABASE_URL: 'postgres://u@h/d' }).databaseUrl, 'postgres://u@h/d');
  const masked = maskTarget('postgres://user:secret@db.example:5432/deft?sslmode=require&password=secret&user=alice');
  assert.equal(masked, 'db.example:5432/deft');
  for (const bad of ['postgresql:alice:secret@host/db', 'postgresql://host/alice:secret@db', 'mysql://u:p@h/db', 'postgres:///db', 'postgres://@/db', 'not a url', 'postgres://h/db name']) {
    assert.equal(maskTarget(bad), null, bad);
  }
});

function capture(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const log = console.log; const err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { out.push(a.join(' ')); };
  return { out, restore: () => { console.log = log; console.error = err; } };
}

test('audit-mixed-org-rows: S5-r2-1 error output never echoes arguments or credentials', async () => {
  const cases: string[][] = [
    ['postgresql://user:secret@host/db'],
    ['--databse-url=postgresql://user:secret@host.invalid/db'],
    ['--fixsecret=postgresql://user:secret@host/db'],
  ];
  for (const argv of cases) {
    const cap = capture();
    let code: number;
    try { code = await main(argv); } finally { cap.restore(); }
    const text = cap.out.join('\n');
    assert.equal(code, 1);
    assert.ok(!text.includes('secret') && !text.includes('postgresql://') && !text.includes('user:'), text);
  }
  // unreachable host or malformed URL with credentials
  for (const url of ['postgresql://leakuser:leakpass@127.0.0.1:1/db', 'postgresql://leakuser:leakpass@nonexistent.invalid:5432/db', 'postgres://leakuser:leakpass@[bad']) {
    const cap = capture();
    let code: number;
    try { code = await main(['--database-url', url]); } finally { cap.restore(); }
    const text = cap.out.join('\n');
    assert.equal(code, 1);
    assert.ok(!/leakpass|leakuser|postgres(ql)?:\/\//u.test(text), text);
  }
});

test('audit-mixed-org-rows: S5-r3-1 target display never shows credentials and rejects non-authority URLs', async () => {
  const rejected = ['postgresql:alice:secret@host/db', 'postgresql://127.0.0.1:1/alice:secret@db', 'postgresql:/alice:secret@host/db'];
  for (const url of rejected) {
    const cap = capture();
    let code: number;
    try { code = await main(['--database-url', url]); } finally { cap.restore(); }
    const text = cap.out.join(String.fromCharCode(10));
    assert.equal(code, 1, url);
    assert.ok(!/alice|secret|target:/u.test(text), text);
  }
  for (const url of ['postgresql://alice:secret@127.0.0.1:1/db?password=secret&user=alice', 'postgresql://127.0.0.1:1/db?user=alice&password=secret']) {
    const cap = capture();
    try { await main(['--database-url', url]); } finally { cap.restore(); }
    const text = cap.out.join(String.fromCharCode(10));
    assert.ok(text.includes('target: 127.0.0.1:1/db (read-only)'), text);
    assert.ok(!/alice|secret/u.test(text), text);
  }
});

test('audit-mixed-org-rows: S5-r3-2 the success message does not print the json path', { skip: !safe && 'needs DEFT_TEST_DATABASE_URL = DATABASE_URL on a local deft_test* database' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-json-'));
  const file = join(dir, 'zz-private-name.json');
  const cap = capture();
  try { await main(['--database-url', target!, '--json', file, '--limit', '0']); } finally { cap.restore(); }
  try {
    assert.ok(existsSync(file));
    const text = cap.out.join(String.fromCharCode(10));
    assert.ok(text.includes('JSON report written'), text);
    assert.ok(!text.includes('zz-private-name') && !text.includes(dir), text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('audit-mixed-org-rows: S5-r2-4 a statement timeout is an error for that check and forces exit 1', { skip: !safe && 'needs DEFT_TEST_DATABASE_URL = DATABASE_URL on a local deft_test* database' }, async () => {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    let slept = false;
    const seam = {
      query: ((text: any, params?: any) => {
        if (!slept && typeof text === 'string' && text.startsWith('SELECT count(*)')) {
          slept = true;
          return client.query('SELECT pg_sleep(4)');
        }
        return client.query(text, params);
      }) as pg.Client['query'],
    };
    const report = await runAudit(seam, { limit: 1, statementTimeoutMs: 1500, target: 'test' });
    assert.equal(report.errors, 1);
    const bad = report.checks.filter((c) => c.error);
    assert.equal(bad.length, 1);
    assert.match(bad[0]!.error!, /57014/u);
    assert.ok(!/pg_sleep|canceling/u.test(bad[0]!.error!));
    assert.equal(exitCodeFor(report), 1);
    assert.equal(exitCodeFor({ ...report, errors: 0, mismatch_rows: 3 }), 2);
    assert.equal(exitCodeFor({ ...report, errors: 0, mismatch_rows: 0 }), 0);
  } finally { await client.end(); }
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

  await t.test('S5-r2-2 primary key discovery ignores INCLUDE columns', async () => {
    await client.query('BEGIN');
    try {
      await client.query('CREATE TABLE audit_pk_probe (id text NOT NULL, payload text, CONSTRAINT audit_pk_probe_pk PRIMARY KEY (id) INCLUDE (payload))');
      const info = await catalogInfo(client);
      assert.deepEqual(info.pk.get('audit_pk_probe'), ['id']);
    } finally {
      await client.query('ROLLBACK');
    }
    assert.equal((await client.query(`SELECT to_regclass('public.audit_pk_probe') AS r`)).rows[0].r, null);
  });

  await t.test('S5-r2-3 every user FK from an org-bearing table is a membership check or a documented skip', async () => {
    const r = await client.query<{ t: string; col: string; covered: boolean }>(
      `SELECT DISTINCT cl.relname AS t, a.attname AS col,
              EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class kp ON kp.oid = k.confrelid
                       WHERE k.contype = 'f' AND k.conrelid = con.conrelid AND kp.relname = 'org_members'
                         AND array_length(k.conkey, 1) > 1 AND a.attnum = ANY (k.conkey)) AS covered
         FROM pg_constraint con
         JOIN pg_class cl ON cl.oid = con.conrelid
         JOIN pg_class p ON p.oid = con.confrelid
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = con.conkey[1]
        WHERE con.contype = 'f' AND ns.nspname = 'public' AND p.relname = 'users' AND array_length(con.conkey, 1) = 1
          AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = cl.oid AND x.attname = 'org_id' AND NOT x.attisdropped)`,
    );
    const registered = new Set(buildChecks().filter((c) => c.orgB === null && c.severity === 'mismatch').map((c) => c.columns[0]));
    const skipped = new Map(USER_FK_SKIPS.map((x) => [`${x.table}.${x.col}`, x.reason] as const));
    assert.ok([...skipped.values()].every((reason) => reason.length > 20), 'every skip needs a reason');
    assert.deepEqual([...skipped.keys()].sort(), ['oauth_audit_events.user_id', 'org_members.user_id'], 'only these two blanket skips are justified');
    for (const k of ['skills.created_by', 'task_templates.created_by', 'agent_employee_templates.created_by', 'app_private_defty_seals.defty_user_id', 'native_mention_deliveries.actor_user_id', 'agent_channel_events.actor_user_id', 'attention_events.actor_user_id']) assert.ok(registered.has(k), k);
    const live = new Set(r.rows.map((x) => `${x.t}.${x.col}`));
    // composite (org_id, user) -> org_members keys make a cross-org member impossible to store
    const unhandled = r.rows.filter((x) => !x.covered).map((x) => `${x.t}.${x.col}`).filter((k) => !registered.has(k) && !skipped.has(k));
    assert.deepEqual(unhandled, [], 'register a member check in MEMBER_COLUMNS or add a reasoned USER_FK_SKIPS entry');
    assert.deepEqual([...skipped.keys()].filter((k) => !live.has(k)), [], 'USER_FK_SKIPS lists a column that no longer exists');
    assert.deepEqual([...skipped.keys()].filter((k) => registered.has(k)), [], 'a column is both registered and skipped');
    for (const k of ['mcp_tokens.user_id', 'oauth_grants.user_id', 'agent_employees.user_id', 'workflow_rules.created_by']) {
      assert.ok(registered.has(k), k);
    }
  });

  const before = await counts(client);

  const clean = await runAudit(client, { limit: 5, target: maskTarget(target!)! });
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
