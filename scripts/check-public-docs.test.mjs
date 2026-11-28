import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const checker = fileURLToPath(new URL('./check-public-docs.mjs', import.meta.url));

// Runs the real checker against a disposable docs tree so repository screenshots are never touched.
function check(files) {
  const dir = mkdtempSync(join(tmpdir(), 'deft-docs-check-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    return spawnSync(process.execPath, [checker, 'README.md'], { cwd: dir, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a README image that exists locally passes', () => {
  const result = check({
    'README.md': '![A live workspace](docs/assets/repository/dashboard.png)\n',
    'docs/assets/repository/dashboard.png': 'fixture',
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Public docs checks passed/);
});

test('a missing or renamed README image fails and names the README and the path', () => {
  const result = check({
    'README.md': '![A live workspace](docs/assets/repository/dashboard.png)\n',
    'docs/assets/repository/dashboard-renamed.png': 'fixture',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /README\.md: missing target docs\/assets\/repository\/dashboard\.png/);
});

test('a missing image nested inside a badge-style link still fails', () => {
  const result = check({ 'README.md': '[![Badge](docs/assets/badge.svg)](https://example.com)\n' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /README\.md: missing target docs\/assets\/badge\.svg/);
});
