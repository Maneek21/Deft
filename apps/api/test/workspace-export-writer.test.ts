import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { ArchiveFile, ArchiveWriter, assertArchivePath } from '../src/lib/workspace-export/writer.js';

test('archive paths cannot escape the folder or use names Windows cannot store', () => {
  for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a\\b', 'con:x', 'trailing.', 'tab\tname', '', 'a/./b',
    'CON', 'nul.txt', 'attachments/AUX.pdf', 'x/com1', 'LPT9.log', 'prn.tar.gz']) {
    assert.throws(() => assertArchivePath(bad), /Invalid archive path/, bad);
  }
  for (const good of ['data/spaces.jsonl', 'attachments/abc/Résumé final (2).pdf', 'conversations/x.html', 'console.txt', 'com10', 'nullable.json']) {
    assertArchivePath(good);
  }
});

test('a disk failure after a write was accepted rejects the next step instead of crashing the process', async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    // A stream that accepts each write, then fails it on the next turn, as a full disk does.
    const failing = new Writable({ highWaterMark: 1 << 20, write(_chunk, _encoding, callback) { setImmediate(() => callback(new Error('ENOSPC: no space left'))); } });
    const file = new ArchiveFile('data/x.jsonl', failing, async () => undefined);
    await file.write('first line\n');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(file.write('second line\n'), /ENOSPC/);
    await assert.rejects(new ArchiveFile('data/y.jsonl', failing, async () => undefined).close(), /ENOSPC|closed|destroyed/);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('an aborted export never publishes SHA256SUMS and releases its files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-export-abort-'));
  try {
    const writer = await ArchiveWriter.create(join(dir, 'out'));
    const open = await writer.open('data/partial.jsonl');
    await open.write('{"a":1}\n');
    await writer.abort();
    await assert.rejects(open.write('more'), /closed/);
    assert.deepEqual((await readdir(join(dir, 'out'))).filter((name) => name.startsWith('SHA256SUMS') && name !== 'SHA256SUMS.partial'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the writer refuses a non-empty folder and the reserved checksum names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-export-writer-'));
  try {
    await writeFile(join(dir, 'existing.txt'), 'x');
    await assert.rejects(ArchiveWriter.create(dir), /not empty/);
    const writer = await ArchiveWriter.create(join(dir, 'out'));
    await assert.rejects(writer.open('SHA256SUMS'), /Reserved/);
    await writer.writeText('a.txt', 'hello');
    await writer.omit({ kind: 'file', id: 'f1', reason: 'missing' });
    await writer.finish(async () => writer.writeJson('manifest.json', { omissions: writer.omissions }));
    const sums = await readFile(join(dir, 'out', 'SHA256SUMS'), 'utf8');
    assert.match(sums, /^[0-9a-f]{64} {2}omissions\.jsonl$/m);
    assert.match(sums, /^2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824 {2}a\.txt$/m);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'out', 'manifest.json'), 'utf8')), { omissions: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
