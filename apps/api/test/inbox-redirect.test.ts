// apps/api/test/inbox-redirect.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '..', '..', '..');

test('inbox page exists', () => {
  const p = resolve(ROOT, 'apps/web/src/app/(app)/inbox/page.tsx');
  assert.ok(existsSync(p), `expected ${p} to exist`);
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes('useInbox'), 'page should consume useInbox hook');
});

test('approvals page is a redirect, not a full inbox', () => {
  const p = resolve(ROOT, 'apps/web/src/app/(app)/approvals/page.tsx');
  assert.ok(existsSync(p), 'approvals page must still exist as a redirect shim');
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes('/inbox?tab=approvals'), 'should redirect to inbox tab');
  assert.ok(src.includes('redirect('), 'should call next/navigation redirect()');
  assert.ok(!src.includes('AgentActionCard'), 'should NOT render approval cards anymore');
});

test('inbox row component exists', () => {
  const p = resolve(ROOT, 'apps/web/src/components/inbox-row.tsx');
  assert.ok(existsSync(p));
});

test('inbox hook exists', () => {
  const p = resolve(ROOT, 'apps/web/src/hooks/use-inbox.ts');
  assert.ok(existsSync(p));
});

test('inbox count hook exists', () => {
  const p = resolve(ROOT, 'apps/web/src/hooks/use-inbox-count.ts');
  assert.ok(existsSync(p));
});

test('sidebar uses Inbox not Approvals', () => {
  const p = resolve(ROOT, 'apps/web/src/components/sidebar.tsx');
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes("name: 'Inbox'"), "sidebar should declare Inbox nav entry");
  assert.ok(src.includes("href: '/inbox'"), "sidebar should point to /inbox");
  assert.ok(!src.match(/name:\s*'Approvals'/), 'sidebar should NOT have Approvals nav entry');
  assert.ok(src.includes('useInboxCount'), 'sidebar should use useInboxCount badge hook');
});
