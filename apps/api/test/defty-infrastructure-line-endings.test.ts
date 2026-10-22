import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'deft-line-endings-'));
const checkout = join(temporaryDirectory, 'checkout');
let checkoutEnvironment: NodeJS.ProcessEnv;

function git(args: string[], cwd = root, env = process.env, input?: string): string {
  return execFileSync('git', args, {
    cwd, env, input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
}

before(() => {
  mkdirSync(checkout);
  const objects = git(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim();
  const revision = git(['rev-parse', 'HEAD']).trim();
  // Share source objects read-only, with an independent repository and index.
  // Overlay working attributes so this verifies an uncommitted fix too.
  checkoutEnvironment = { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
  git(['init', '--quiet'], checkout, checkoutEnvironment);
  git(['read-tree', revision], checkout, checkoutEnvironment);
  const attributes = readFileSync(join(root, '.gitattributes'), 'utf8');
  const blob = git(['hash-object', '-w', '--stdin'], checkout, checkoutEnvironment, attributes).trim();
  git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',.gitattributes'], checkout, checkoutEnvironment);
  const files = git(['ls-files', '-z', '--', 'packages/db'], checkout, checkoutEnvironment);
  git(['-c', 'core.autocrlf=true', 'checkout-index', '--force', '--', '.gitattributes'], checkout, checkoutEnvironment);
  git(['-c', 'core.autocrlf=true', 'checkout-index', '--force', '-z', '--stdin'], checkout, checkoutEnvironment, files);
});

after(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function attributesFor(file: string): Record<string, string> {
  const fields = git(['check-attr', '--cached', '-z', 'text', 'eol', '--', file], checkout, checkoutEnvironment).split('\0');
  const attributes: Record<string, string> = {};
  for (let index = 0; index + 2 < fields.length; index += 3) {
    attributes[fields[index + 1]!] = fields[index + 2]!;
  }
  return attributes;
}

test('fresh SQL and LF lineage artifacts are pinned for current and future checkouts', () => {
  const files = [
    ...git(['ls-files', '-z', '--', 'packages/db/scripts/*.sql'], checkout, checkoutEnvironment).split('\0').filter(Boolean),
    'packages/db/scripts/future-fresh-contract.sql',
    'packages/db/upgrades/lineages/supported-histories.json',
    'packages/db/upgrades/lineages/canonical-preview1-schema118.json',
    'packages/db/upgrades/lineages/upgrade128-functions.json',
    'packages/db/upgrades/lineages/upgrade130-functions.json',
    'packages/db/upgrades/lineages/upgrade131-functions.json',
    'packages/db/upgrades/lineages/public61/raw-git/manifest.ts',
  ];
  for (const file of files) {
    assert.deepEqual(attributesFor(file), { text: 'set', eol: 'lf' }, file);
  }
});

test('fresh contract SQL keeps its sealed SHA-256 in an autocrlf checkout', () => {
  const scriptDirectory = join(checkout, 'packages/db/scripts');
  const source = readFileSync(join(scriptDirectory, 'fresh-schema-contracts.mjs'), 'utf8');
  const expected = source.match(/const SQL_SHA256='([a-f0-9]{64})'/)?.[1];
  assert.ok(expected, 'fresh contract checksum pin exists');
  const sql = readFileSync(join(scriptDirectory, 'fresh-schema-contracts.sql'));
  assert.equal(createHash('sha256').update(sql).digest('hex'), expected);
});

test('reviewed lineage loaders preserve every sealed artifact in an autocrlf checkout', async () => {
  const serviceUrl = pathToFileURL(join(checkout, 'packages/db/scripts/lineage-convergence.mjs'));
  const { loadReviewedPlan, loadUpgrade128, loadUpgrade131 } = await import(serviceUrl.href);
  const plan = loadReviewedPlan();
  loadUpgrade128();
  loadUpgrade131();
  const fixture = plan.source_provenance.canonical_preview1_schema118;
  const raw = readFileSync(join(checkout, 'packages/db/upgrades', fixture.snapshot_fixture));
  assert.equal(createHash('sha256').update(raw).digest('hex'), fixture.snapshot_fixture_sha256);
  // Historical CRLF and mixed-byte files must keep their original checksums.
  for (const file of [
    'packages/db/upgrades/0.3.0-preview.53-app-private-state.sql',
    'packages/db/upgrades/lineages/public61/crlf-export/manifest.ts',
  ]) {
    assert.equal(attributesFor(file).text, 'unset', file);
  }
});