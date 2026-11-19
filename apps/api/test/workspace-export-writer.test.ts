import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    const file = new ArchiveFile('data/x.jsonl', 'unused-x', failing, async () => undefined);
    await file.write('first line\n');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(file.write('second line\n'), /ENOSPC/);
    await assert.rejects(new ArchiveFile('data/y.jsonl', 'unused-y', failing, async () => undefined).close(), /ENOSPC|closed|destroyed/);
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

test('attachment names in the archive are always storable, even after shortening or when they spell a device', async () => {
  const { archiveFileName } = await import('../src/lib/workspace-export/attachments.js');
  for (const filename of [`${'a'.repeat(149)}.${'b'.repeat(20)}`, 'COM¹.txt', 'con', 'NUL.tar.gz', 'name. ', '...', '', 'a/b\c:d', `${'é'.repeat(300)}.pdf`]) {
    const path = archiveFileName('f1', filename);
    assertArchivePath(path);
    assert.ok(path.startsWith('attachments/f1/'), path);
  }
  assert.equal(archiveFileName('f1', 'Report final.pdf'), 'attachments/f1/Report final.pdf');
});

test('the writer never deletes or replaces a file it did not create', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-export-owned-'));
  try {
    const writer = await ArchiveWriter.create(join(dir, 'out'));
    // Someone else creates a file at a path the export is about to write.
    await mkdir(join(dir, 'out', 'attachments', 'f1'), { recursive: true });
    await writeFile(join(dir, 'out', 'attachments', 'f1', 'a.txt'), 'theirs');
    await assert.rejects(writer.open('attachments/f1/a.txt'), /EEXIST/);
    assert.equal(await readFile(join(dir, 'out', 'attachments', 'f1', 'a.txt'), 'utf8'), 'theirs');
    // And a SHA256SUMS appears before the export publishes its own.
    await writer.writeText('README.txt', 'hello');
    await writeFile(join(dir, 'out', 'SHA256SUMS'), 'theirs too');
    await assert.rejects(writer.finish(async () => writer.writeJson('manifest.json', {})), /EEXIST/);
    assert.equal(await readFile(join(dir, 'out', 'SHA256SUMS'), 'utf8'), 'theirs too');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const longNames = {
  cjk: `${'報告書の最終版'.repeat(43)}.pdf`,
  korean: `${'최종보고서'.repeat(60)}.docx`,
  accents: `${'é'.repeat(300)}.txt`,
  emoji: `${'👨‍👩‍👧‍👦'.repeat(20)}.png`,
  combining: `a${'́'.repeat(500)}.txt`,
  loneSurrogate: 'a\uD800b.txt',
};

test('a long attachment name is cut in bytes, at a whole character, keeping its extension', async () => {
  const { archiveFileName, MAX_NAME_BYTES } = await import('../src/lib/workspace-export/attachments.js');
  const nameOf = (filename: string) => archiveFileName('f1', filename).slice('attachments/f1/'.length);
  for (const [label, filename] of Object.entries(longNames)) {
    const name = nameOf(filename);
    assert.ok(Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES + 1, `${label}: ${Buffer.byteLength(name, 'utf8')} bytes`);
    assert.ok(!name.includes('�') && !/\p{Cs}/u.test(name), `${label}: no replacement character or lone surrogate`);
    assert.equal(Buffer.from(name, 'utf8').toString('utf8'), name, `${label}: survives UTF-8 unchanged`);
  }
  const cjk = nameOf(longNames.cjk);
  assert.ok(cjk.endsWith('.pdf') && longNames.cjk.startsWith(cjk.slice(0, -4)), cjk);
  // Whole family emoji only: never a part of the joined sequence.
  const emoji = nameOf(longNames.emoji);
  assert.match(emoji, /^(?:👨‍👩‍👧‍👦)+\.png$/u);
  // One character too long to keep at all gives way to a plain name.
  assert.equal(nameOf(longNames.combining), 'file.txt');
  assert.equal(nameOf(longNames.loneSurrogate), 'a_b.txt');
  // A hashed folder can never be the folder of another id.
  assert.match(archiveFileName('not a plain id', 'x.txt'), /^attachments\/h\.[0-9a-f]{64}\/x\.txt$/);
});

test('long multi-byte attachment names are really written on this file system', async () => {
  const { archiveFileName, plainArchiveFileName } = await import('../src/lib/workspace-export/attachments.js');
  const dir = await mkdtemp(join(tmpdir(), 'deft-export-names-'));
  try {
    const writer = await ArchiveWriter.create(join(dir, 'out'));
    let index = 0;
    for (const filename of Object.values(longNames)) {
      for (const path of [archiveFileName(`f${++index}`, filename), plainArchiveFileName(`p${index}`, filename)]) {
        const file = await writer.open(path);
        await file.write('bytes');
        await file.close();
        assert.equal(await readFile(join(dir, 'out', ...path.split('/')), 'utf8'), 'bytes');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
