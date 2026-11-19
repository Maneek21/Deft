import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { packTar } from '../src/lib/workspace-export/tar.js';
import { UsageError, parseCommand } from '../src/scripts/export-workspace.js';

/** The operating system's own tar (Windows ships bsdtar as tar.exe; a Git Bash tar on PATH reads C: as a host). */
const systemTar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const env = { DATABASE_URL: 'postgres://localhost/x' };
const base = ['--workspace', 'w', '--uploads', 'u', '--out', 'x.tar'];

test('the command needs exactly one scope, and the whole workspace only by its explicit flag', () => {
  assert.throws(() => parseCommand(base, env), UsageError);
  assert.throws(() => parseCommand([...base, '--whole-workspace', '--member', 'a@example.test'], env), UsageError);
  assert.deepEqual(parseCommand([...base, '--member', 'a@example.test'], env).scope, { kind: 'member', member: 'a@example.test' });
  assert.deepEqual(parseCommand([...base, '--whole-workspace'], env).scope, { kind: 'workspace' });
  assert.throws(() => parseCommand([...base, '--whole-workspace'], {}), /DATABASE_URL/);
  assert.throws(() => parseCommand(['--workspace', 'w', '--whole-workspace'], env), /required/);
  assert.throws(() => parseCommand([...base, '--whole-workspace', '--scope', 'all'], env));
});

test('the tar file extracts with the system tar to exactly the folder, long and non-ASCII names included', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-export-tar-'));
  try {
    const folder = join(dir, 'in');
    const longName = `${'Résumé-ünïcødé-'.repeat(12)}.txt`;
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
