/**
 * Per-workspace limits on a hosted cell (apps/api/src/lib/workspace-limits.ts, launch check 6.6): the settings, the limit on
 * outside requests (link previews and calendar feeds), and the disk. No database (the scheduled-item caps are in
 * workspace-limits-db.test.ts).
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/workspace-limits.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { LocalFileStore } from '../src/lib/file-store.js';
import { fetchLinkPreview } from '../src/lib/link-preview.js';
import { fetchPublicHttpText, publicFetchDeps } from '../src/lib/public-http-fetch.js';
import { humanizeIcsError } from '../src/lib/ics.js';
import {
  DEFAULT_WORKSPACE_LIMITS,
  STORAGE_FREE_FLOOR_BYTES,
  WORKSPACE_LIMIT_SETTING_NAMES,
  WorkspaceLimitError,
  _setVolumeStatsForTest,
  _setWorkspaceLimitsForTest,
  assertStorageRoom,
  isDiskFullError,
  parseWorkspaceLimits,
  takeOutgoingRequest,
  validateWorkspaceLimitEnvironment,
  type WorkspaceLimits,
} from '../src/lib/workspace-limits.js';

const realLookup = publicFetchDeps.lookup;
const limits = (overrides: Partial<WorkspaceLimits> = {}): WorkspaceLimits => ({ ...DEFAULT_WORKSPACE_LIMITS, ...overrides });

afterEach(() => {
  _setWorkspaceLimitsForTest(undefined);
  _setVolumeStatsForTest(null);
  publicFetchDeps.lookup = realLookup;
});

test('the launch defaults, and every setting strict: a whole number in range or startup stops', () => {
  assert.deepEqual(DEFAULT_WORKSPACE_LIMITS, { outgoingPerMinute: 60, outgoingPerHour: 1_000, scheduledMessages: 500, reminders: 2_000, storagePercent: 90 });
  assert.deepEqual(parseWorkspaceLimits({}), { ok: true, limits: DEFAULT_WORKSPACE_LIMITS });
  assert.deepEqual(parseWorkspaceLimits({ DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE: '10', DEFT_HOSTED_LIMIT_STORAGE_PERCENT: '80' }),
    { ok: true, limits: limits({ outgoingPerMinute: 10, storagePercent: 80 }) });
  for (const name of WORKSPACE_LIMIT_SETTING_NAMES) {
    for (const bad of ['', ' 5', '5 ', '0', '-1', '1.5', '1e3', 'ten', '05', '99999999999']) {
      const parsed = parseWorkspaceLimits({ [name]: bad });
      assert.equal(parsed.ok, false, `${name}=${JSON.stringify(bad)}`);
      if (!parsed.ok) assert.match(parsed.problems[0] ?? '', new RegExp(`^${name} must be a whole number from [0-9]+ to [0-9]+$`), 'fixed text: the value is never printed');
      assert.throws(() => validateWorkspaceLimitEnvironment(true, { [name]: bad }), /Hosted workspace limits are invalid/);
      assert.doesNotThrow(() => validateWorkspaceLimitEnvironment(false, { [name]: bad }), 'self-hosted: not read (the hosted-only rule refuses it)');
    }
  }
  assert.equal(parseWorkspaceLimits({ DEFT_HOSTED_LIMIT_STORAGE_PERCENT: '100' }).ok, false);
  assert.equal(parseWorkspaceLimits({ DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE: '100', DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR: '50' }).ok, false);
});

test('outside requests: the minute limit, then the hour limit; a refusal says why, when, and is not counted', () => {
  _setWorkspaceLimitsForTest(limits({ outgoingPerMinute: 3, outgoingPerHour: 5 }));
  const t0 = 1_000_000_000;
  for (let i = 0; i < 3; i += 1) takeOutgoingRequest(t0 + i);
  assert.throws(() => takeOutgoingRequest(t0 + 10), (error: unknown) => {
    assert.ok(error instanceof WorkspaceLimitError);
    assert.equal(error.code, 'WORKSPACE_OUTGOING_LIMIT');
    assert.equal(error.status, 429);
    assert.equal(error.message, 'This workspace has made 3 outside requests in the last minute, its limit. Try again in a minute.');
    assert.equal(error.retryAfterSeconds, 60);
    return true;
  });
  // A minute later the minute window is free again; the hour still counts the three.
  takeOutgoingRequest(t0 + 60_001);
  takeOutgoingRequest(t0 + 60_002);
  assert.throws(() => takeOutgoingRequest(t0 + 60_003), (error: unknown) => error instanceof WorkspaceLimitError
    && /5 outside requests in the last hour, its limit\. Try again in 59 minutes\./.test(error.message));
  // An hour after the first, its place is free.
  takeOutgoingRequest(t0 + 60 * 60_000 + 1);
});

test('outside requests on a self-hosted install are never limited', () => {
  _setWorkspaceLimitsForTest(null);
  for (let i = 0; i < 5_000; i += 1) takeOutgoingRequest(1_000 + i);
});

test('past the limit a link preview is skipped before any lookup (chat goes on), and a feed is told to wait', async () => {
  _setWorkspaceLimitsForTest(limits({ outgoingPerMinute: 1, outgoingPerHour: 1 }));
  const lookups: string[] = [];
  publicFetchDeps.lookup = async (hostname: string) => {
    lookups.push(hostname);
    throw new Error('ENOTFOUND');
  };
  takeOutgoingRequest();
  assert.equal(await fetchLinkPreview('https://example.com/page'), null);
  await assert.rejects(fetchPublicHttpText('https://example.com/page', { maxBytes: 1024, timeoutMs: 1_000, accept: 'text/html', userAgent: 'test' }),
    (error: unknown) => error instanceof WorkspaceLimitError && error.code === 'WORKSPACE_OUTGOING_LIMIT');
  assert.deepEqual(lookups, [], 'nothing was looked up or fetched');
  assert.match(humanizeIcsError(new WorkspaceLimitError('WORKSPACE_OUTGOING_LIMIT', 429, 'x')), /limit of outside requests; the feed syncs again on its next turn/);
});

const volume = (sizeBytes: number, usedBytes: number) => async () => {
  const bsize = 4096;
  const blocks = Math.floor(sizeBytes / bsize);
  const bfree = blocks - Math.floor(usedBytes / bsize);
  return { bsize, blocks, bfree, bavail: bfree };
};
const GB = 1024 ** 3;

test('disk: an upload that would pass 90% of the volume, or leave under 200 MB, is refused with the reason', async () => {
  _setWorkspaceLimitsForTest(limits());
  _setVolumeStatsForTest(volume(10 * GB, 8.9 * GB));
  await assertStorageRoom('/uploads', 50 * 1024 * 1024);
  await assert.rejects(assertStorageRoom('/uploads', 200 * 1024 * 1024), (error: unknown) => {
    assert.ok(error instanceof WorkspaceLimitError);
    assert.equal(error.code, 'WORKSPACE_STORAGE_FULL');
    assert.equal(error.status, 413);
    assert.equal(error.message, 'This workspace has used its file storage (10 GB). Delete files you no longer need, or ask the workspace owner about more space. Nothing else is affected.');
    return true;
  });
  // A small volume (today's 1 GB): the free-space floor holds below the percentage.
  _setWorkspaceLimitsForTest(limits({ storagePercent: 99 }));
  _setVolumeStatsForTest(volume(1 * GB, 1 * GB - STORAGE_FREE_FLOOR_BYTES - 10 * 1024 * 1024));
  await assert.rejects(assertStorageRoom('/uploads', 20 * 1024 * 1024), /used its file storage \(1 GB\)/);
  // Self-hosted: no limit; an unreadable volume: the write decides.
  _setWorkspaceLimitsForTest(null);
  await assertStorageRoom('/uploads', 5 * GB);
  _setWorkspaceLimitsForTest(limits());
  _setVolumeStatsForTest(async () => { throw new Error('EACCES'); });
  await assertStorageRoom('/uploads', 5 * GB);
});

test('disk: the file store refuses at the limit and leaves no file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-limits-'));
  try {
    const store = new LocalFileStore(dir);
    _setWorkspaceLimitsForTest(limits());
    _setVolumeStatsForTest(volume(1 * GB, 0.95 * GB));
    await assert.rejects(store.put('refused.bin', Buffer.alloc(1024)), (error: unknown) => error instanceof WorkspaceLimitError && error.code === 'WORKSPACE_STORAGE_FULL');
    assert.deepEqual(await readdir(dir), []);
    _setVolumeStatsForTest(volume(1 * GB, 0.1 * GB));
    await store.put('kept.bin', Buffer.alloc(1024));
    assert.deepEqual(await readdir(dir), ['kept.bin']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('disk: what counts as the disk refusing a write', () => {
  assert.equal(isDiskFullError(Object.assign(new Error('no space'), { code: 'ENOSPC' })), true);
  assert.equal(isDiskFullError(Object.assign(new Error('quota'), { code: 'EDQUOT' })), true);
  assert.equal(isDiskFullError(Object.assign(new Error('denied'), { code: 'EACCES' })), false);
  assert.equal(isDiskFullError(null), false);
});
