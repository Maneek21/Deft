import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ArchiveWriter, assertArchivePath } from '../src/lib/workspace-export/writer.js';

test('archive paths cannot escape the folder or use names Windows cannot store', () => {
  for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'a\\b', 'con:x', 'trailing.', 'tab\tname', '', 'a/./b']) {
    assert.throws(() => assertArchivePath(bad), /Invalid archive path/, bad);
  }
  for (const good of ['data/spaces.jsonl', 'attachments/abc/Résumé final (2).pdf', 'conversations/x.html']) assertArchivePath(good);
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
