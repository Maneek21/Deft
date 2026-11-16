import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkAddedUpgradeFiles, checkRepositoryUpgrades, findAddOnlyViolations } from './add-only-upgrades.ts';

const refused: Array<[string, string, string]> = [
  ['drop table', 'DROP TABLE tasks;', 'drop'],
  ['drop column', 'ALTER TABLE tasks DROP COLUMN title;', 'drop'],
  ['drop and recreate', 'DROP FUNCTION IF EXISTS guard(); CREATE FUNCTION guard() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', 'drop'],
  ['rename table', 'ALTER TABLE tasks RENAME TO work;', 'rename'],
  ['rename column', 'ALTER TABLE tasks RENAME COLUMN title TO name;', 'rename'],
  ['type change', 'ALTER TABLE tasks ALTER COLUMN title TYPE varchar(20);', 'column-type'],
  ['SET DATA TYPE', 'ALTER TABLE tasks ALTER title SET DATA TYPE text;', 'column-type'],
  ['narrow check', 'ALTER TABLE tasks ADD CONSTRAINT short_title CHECK(length(title)<20);', 'narrowing'],
  ['narrow check even NOT VALID', 'ALTER TABLE tasks ADD CHECK(title IS NOT NULL) NOT VALID;', 'narrowing'],
  ['narrow new required column', 'ALTER TABLE tasks ADD owner text NOT NULL;', 'narrowing'],
  ['null default', 'ALTER TABLE tasks ADD owner text NOT NULL DEFAULT NULL;', 'narrowing'],
  ['parenthesized null default', 'ALTER TABLE tasks ADD owner text NOT NULL DEFAULT (NULL);', 'narrowing'],
  ['computed default cannot prove non-null', 'ALTER TABLE tasks ADD owner text NOT NULL DEFAULT maybe_null();', 'narrowing'],
  ['narrow existing column even with default', "ALTER TABLE tasks ALTER title SET DEFAULT ''; ALTER TABLE tasks ALTER title SET NOT NULL;", 'unsupported'],
  ['narrow foreign key', 'ALTER TABLE tasks ADD FOREIGN KEY(owner) REFERENCES users(id);', 'narrowing'],
  ['narrow unique index', 'CREATE UNIQUE INDEX tasks_name ON tasks(title);', 'narrowing'],
  ['narrow trigger', 'CREATE TRIGGER guard BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION guard();', 'narrowing'],
  ['new-table impersonation', 'CREATE TABLE IF NOT EXISTS tasks(id text); ALTER TABLE tasks ADD CHECK(id IS NOT NULL);', 'narrowing'],
  ['schema identity', 'CREATE TABLE other.tasks(id text); ALTER TABLE public.tasks ADD CHECK(id IS NOT NULL);', 'narrowing'],
  ['quoted name identity', 'CREATE TABLE "Tasks"(id text); ALTER TABLE tasks ADD CHECK(id IS NOT NULL);', 'narrowing'],
  ['delete', 'DELETE FROM tasks WHERE is_deleted;', 'delete'],
  ['truncate', 'TRUNCATE tasks;', 'truncate'],
  ['update even with WHERE', "UPDATE tasks SET status='done' WHERE status='todo';", 'data-rewrite'],
  ['procedural dynamic SQL', "DO $$ BEGIN EXECUTE 'DR' || 'OP TABLE tasks'; END $$;", 'unsupported'],
  ['called routine', 'SELECT destructive_upgrade();', 'unsupported'],
  ['called procedure', 'CALL destructive_upgrade();', 'unsupported'],
  ['data CTE', 'WITH x AS (DELETE FROM tasks RETURNING *) SELECT * FROM x;', 'unsupported'],
  ['arithmetic hides a null default', 'ALTER TABLE tasks ADD owner text NOT NULL DEFAULT 1 * NULL;', 'narrowing'],
  ['nullable column with a called default', 'ALTER TABLE tasks ADD note text DEFAULT purge_everything();', 'narrowing'],
  ['nullable column with an expression default', "ALTER TABLE tasks ADD note text DEFAULT 'a' || 'b';", 'narrowing'],
  ['function change beyond search_path', 'ALTER FUNCTION public.guard() SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;', 'unsupported'],
  ['function search_path with a rename', 'ALTER FUNCTION public.guard() SET search_path = pg_catalog, public, pg_temp OWNER TO other;', 'unsupported'],
  ['default followed by NOT LIKE a called function', "ALTER TABLE tasks ADD note boolean DEFAULT 'a' NOT LIKE purge_everything();", 'narrowing'],
  ['search_path with a quoted PUBLIC', 'ALTER FUNCTION public.guard() SET search_path = pg_catalog, "PUBLIC", pg_temp;', 'unsupported'],
  ['expression index that can throw on old rows', 'CREATE INDEX tasks_title_int ON tasks ((title::integer));', 'narrowing'],
  ['function index key', 'CREATE INDEX tasks_lower_title ON tasks (lower(title));', 'narrowing'],
  ['index predicate with a cast', 'CREATE INDEX tasks_cast ON tasks (id) WHERE title::integer > 0;', 'narrowing'],
  ['index predicate with a function call', 'CREATE INDEX tasks_fn ON tasks (id) WHERE int4(title) > 0;', 'narrowing'],
  ['index predicate with arithmetic', 'CREATE INDEX tasks_div ON tasks (id) WHERE 1 / id > 0;', 'narrowing'],
  ['function key named like a clause keyword', 'CREATE INDEX tasks_bad ON tasks (public.include(title));', 'narrowing'],
  ['LIKE predicate can raise on a backslash', 'CREATE INDEX tasks_like ON tasks (id) WHERE title LIKE title;', 'narrowing'],
  ['zero-argument function in an index predicate', 'CREATE INDEX tasks_bad ON tasks(id) WHERE fail_restore() IS TRUE;', 'narrowing'],
  ['subquery in an index predicate', 'CREATE INDEX tasks_sub ON tasks (id) WHERE id = (SELECT 1);', 'narrowing'],
  ['schema with an embedded unique index', 'CREATE SCHEMA extra CREATE UNIQUE INDEX tasks_title_unique ON public.tasks(title);', 'unsupported'],
  ['schema with an embedded grant', 'CREATE SCHEMA extra GRANT SELECT ON TABLE public.users TO PUBLIC;', 'unsupported'],
  ['schema with an owner clause', 'CREATE SCHEMA extra AUTHORIZATION postgres;', 'unsupported'],
  ['routine replacement', 'CREATE OR REPLACE FUNCTION guard() RETURNS bool LANGUAGE sql AS $$ SELECT false $$;', 'unsupported'],
];
for (const [name, sql, rule] of refused) test(`refuses ${name}`, () => {
  assert.ok(findAddOnlyViolations(sql).some((finding) => finding.rule === rule), sql);
});

const additive = `
  CREATE TABLE example (id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id));
  CREATE UNIQUE INDEX example_id ON example(id);
  ALTER TABLE example ADD CHECK(id <> '');
  ALTER TABLE tasks ADD COLUMN optional_note text, ADD COLUMN priority text NOT NULL DEFAULT 'p2';
  ALTER TABLE tasks ADD COLUMN rank integer NOT NULL DEFAULT -1, ADD COLUMN extra jsonb DEFAULT '{}'::jsonb NOT NULL, ADD COLUMN spare text DEFAULT NULL;
  CREATE INDEX tasks_optional_note ON tasks(optional_note);
  CREATE SCHEMA IF NOT EXISTS extra;
  CREATE INDEX tasks_open ON tasks (org_id, created_at DESC NULLS LAST) INCLUDE (title) WHERE (status IN ('todo', 'doing') AND done IS NOT TRUE);
  CREATE INDEX tasks_title_trgm ON tasks USING gin (title gin_trgm_ops);
  CREATE INDEX tasks_nested ON tasks (org_id) WHERE ((status = 'todo') OR (priority >= 2 AND archived IS NULL));
  ALTER FUNCTION public.deft_app_consent_valid(jsonb, text) SET search_path = pg_catalog, public, pg_temp;
`;
test('accepts additive fixture with new-table constraints and old-table optional columns', () => {
  assert.deepEqual(findAddOnlyViolations(additive), []);
});
test('comments, quoted names and stored routine bodies are not executed SQL', () => {
  assert.deepEqual(findAddOnlyViolations(`
    -- DROP TABLE tasks;
    /* nested /* DELETE FROM tasks */ TRUNCATE tasks; */
    ALTER TABLE tasks ADD COLUMN "drop" text DEFAULT 'DROP TABLE x; --';
    CREATE FUNCTION future_purge() RETURNS void LANGUAGE sql AS $fn$ DELETE FROM tasks $fn$;
    COMMENT ON TABLE tasks IS 'DROP TABLE x;';
  `), []);
});
test('a literal cannot hide a following destructive statement', () => {
  assert.ok(findAddOnlyViolations("COMMENT ON TABLE tasks IS '-- ;'; DROP TABLE tasks;").some((v) => v.rule === 'drop'));
  assert.throws(() => findAddOnlyViolations('/* unterminated'), /Unterminated/);
});
test('checks only added files; history is immutable and never rescanned', () => {
  const files: Record<string, string> = { 'old.sql': 'DROP TABLE legacy;', 'new.sql': additive };
  const input = { baselineFiles: ['old.sql'], currentFiles: Object.keys(files),
    baselineRead: () => files['old.sql']!, read: (file: string) => files[file]! };
  assert.deepEqual(checkAddedUpgradeFiles(input), { checkedFiles: ['new.sql'], violations: [] });
  assert.equal(checkAddedUpgradeFiles({ ...input, baselineRead: () => 'different' }).violations.length, 1);
  assert.equal(checkAddedUpgradeFiles({ ...input, baselineRead: () => 'a\nb',
    read: (file: string) => file === 'old.sql' ? 'a\r\nb' : files[file]! }).violations.length, 1,
  'a line-ending change alters the checksum, so it is an edit to released history');
  assert.equal(checkAddedUpgradeFiles({ ...input, currentFiles: [] }).violations.length, 1);
});

test('release baseline stays fixed when master gains an unreleased destructive upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deft-add-only-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const old = 'packages/db/upgrades/old.sql';
  const fresh = 'packages/db/upgrades/new.sql';
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    mkdirSync(join(directory, 'packages/db/upgrades'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{"version":"1.0.0"}');
    writeFileSync(join(directory, old), 'DROP TABLE legacy;');
    git('add', '.'); git('commit', '--quiet', '-m', 'release'); git('tag', 'v1.0.0');
    const release = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, fresh), additive);
    assert.deepEqual(checkRepositoryUpgrades('HEAD', undefined, directory), {
      baseline: release, checkedFiles: [fresh], violations: [],
    });
    for (const [, sql] of refused) {
      writeFileSync(join(directory, fresh), sql);
      assert.ok(checkRepositoryUpgrades('HEAD', undefined, directory).violations.length > 0, sql);
    }
    // A non-ASCII file name (Git quotes it unless listed with -z) must still be judged.
    const accented = 'packages/db/upgrades/0.3.0-preview.149-équipe.sql';
    writeFileSync(join(directory, accented), 'DROP TABLE tasks;');
    const quoted = checkRepositoryUpgrades('HEAD', undefined, directory);
    assert.ok(quoted.checkedFiles.includes(accented) && quoted.violations.some((v) => v.file === accented));
    rmSync(join(directory, accented));
    git('add', '.'); git('commit', '--quiet', '-m', 'unreleased');
    // The release bump merged but v1.0.1 is not tagged yet: the baseline is still v1.0.0.
    writeFileSync(join(directory, 'package.json'), '{"version":"1.0.1"}');
    git('add', '.'); git('commit', '--quiet', '-m', 'bump');
    assert.equal(checkRepositoryUpgrades('HEAD', undefined, directory).baseline, release);
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    assert.ok(checkRepositoryUpgrades('origin/master', 'HEAD', directory).violations.length > 0);
    assert.throws(() => checkRepositoryUpgrades('missing-ref', undefined, directory));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
