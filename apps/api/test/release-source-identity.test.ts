import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { upgradeManifest } from '../../../packages/db/upgrades/manifest.js';

test('public source release and schema metadata match product and supported upgrade identities', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const product = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
  const source = readFileSync(resolve(root, 'apps/api/src/lib/agent-channel.ts'), 'utf8');
  const fallback = /DEFT_RELEASE_VERSION = process\.env\.DEFT_RELEASE_VERSION \|\| '([^']+)'/.exec(source)?.[1];
  const schemaHead = /DEFT_SCHEMA_HEAD = '([^']+)'/.exec(source)?.[1];
  assert.equal(fallback, product.version, 'Source-built health and agent handshake must identify this product candidate');
  assert.equal(schemaHead, upgradeManifest.migrations.at(-1)?.version, 'Public schema head must identify the supported current upgrade manifest');
});
