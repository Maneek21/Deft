import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { entryHeaders, packTar, paxRecord } from '../src/lib/workspace-export/tar.js';
import { UsageError, parseCommand, runCommand } from '../src/scripts/export-workspace.js';

/** The operating system's own tar (Windows ships bsdtar as tar.exe; a Git Bash tar on PATH reads C: as a host). */
const systemTar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const env = { DATABASE_URL: 'postgres://localhost/x' };
const base = ['--workspace', 'w', '--uploads', 'u', '--out', 'x.tar'];

test('the command needs exactly one scope, and the whole workspace only by its explicit flag', () => {
  assert.throws(() => parseCommand(base, env), UsageError);
  assert.throws(() => parseCommand([...base, '--whole-workspace', '--member', 'a@example.test'], env), UsageError);
  assert.deepEqual(parseCommand([...base, '--member', 'a@example.test'], env).scope, { kind: 'member', member: 'a@example.test' });
  assert.deepEqual(parseCommand([...base, '--whole-workspace'], env).scope, { kind: 'workspace' });
  assert.equal(parseCommand([...base, '--whole-workspace'], env).singleWorkspaceDatabase, false, 'attachments are copied only when declared');
  const declared = parseCommand([...base, '--whole-workspace', '--single-workspace-database', '--database-schema', 'deft'], env);
  assert.equal(declared.singleWorkspaceDatabase, true);
  assert.equal(declared.databaseSchema, 'deft');
  assert.throws(() => parseCommand([...base, '--whole-workspace'], {}), /DATABASE_URL/);
  assert.throws(() => parseCommand(['--workspace', 'w', '--whole-workspace'], env), /required/);
  assert.throws(() => parseCommand([...base, '--whole-workspace', '--scope', 'all'], env));
});

test('the tar file extracts with the system tar to exactly the folder, long and non-ASCII names included', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-export-tar-'));
  try {
    const folder = join(dir, 'in');
    // 235 bytes: past the 100-byte ustar field, within the 255-byte name limit of Linux file systems.
    const longName = `${'Résumé-ünïcødé-'.repeat(11)}.txt`;
    const files: Record<string, Buffer> = {
      'README.txt': Buffer.from('hello\n'),
      'empty.txt': Buffer.alloc(0),
      [`attachments/f1/${longName}`]: Buffer.from('unicode name'),
      'attachments/f2/block.bin': Buffer.alloc(512, 1),
      'attachments/f3/big.bin': Buffer.alloc(3 * 1024 * 1024 + 7, 2),
    };
    for (const [path, bytes] of Object.entries(files)) {
      await mkdir(join(folder, ...path.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(folder, ...path.split('/')), bytes);
    }
    const tarPath = join(dir, 'export.tar');
    await packTar(folder, tarPath, 'deft-export-test', 1_700_000_000);
    const out = join(dir, 'out');
    await mkdir(out);
    const extracted = spawnSync(systemTar, ['-xf', tarPath, '-C', out], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    for (const [path, bytes] of Object.entries(files)) {
      assert.deepEqual(await readFile(join(out, 'deft-export-test', ...path.split('/'))), bytes, path);
    }
    const listed = spawnSync(systemTar, ['-tf', tarPath], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.equal(listed.length, Object.keys(files).length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pax records count their own length at every digit boundary, and sizes over 8 GiB go in a pax record', () => {
  for (let length = 1; length < 1200; length += 1) {
    const record = paxRecord('path', 'x'.repeat(length));
    assert.equal(Number(record.split(' ')[0]), Buffer.byteLength(record), `value length ${length}`);
  }
  const big = entryHeaders('top/huge.bin', 9_000_000_000, 0);
  assert.ok(big.toString('latin1').includes('size=9000000000\n'));
  assert.equal(big.length % 512, 0);
  assert.equal(big.subarray(big.length - 512 + 124, big.length - 512 + 135).toString('ascii'), '77777777777');
});

test('the tar never replaces an existing file, and refuses a top-level name that is not one safe segment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-export-tar-safe-'));
  try {
    const folder = join(dir, 'in');
    await mkdir(folder);
    await writeFile(join(folder, 'a.txt'), 'a');
    const existing = join(dir, 'taken.tar');
    await writeFile(existing, 'keep me');
    // Another export's staging file, at the name an earlier version used: never touched.
    await writeFile(`${existing}.partial`, 'not ours');
    await writeFile(join(dir, 'fresh.tar.partial'), 'not ours either');
    await assert.rejects(packTar(folder, existing, 'taken'), /EEXIST/);
    assert.equal(await readFile(existing, 'utf8'), 'keep me');
    assert.equal(await readFile(`${existing}.partial`, 'utf8'), 'not ours');
    await packTar(folder, join(dir, 'fresh.tar'), 'fresh');
    assert.equal(await readFile(join(dir, 'fresh.tar.partial'), 'utf8'), 'not ours either');
    // This run's own staging files are gone, whether it failed or succeeded.
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.partial'));
    assert.deepEqual(leftovers.sort(), ['fresh.tar.partial', 'taken.tar.partial']);
    for (const unsafe of ['..', '.', 'a/b', 'CON']) await assert.rejects(packTar(folder, join(dir, 'x.tar'), unsafe), /Invalid archive path/);
    await assert.rejects(runCommand({ databaseUrl: 'postgres://localhost/x', workspace: 'w', uploads: dir, out: join(dir, '..tar'),
      folder: false, scope: { kind: 'workspace' }, workspaceKeyFile: null }), UsageError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the command exits 2 on a usage error, 1 on a failed export, and never prints a URL it was given', () => {
  const script = join(import.meta.dirname, '..', 'src', 'scripts', 'export-workspace.ts');
  const run = (args: string[], databaseUrl: string) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args],
    { encoding: 'utf8', cwd: join(import.meta.dirname, '..'), env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 60_000 });
  const secret = 'postgres://exporter:SECRETPASSWORD@127.0.0.1:1/nowhere';
  const usage = run(['--workspace', 'w', '--uploads', '.', '--out', 'x.tar', '--whole-workspace', secret], secret);
  assert.equal(usage.status, 2, usage.stderr);
  assert.ok(!`${usage.stdout}${usage.stderr}`.includes('SECRETPASSWORD'));
  const failed = run(['--workspace', 'w', '--uploads', '.', '--out', join(tmpdir(), `deft-export-${Date.now()}.tar`), '--whole-workspace'], secret);
  assert.equal(failed.status, 1, failed.stderr);
  assert.ok(!`${failed.stdout}${failed.stderr}`.includes('SECRETPASSWORD'));
});
