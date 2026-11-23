/**
 * Per-workspace limits on a hosted cell (apps/api/src/lib/workspace-limits.ts, launch check 6.6): the settings, the limit on
 * outside requests (link previews and calendar feeds), and the disk. No database: the admins' notice is recorded by a test notifier
 * (the scheduled-item caps are in workspace-limits-db.test.ts).
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
  WORKSPACE_LIMIT_SETTING_NAMES,
  WorkspaceLimitError,
  _setVolumeStatsForTest,
  _setWorkspaceLimitsForTest,
  isDiskFullError,
  parseWorkspaceLimits,
  reserveStorage,
  takeOutgoingRequest,
  validateWorkspaceLimitEnvironment,
  type WorkspaceLimits,
} from '../src/lib/workspace-limits.js';

const realLookup = publicFetchDeps.lookup;
const limits = (overrides: Partial<WorkspaceLimits> = {}): WorkspaceLimits => ({ ...DEFAULT_WORKSPACE_LIMITS, ...overrides });
const notices: Array<{ kind: string; title: string }> = [];
const hosted = (overrides: Partial<WorkspaceLimits> = {}) => _setWorkspaceLimitsForTest(limits(overrides), (kind, notice) => notices.push({ kind, title: notice.title }));

afterEach(() => {
  _setWorkspaceLimitsForTest(undefined);
  _setVolumeStatsForTest(null);
  publicFetchDeps.lookup = realLookup;
  notices.length = 0;
});

test('the launch defaults, and every setting strict on its own: a whole number in range or startup stops', () => {
  assert.deepEqual(DEFAULT_WORKSPACE_LIMITS, { outgoingPerMinute: 60, outgoingPerHour: 1_000, scheduledMessages: 500, reminders: 2_000, storagePercent: 90, storageFreeMb: 200 });
  assert.deepEqual(parseWorkspaceLimits({}), { ok: true, limits: DEFAULT_WORKSPACE_LIMITS });
  assert.deepEqual(parseWorkspaceLimits({ DEFT_HOSTED_LIMIT_OUTGOING_PER_MINUTE: '10', DEFT_HOSTED_LIMIT_STORAGE_PERCENT: '80', DEFT_HOSTED_LIMIT_STORAGE_FREE_MB: '500' }),
    { ok: true, limits: limits({ outgoingPerMinute: 10, storagePercent: 80, storageFreeMb: 500 }) });
  // Each limit holds on its own: an hourly limit below the minute's is a valid (strict) choice.
  assert.equal(parseWorkspaceLimits({ DEFT_HOSTED_LIMIT_OUTGOING_PER_HOUR: '30' }).ok, true);
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
});

test('outside requests: the minute limit, then the hour limit; a refusal says why and when, and is not counted', () => {
  hosted({ outgoingPerMinute: 3, outgoingPerHour: 5 });
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
  takeOutgoingRequest(t0 + 60_001);
  takeOutgoingRequest(t0 + 60_002);
  assert.throws(() => takeOutgoingRequest(t0 + 60_003), (error: unknown) => error instanceof WorkspaceLimitError
    && /5 outside requests in the last hour, its limit\. Try again in 59 minutes\./.test(error.message));
  takeOutgoingRequest(t0 + 60 * 60_000 + 1);
  assert.deepEqual(notices.map((notice) => notice.kind), ['outgoing_requests'], 'one notice to the admins within the hour');
});

test('outside requests: with both windows full, the refusal names the one that frees last', () => {
  hosted({ outgoingPerMinute: 1, outgoingPerHour: 1 });
  takeOutgoingRequest(1_000_000);
  assert.throws(() => takeOutgoingRequest(1_000_500), (error: unknown) => error instanceof WorkspaceLimitError
    && /in the last hour, its limit\. Try again in 60 minutes\./.test(error.message) && (error.retryAfterSeconds ?? 0) > 3_500);
});

test('outside requests on a self-hosted install are never limited', () => {
  _setWorkspaceLimitsForTest(null);
  for (let i = 0; i < 5_000; i += 1) takeOutgoingRequest(1_000 + i);
});

test('past the limit nothing is looked up or fetched: a link preview is skipped (chat goes on), a feed is told it waits', async () => {
  hosted({ outgoingPerMinute: 1, outgoingPerHour: 1 });
  const lookups: string[] = [];
  publicFetchDeps.lookup = async (hostname: string) => {
    lookups.push(hostname);
    throw new Error('ENOTFOUND');
  };
  takeOutgoingRequest();
  assert.equal(await fetchLinkPreview('https://example.com/page'), null);
  await assert.rejects(fetchPublicHttpText('https://example.com/page', { maxBytes: 1024, timeoutMs: 1_000, accept: 'text/html', userAgent: 'test' }),
    (error: unknown) => error instanceof WorkspaceLimitError && error.code === 'WORKSPACE_OUTGOING_LIMIT');
  assert.deepEqual(lookups, [], 'nothing was looked up');
  assert.match(humanizeIcsError(new WorkspaceLimitError('WORKSPACE_OUTGOING_LIMIT', 429, 'x')), /limit of outside requests; the feed syncs again on its next turn/);
});

test('outside requests: an address refused before any request is not counted', async () => {
  hosted({ outgoingPerMinute: 1, outgoingPerHour: 10 });
  await assert.rejects(fetchPublicHttpText('http://10.0.0.1/page', { maxBytes: 1024, timeoutMs: 1_000, accept: 'text/html', userAgent: 'test' }),
    (error: unknown) => !(error instanceof WorkspaceLimitError));
  takeOutgoingRequest(); // the one place of the minute is still free
});

const volume = (sizeBytes: number, usedBytes: number) => async () => {
  const bsize = 4096;
  const blocks = Math.floor(sizeBytes / bsize);
  const bfree = blocks - Math.floor(usedBytes / bsize);
  return { bsize, blocks, bfree, bavail: bfree };
};
const GB = 1024 ** 3;
const MB = 1024 ** 2;

test('disk: a write that would pass 90% of the volume, or leave under the free-space floor, is refused with the reason', async () => {
  hosted();
  _setVolumeStatsForTest(volume(10 * GB, 8.9 * GB));
  (await reserveStorage('/uploads', 50 * MB))();
  await assert.rejects(reserveStorage('/uploads', 200 * MB), (error: unknown) => {
    assert.ok(error instanceof WorkspaceLimitError);
    assert.equal(error.code, 'WORKSPACE_STORAGE_FULL');
    assert.equal(error.status, 413);
    assert.equal(error.message, 'This workspace has used its file storage (10 GB), so this file was not saved. Ask the workspace owner about more space. Everything else works as usual.');
    return true;
  });
  assert.deepEqual(notices.map((notice) => notice.kind), ['storage']);
  // A small volume (today's 1 GB): the free-space floor (200 MB) holds below the percentage.
  hosted({ storagePercent: 99 });
  _setVolumeStatsForTest(volume(1 * GB, 1 * GB - 210 * MB));
  await assert.rejects(reserveStorage('/uploads', 20 * MB), /used its file storage \(1 GB\)/);
  // Self-hosted: no limit.
  _setWorkspaceLimitsForTest(null);
  (await reserveStorage('/uploads', 5 * GB))();
});

test('disk: writes in progress count, so uploads arriving together cannot pass the limit between them', async () => {
  hosted();
  _setVolumeStatsForTest(volume(10 * GB, 8 * GB)); // 1 GB left under 90%
  const first = await reserveStorage('/uploads', 600 * MB);
  await assert.rejects(reserveStorage('/uploads', 600 * MB), (error: unknown) => error instanceof WorkspaceLimitError && error.code === 'WORKSPACE_STORAGE_FULL');
  first();
  (await reserveStorage('/uploads', 600 * MB))();
});

test('disk: a write that settles while the volume is being measured is not missed (the volume is measured again)', async () => {
  hosted();
  _setVolumeStatsForTest(volume(10 * GB, 8 * GB));
  const landing = await reserveStorage('/uploads', 600 * MB);
  let reads = 0;
  // The first reading is taken just before the 600 MB write lands; its reservation is let go while the reading is in flight.
  _setVolumeStatsForTest(async () => {
    reads += 1;
    if (reads === 1) {
      landing();
      return volume(10 * GB, 8 * GB)();
    }
    return volume(10 * GB, 8 * GB + 600 * MB)();
  });
  await assert.rejects(reserveStorage('/uploads', 600 * MB), (error: unknown) => error instanceof WorkspaceLimitError && error.code === 'WORKSPACE_STORAGE_FULL');
  assert.equal(reads, 2);
});

test('disk: when every measurement overlaps another write settling, the write is refused as unmeasurable (never a stale sample)', async () => {
  hosted();
  _setVolumeStatsForTest(volume(10 * GB, 1 * GB));
  const pending = await Promise.all(Array.from({ length: 5 }, () => reserveStorage('/uploads', 1 * MB)));
  let reads = 0;
  _setVolumeStatsForTest(async () => {
    pending[reads]?.();
    reads += 1;
    return volume(10 * GB, 1 * GB)();
  });
  await assert.rejects(reserveStorage('/uploads', 1 * MB), (error: unknown) => error instanceof WorkspaceLimitError && error.code === 'WORKSPACE_STORAGE_UNAVAILABLE');
  assert.equal(reads, 5);
});

test('disk: a volume that cannot be measured refuses the write on a hosted cell (and says so)', async () => {
  hosted();
  _setVolumeStatsForTest(async () => { throw new Error('EIO'); });
  await assert.rejects(reserveStorage('/uploads', 1024), (error: unknown) => error instanceof WorkspaceLimitError && error.code === 'WORKSPACE_STORAGE_UNAVAILABLE' && error.status === 503);
});

test('disk: the file store refuses at the limit and leaves no file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-limits-'));
  try {
    const store = new LocalFileStore(dir);
    hosted();
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
