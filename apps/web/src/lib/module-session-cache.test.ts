import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isAppCacheKey } from '@/hooks/use-apps';
import { isModuleCacheKey, isModuleTaskCacheKey } from '@/hooks/use-modules';
import { setActiveSessionCacheScope } from './session-cache';
import {
  moduleSessionPostCacheKey,
  moduleSessionReadCacheKey,
  moduleSessionRequestPath,
} from './module-session-cache';

const OLD_SCOPE = 'org-a:user-a:session-a:1';
const NEW_SCOPE = 'org-b:user-b:session-b:2';

test('CRM read consumers cannot resolve data cached by a replaced session', () => {
  const reads = [
    '/api/modules/contacts/duplicates?collection_key=contacts&match_field=email',
    '/api/modules/contacts/task-queue?bucket=due&assignee=all',
    '/api/modules/contacts/records/contact-1/merge-history?offset=0',
    '/api/modules/contacts/records/contact-1/tasks?limit=25&offset=0',
  ];
  const cache = new Map<string, unknown>();

  for (const path of reads) {
    const oldKey = moduleSessionReadCacheKey(OLD_SCOPE, path);
    const replacementKey = moduleSessionReadCacheKey(NEW_SCOPE, path);
    assert.ok(oldKey && replacementKey);
    cache.set(oldKey, { private: path });
    assert.equal(cache.get(replacementKey), undefined);
    assert.equal(moduleSessionRequestPath(replacementKey), path);
    assert.equal(moduleSessionReadCacheKey(null, path), null);
  }
});

test('CRM POST-backed reads isolate session data while preserving the API request path', () => {
  const reads = [
    { path: '/api/modules/contacts/merge/preview', input: { source_record_id: 'a', target_record_id: 'b' } },
    { path: '/api/modules/contacts/records/next-tasks', input: { record_ids: ['contact-1'] } },
    { path: '/api/modules/contacts/records/summary', input: { collection_key: 'deals', group_field: 'stage' } },
    { path: '/api/app-runs/record-history', input: { resource_ref: 'module:contacts:contact-1' } },
  ];
  const cache = new Map<string, unknown>();

  for (const read of reads) {
    const oldKey = moduleSessionPostCacheKey(OLD_SCOPE, read.path, read.input);
    const replacementKey = moduleSessionPostCacheKey(NEW_SCOPE, read.path, read.input);
    assert.ok(oldKey && replacementKey);
    cache.set(oldKey, { private: read.input });
    assert.equal(cache.get(replacementKey), undefined);
    assert.equal(moduleSessionRequestPath(replacementKey), read.path);
    assert.equal(moduleSessionPostCacheKey(null, read.path, read.input), null);
  }
});

test('every CRM SWR consumer wires its key through the authenticated session scope', () => {
  const consumers = [
    '../components/modules/module-app-run-history.tsx',
    '../components/modules/module-duplicate-review.tsx',
    '../components/modules/module-followup-queue.tsx',
    '../components/modules/module-merge-history.tsx',
    '../components/modules/module-merge-review.tsx',
    '../components/modules/module-record-next-task.tsx',
    '../components/modules/module-record-summary.tsx',
    '../components/modules/module-record-task-links.tsx',
  ];
  for (const relativePath of consumers) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /const \{ sessionCacheScope \} = useAuth\(\)/u, relativePath);
    assert.match(source, /moduleSession(?:Read|Post)CacheKey\(sessionCacheScope,/u, relativePath);
  }
});

test('module and App invalidation recognize scoped POST keys but reject stale sessions', () => {
  const summary = moduleSessionPostCacheKey(OLD_SCOPE, '/api/modules/contacts/records/summary', { group_field: 'stage' });
  const nextTasks = moduleSessionPostCacheKey(OLD_SCOPE, '/api/modules/contacts/records/next-tasks', { record_ids: ['contact-1'] });
  const appHistory = moduleSessionPostCacheKey(OLD_SCOPE, '/api/app-runs/record-history', { resource_ref: 'module:contacts:contact-1' });
  assert.ok(summary && nextTasks && appHistory);
  try {
    setActiveSessionCacheScope(OLD_SCOPE);
    assert.equal(isModuleCacheKey(summary, 'contacts'), true);
    assert.equal(isModuleTaskCacheKey(nextTasks, 'contacts'), true);
    assert.equal(isAppCacheKey(appHistory), true);

    setActiveSessionCacheScope(NEW_SCOPE);
    assert.equal(isModuleCacheKey(summary, 'contacts'), false);
    assert.equal(isModuleTaskCacheKey(nextTasks, 'contacts'), false);
    assert.equal(isAppCacheKey(appHistory), false);

    setActiveSessionCacheScope(null);
    assert.equal(isModuleCacheKey(summary, 'contacts'), false);
    assert.equal(isModuleTaskCacheKey(nextTasks, 'contacts'), false);
    assert.equal(isAppCacheKey(appHistory), false);
  } finally {
    setActiveSessionCacheScope(null);
  }
});
