/**
 * GitHub polling sync keeps each workspace's pull-request events in that
 * workspace, and closes each workspace's referenced tasks on merge, when two
 * workspaces sync the same repository.
 *
 * Run: pnpm --filter @deft/api test test/github-sync-org-scope.test.ts
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, orgs, users, orgMembers, connectedAccounts, events, projects, tasks, taskComments, taskActivity } from '@deft/db';
import { encrypt } from '../src/lib/encryption.js';
import { syncGitHubForUser } from '../src/workers/github-sync.js';

const stamp = `gs${Date.now().toString(36)}`;
const REPO = `acme/${stamp}`;
const PREFIX = `GS${Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`;
const orgA = crypto.randomUUID();
const orgB = crypto.randomUUID();
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();
const accountA = crypto.randomUUID();
const accountB = crypto.randomUUID();
const taskIds = { a: crypto.randomUUID(), b: crypto.randomUUID() };
const projectIds = { a: crypto.randomUUID(), b: crypto.randomUUID() };

let prState: 'open' | 'merged' = 'open';

before(async () => {
  await db.insert(orgs).values([
    { id: orgA, name: `${stamp}-a`, slug: `${stamp}-a` },
    { id: orgB, name: `${stamp}-b`, slug: `${stamp}-b` },
  ]);
  await db.insert(users).values([
    { id: userA, email: `${stamp}-a@t.local`, name: 'a' },
    { id: userB, email: `${stamp}-b@t.local`, name: 'b' },
  ]);
  await db.insert(orgMembers).values([
    { id: crypto.randomUUID(), org_id: orgA, user_id: userA, role: 'owner' },
    { id: crypto.randomUUID(), org_id: orgB, user_id: userB, role: 'owner' },
  ] as any);
  await db.insert(connectedAccounts).values([
    { id: accountA, org_id: orgA, user_id: userA, provider: 'github', access_token_encrypted: encrypt('token-a') },
    { id: accountB, org_id: orgB, user_id: userB, provider: 'github', access_token_encrypted: encrypt('token-b') },
  ] as any);
  // The same project prefix and task number exist in both workspaces.
  for (const [key, org, user] of [['a', orgA, userA], ['b', orgB, userB]] as const) {
    await db.insert(projects).values({ id: projectIds[key], org_id: org, name: `${stamp}-${key}`, prefix: PREFIX, created_by: user } as any);
    await db.insert(tasks).values({
      id: taskIds[key], org_id: org, project_id: projectIds[key], number: 1, title: `${stamp} ${key}`, status: 'todo', created_by: user,
    } as any);
  }

  mock.method(globalThis, 'fetch', async (url: string | URL) => {
    const href = String(url);
    if (href.includes('/user/repos')) return new Response(JSON.stringify([{ full_name: REPO }]));
    if (href.includes(`/repos/${REPO}/pulls`)) {
      return new Response(JSON.stringify([{
        number: 7, title: `Fix ${PREFIX}-1`, body: null, html_url: 'https://example.invalid/pr/7',
        state: prState === 'merged' ? 'closed' : 'open', merged_at: prState === 'merged' ? new Date().toISOString() : null,
        user: { login: 'dev' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }]));
    }
    return new Response('[]', { status: 404 });
  });
});

after(async () => {
  mock.restoreAll();
  await db.delete(taskComments).where(inArray(taskComments.org_id, [orgA, orgB]));
  await db.delete(taskActivity).where(inArray(taskActivity.task_id, [taskIds.a, taskIds.b]));
  await db.delete(events).where(inArray(events.org_id, [orgA, orgB]));
  await db.delete(tasks).where(inArray(tasks.id, [taskIds.a, taskIds.b]));
  await db.delete(projects).where(inArray(projects.id, [projectIds.a, projectIds.b]));
  await db.delete(connectedAccounts).where(inArray(connectedAccounts.id, [accountA, accountB]));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, [orgA, orgB]));
  await db.delete(users).where(inArray(users.id, [userA, userB]));
  await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));
});

async function prEvents(org: string) {
  return db.select({ id: events.id, event_type: events.event_type }).from(events)
    .where(and(eq(events.org_id, org), eq(events.source, 'github')));
}

test('each workspace syncing the same repository keeps its own pull-request event', async () => {
  await syncGitHubForUser(accountA);
  await syncGitHubForUser(accountB);
  const [a, b] = [await prEvents(orgA), await prEvents(orgB)];
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0]!.id, b[0]!.id);
});

test('a merged pull request closes the referenced task in each syncing workspace', async () => {
  prState = 'merged';
  await syncGitHubForUser(accountA);
  await syncGitHubForUser(accountB);
  const rows = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, [taskIds.a, taskIds.b]));
  assert.deepEqual(rows.map((r) => r.status).sort(), ['done', 'done']);
  assert.equal((await prEvents(orgA))[0]!.event_type, 'pr_merged');
  assert.equal((await prEvents(orgB))[0]!.event_type, 'pr_merged');
});
