import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScratchDatabases, scratchDatabaseName } from './upgrade-tail-scratch.ts';

// The upgrade-tail DB test copies its fixture into scratch databases. These
// cases pin that it only ever drops a database it created in this run.

function recorder(fail: (sql: string) => boolean = () => false) {
  const statements: string[] = [];
  const run = async (sql: string) => {
    statements.push(sql);
    if (fail(sql)) throw Object.assign(new Error('database "x" already exists'), { code: '42P04' });
  };
  return { statements, run };
}
const drops = (statements: string[]) => statements.filter((sql) => sql.startsWith('DROP'));

test('scratch names are short, unique per call and never derived from the fixture name', () => {
  const names = new Set(Array.from({ length: 50 }, () => scratchDatabaseName('deft_test_424fix_')));
  assert.equal(names.size, 50);
  for (const name of names) {
    assert.match(name, /^deft_test_424fix_tail_[0-9a-f]{12}$/u);
    assert.ok(Buffer.byteLength(name) <= 63, 'PostgreSQL would truncate a longer name');
  }
  assert.equal(scratchDatabaseName('fix_a_', () => 'abc123abc123'), 'fix_a_tail_abc123abc123');
  assert.throws(() => scratchDatabaseName('fix_a_"; DROP DATABASE x; --'));
  assert.throws(() => scratchDatabaseName('x'.repeat(60)), /63/u);
});

test('a failed fixture check before creation leaves nothing to drop', async () => {
  const { statements, run } = recorder();
  const scratch = new ScratchDatabases(run);
  // The fixture check throws before create() is reached; the after hook still runs.
  await scratch.dropAll();
  assert.deepEqual(statements, []);
});

test('a name that is already taken fails creation and is never dropped', async () => {
  const { statements, run } = recorder((sql) => sql.startsWith('CREATE'));
  const scratch = new ScratchDatabases(run);
  await assert.rejects(scratch.create('fix_a_tail_000000000000', 'fix_a_head'), /already exists/u);
  await scratch.drop('fix_a_tail_000000000000');
  await scratch.dropAll();
  assert.deepEqual(drops(statements), []);
  assert.deepEqual(scratch.names, []);
});

test('only databases this run created are dropped, each once', async () => {
  const { statements, run } = recorder();
  const scratch = new ScratchDatabases(run);
  const name = await scratch.create('fix_a_tail_111111111111', 'fix_a_head');
  assert.deepEqual(statements, ['CREATE DATABASE "fix_a_tail_111111111111" TEMPLATE "fix_a_head"']);
  await scratch.drop('fix_a_head');
  await scratch.drop('someone_elses_test');
  assert.deepEqual(drops(statements), [], 'an uncreated name, the fixture included, is never dropped');
  await scratch.drop(name);
  await scratch.dropAll();
  assert.deepEqual(drops(statements), ['DROP DATABASE IF EXISTS "fix_a_tail_111111111111" WITH (FORCE)']);
});

test('the after hook drops what a failed test left behind', async () => {
  const { statements, run } = recorder();
  const scratch = new ScratchDatabases(run);
  await scratch.create('fix_a_tail_222222222222', 'fix_a_head');
  await scratch.create('fix_a_tail_333333333333', 'fix_a_head');
  await scratch.dropAll();
  assert.deepEqual(drops(statements).sort(), [
    'DROP DATABASE IF EXISTS "fix_a_tail_222222222222" WITH (FORCE)',
    'DROP DATABASE IF EXISTS "fix_a_tail_333333333333" WITH (FORCE)',
  ]);
  assert.deepEqual(scratch.names, []);
});

test('a scratch database can never be created from or named as itself', async () => {
  const { statements, run } = recorder();
  const scratch = new ScratchDatabases(run);
  await assert.rejects(scratch.create('fix_a_head', 'fix_a_head'));
  assert.deepEqual(statements, []);
});
