/**
 * Scheduled GitHub sync: the scan picks due connections of active members,
 * each connection syncs as its own workspace job, failures and rate limits
 * back off that connection only, and no two syncs of one connection overlap.
 *
 * Run: pnpm --filter @deft/api test test/github-sync-schedule.test.ts
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, orgs, users, orgMembers, connectedAccounts, events, projects, tasks, taskComments, taskActivity } from '@deft/db';
import { encrypt } from '../src/lib/encryption.js';
import { syncGitHubForUser } from '../src/workers/github-sync.js';
import {
  githubSyncIntervalMs,
  handleGitHubSyncScan,
  handleGitHubSyncConnection,
  GITHUB_SYNC_CONNECTION_JOB,
} from '../src/workers/handlers/github-sync-schedule.js';

const stamp = `gss${Date.now().toString(36)}`;
const PREFIX = `GSS${Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')}`;
const ids = () => crypto.randomUUID();
const org = { a: ids(), b: ids() };
const user = { a: ids(), b: ids(), c: ids() };
const acct = { a: ids(), b: ids(), c: ids() };
const project = { a: ids(), b: ids() };
const task = { a: ids(), b: ids() };
const allAccts = [acct.a, acct.b, acct.c];

/** Per-token GitHub behaviour. */
const behaviour: Record<string, 'ok' | 'unauthorized' | 'rate_limited' | 'pulls_fail' | 'throws'> = {};
const calls: string[] = [];
let resetAt = 0;
let holdFirstCall: (() => Promise<void>) | null = null;

function repoFor(token: string) { return `acme/${stamp}-${token}`; }

before(async () => {
  process.env.DEFT_GITHUB_SYNC_INTERVAL_MIN = '10';
  await db.insert(orgs).values([
    { id: org.a, name: `${stamp}-a`, slug: `${stamp}-a` },
    { id: org.b, name: `${stamp}-b`, slug: `${stamp}-b` },
  ]);
  await db.insert(users).values([
    { id: user.a, email: `${stamp}-a@t.local`, name: 'a' },
    { id: user.b, email: `${stamp}-b@t.local`, name: 'b' },
    { id: user.c, email: `${stamp}-c@t.local`, name: 'c' },
  ]);
  await db.insert(orgMembers).values([
    { id: ids(), org_id: org.a, user_id: user.a, role: 'owner' },
    { id: ids(), org_id: org.b, user_id: user.b, role: 'owner' },
    { id: ids(), org_id: org.a, user_id: user.c, role: 'member', is_active: false },
  ] as any);
  await db.insert(connectedAccounts).values([
    { id: acct.a, org_id: org.a, user_id: user.a, provider: 'github', access_token_encrypted: encrypt('tok-a') },
    { id: acct.b, org_id: org.b, user_id: user.b, provider: 'github', access_token_encrypted: encrypt('tok-b') },
    { id: acct.c, org_id: org.a, user_id: user.c, provider: 'github', access_token_encrypted: encrypt('tok-c') },
  ] as any);
  for (const k of ['a', 'b'] as const) {
    await db.insert(projects).values({ id: project[k], org_id: org[k], name: `${stamp}-${k}`, prefix: PREFIX, created_by: user[k] } as any);
    await db.insert(tasks).values({ id: task[k], org_id: org[k], project_id: project[k], number: 1, title: `${stamp} ${k}`, status: 'todo', created_by: user[k] } as any);
  }

  mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    const token = auth.replace('token ', '');
    calls.push(token);
    if (holdFirstCall) { const h = holdFirstCall; holdFirstCall = null; await h(); }
    const mode = behaviour[token] ?? 'ok';
    if (mode === 'unauthorized') return new Response('{}', { status: 401 });
    if (mode === 'throws') throw new TypeError(`invalid header value: token ${token}`);
    if (mode === 'rate_limited') {
      return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) } });
    }
    const href = String(url);
    if (href.includes('/user/repos')) return new Response(JSON.stringify([{ full_name: repoFor(token) }]));
    if (href.includes('/pulls')) {
      if (mode === 'pulls_fail') return new Response('{}', { status: 500 });
      const now = new Date().toISOString();
      return new Response(JSON.stringify([{
        number: 7, title: `Fix ${PREFIX}-1`, body: null, html_url: 'https://example.invalid/pr/7',
        state: 'closed', merged_at: now, user: { login: 'dev' }, created_at: now, updated_at: now,
      }]));
    }
    return new Response('[]', { status: 404 });
  });
});

after(async () => {
  mock.restoreAll();
  await db.execute(sql`DELETE FROM job_queue WHERE name = ${GITHUB_SYNC_CONNECTION_JOB} AND org_id IN (${org.a}, ${org.b})`);
  await db.delete(taskComments).where(inArray(taskComments.org_id, [org.a, org.b]));
  await db.delete(taskActivity).where(inArray(taskActivity.task_id, [task.a, task.b]));
  await db.delete(events).where(inArray(events.org_id, [org.a, org.b]));
  await db.delete(tasks).where(inArray(tasks.id, [task.a, task.b]));
  await db.delete(projects).where(inArray(projects.id, [project.a, project.b]));
  await db.delete(connectedAccounts).where(inArray(connectedAccounts.id, allAccts));
  await db.delete(orgMembers).where(inArray(orgMembers.org_id, [org.a, org.b]));
  await db.delete(users).where(inArray(users.id, [user.a, user.b, user.c]));
  await db.delete(orgs).where(inArray(orgs.id, [org.a, org.b]));
});

beforeEach(async () => {
  calls.length = 0;
  for (const k of Object.keys(behaviour)) delete behaviour[k];
  process.env.DEFT_GITHUB_SYNC_INTERVAL_MIN = '10';
  // Every connection due; no queued jobs left over.
  await db.update(connectedAccounts).set({ last_sync_at: null, sync_error: null, metadata: null } as any)
    .where(inArray(connectedAccounts.id, allAccts));
  await db.execute(sql`DELETE FROM job_queue WHERE name = ${GITHUB_SYNC_CONNECTION_JOB} AND org_id IN (${org.a}, ${org.b})`);
});

type Queued = { id: string; org_id: string | null; data: Record<string, any>; max_attempts: number };
async function queuedJobs(): Promise<Queued[]> {
  const res = await db.execute(sql`
    SELECT id, org_id, data, max_attempts FROM job_queue
    WHERE name = ${GITHUB_SYNC_CONNECTION_JOB} AND org_id IN (${org.a}, ${org.b}) AND status = 'pending'`);
  return ((res as any).rows ?? res) as Queued[];
}

/** One scheduled tick: scan, then run every job it queued for our workspaces. */
async function tick(): Promise<Queued[]> {
  await scan();
  const jobs = await queuedJobs();
  for (const j of jobs) {
    await handleGitHubSyncConnection({ id: j.id, name: GITHUB_SYNC_CONNECTION_JOB, data: j.data, attempts: 1, orgId: j.org_id });
    await db.execute(sql`DELETE FROM job_queue WHERE id = ${j.id}`);
  }
  return jobs;
}

const runJob = (data: Record<string, unknown>, orgId?: string) =>
  handleGitHubSyncConnection({ id: ids(), name: GITHUB_SYNC_CONNECTION_JOB, data, attempts: 1, orgId });
const scan = () => handleGitHubSyncScan({ id: ids(), name: 'github-sync-scan', data: {}, attempts: 1 });

async function account(id: string) {
  const [row] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, id));
  return row!;
}
const nextAt = (row: { metadata: unknown }) => new Date(String((row.metadata as any)?.github_sync?.next_at)).getTime();

test('interval: default 10 minutes, 0 or off disables', () => {
  delete process.env.DEFT_GITHUB_SYNC_INTERVAL_MIN;
  assert.equal(githubSyncIntervalMs(), 10 * 60_000);
  for (const off of ['0', 'off', 'OFF', '-3', 'soon']) {
    process.env.DEFT_GITHUB_SYNC_INTERVAL_MIN = off;
    assert.equal(githubSyncIntervalMs(), 0, off);
  }
  process.env.DEFT_GITHUB_SYNC_INTERVAL_MIN = '15';
  assert.equal(githubSyncIntervalMs(), 15 * 60_000);
});

test('one tick syncs each workspace in its own workspace and closes its referenced task once', async () => {
  const jobs = await tick();
  const mine = jobs.filter((j) => allAccts.includes(j.data.connection_id));
  assert.deepEqual(mine.map((j) => j.data.connection_id).sort(), [acct.a, acct.b].sort());
  for (const j of mine) {
    assert.equal(j.org_id, j.data.org_id);
    assert.equal(j.max_attempts, 1);
    assert.deepEqual(Object.keys(j.data).sort(), ['connection_id', 'org_id']);
  }
  for (const k of ['a', 'b'] as const) {
    const evs = await db.select({ external_id: events.external_id, org_id: events.org_id }).from(events)
      .where(and(eq(events.org_id, org[k]), eq(events.source, 'github')));
    assert.deepEqual(evs.map((e) => e.external_id), [`gh-pr:${org[k]}:${repoFor(`tok-${k}`)}#7`]);
    const [t] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, task[k]));
    assert.equal(t!.status, 'done');
    const row = await account(acct[k]);
    assert.ok(row.last_sync_at);
    assert.equal(row.sync_error, null);
  }
  // Seen again by the scheduled path: no second close.
  await db.update(connectedAccounts).set({ last_sync_at: null, metadata: null } as any).where(eq(connectedAccounts.id, acct.a));
  await tick();
  const comments = await db.select({ id: taskComments.id }).from(taskComments).where(eq(taskComments.task_id, task.a));
  assert.equal(comments.length, 1);
});

test('a failing connection is recorded and backed off, and the next one still syncs', async () => {
  behaviour['tok-a'] = 'unauthorized';
  const before = Date.now();
  await tick();
  const a = await account(acct.a);
  const b = await account(acct.b);
  assert.match(String(a.sync_error), /401/);
  assert.equal((a.metadata as any).github_sync.failures, 1);
  assert.ok(nextAt(a) >= before + 2 * 9 * 60_000, 'first failure waits about twice the interval');
  assert.equal(b.sync_error, null);
  assert.ok(b.last_sync_at);
  // Not due on the next tick.
  calls.length = 0;
  await tick();
  assert.ok(!calls.includes('tok-a'));
});

test('a repository that cannot be read counts as a failed scheduled run', async () => {
  behaviour['tok-a'] = 'pulls_fail';
  await tick();
  const a = await account(acct.a);
  assert.equal((a.metadata as any).github_sync.failures, 1);
});

test('a stored error never carries the request text', async () => {
  behaviour['tok-a'] = 'throws';
  await tick();
  const a = await account(acct.a);
  assert.equal(a.sync_error, 'GitHub sync failed');
  assert.equal((a.metadata as any).github_sync.failures, 1);
});

test('a rate limit seen by a manual sync holds back the schedule', async () => {
  behaviour['tok-a'] = 'rate_limited';
  resetAt = Math.floor(Date.now() / 1000) + 30 * 60;
  await syncGitHubForUser(acct.a);
  delete behaviour['tok-a'];
  calls.length = 0;
  // Even a job queued before the cooldown does not call GitHub.
  await runJob({ org_id: org.a, connection_id: acct.a }, org.a);
  const jobs = await tick();
  assert.ok(!jobs.some((j) => j.data.connection_id === acct.a));
  assert.ok(!calls.includes('tok-a'));
});

test('a rate-limited connection waits for the reset time', async () => {
  behaviour['tok-a'] = 'rate_limited';
  resetAt = Math.floor(Date.now() / 1000) + 50 * 60;
  await tick();
  const a = await account(acct.a);
  assert.ok(nextAt(a) >= resetAt * 1000 - 5_000);
  assert.ok((await account(acct.b)).last_sync_at);
});

test('the schedule disabled queues nothing and runs nothing already queued', async () => {
  await scan();
  const queued = await queuedJobs();
  assert.ok(queued.length > 0);
  for (const off of ['0', 'off']) {
    process.env.DEFT_GITHUB_SYNC_INTERVAL_MIN = off;
    await db.update(connectedAccounts).set({ metadata: null } as any).where(inArray(connectedAccounts.id, allAccts));
    await scan();
    assert.equal((await queuedJobs()).length, queued.length);
    for (const j of queued) {
      await handleGitHubSyncConnection({ id: j.id, name: GITHUB_SYNC_CONNECTION_JOB, data: j.data, attempts: 1, orgId: j.org_id });
    }
  }
  assert.deepEqual(calls, []);
});

test('an inactive owner\'s connection is neither scanned nor synced by a job', async () => {
  const jobs = await tick();
  assert.ok(!jobs.some((j) => j.data.connection_id === acct.c));
  await runJob({ org_id: org.a, connection_id: acct.c }, org.a);
  assert.ok(!calls.includes('tok-c'));
  assert.equal((await account(acct.c)).last_sync_at, null);
});

test('a job whose workspace does not match the connection is refused', async () => {
  await runJob({ org_id: org.b, connection_id: acct.a }, org.b);
  await runJob({ org_id: org.a, connection_id: acct.a }, org.b);
  await runJob({ connection_id: acct.a });
  assert.deepEqual(calls, []);
  assert.equal((await account(acct.a)).last_sync_at, null);
});

test('a scheduled sync and a manual sync of one connection never overlap', async () => {
  // A manual sync is running when the scheduled job for the same connection starts.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  holdFirstCall = async () => { entered(); await gate; };
  const manual = syncGitHubForUser(acct.a);
  await inside;
  const held = (await account(acct.a)).metadata;
  await runJob({ org_id: org.a, connection_id: acct.a }, org.a);
  // And a second manual sync is refused while the first runs.
  const second = await syncGitHubForUser(acct.a) as { error?: string };
  assert.match(String(second.error), /already running/);
  assert.equal(calls.filter((c) => c === 'tok-a').length, 1);
  // Losing the race is not a failure: the schedule state is untouched.
  assert.deepEqual((await account(acct.a)).metadata, held);
  release();
  assert.equal(((await manual) as { error?: string }).error, undefined);
  // The lease is released: the next sync runs.
  assert.equal(((await syncGitHubForUser(acct.a)) as { error?: string }).error, undefined);
});
