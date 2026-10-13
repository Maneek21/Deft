import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeEmailOfflineDraftJournal,
  classifyNativeOfflineDraftReconnect,
  nativeOfflineDraftLimits,
  type NativeOfflineDraftDriver,
  type NativeOfflineDraftScope,
  type NativeOfflineDraftStoredRow,
} from './email-native-offline-drafts';
import { emptyNativeDraft } from './email-native-drafts';

const deviceId = '11111111-1111-4111-8111-111111111111';
const scope: NativeOfflineDraftScope = { orgId: 'org-a', userId: 'user-a', accountId: 'account-a', draftId: 'draft-a' };

class MemoryDriver implements NativeOfflineDraftDriver {
  rows = new Map<string, NativeOfflineDraftStoredRow>();
  keys = new Map<string, CryptoKey>();
  constructor(readonly device = deviceId) {}
  async deviceId() { return this.device; }
  async key(owner: string, create: () => Promise<CryptoKey>) {
    const existing = this.keys.get(owner);
    if (existing) return existing;
    const candidate = await create();
    this.keys.set(owner, candidate);
    return candidate;
  }
  async read(id: string) { return this.rows.get(id) ?? null; }
  async list(owner: string) { return [...this.rows.values()].filter(row => row.owner === owner); }
  async commit(input: Parameters<NativeOfflineDraftDriver['commit']>[0]) {
    const current = this.rows.get(input.headId);
    if (current?.sendOutcome === 'unknown' || (current?.localRevision ?? 0) !== input.expectedRevision) {
      const usage = await this.list(input.owner);
      if (usage.length + 1 > input.limits.maxOwnerRecords || usage.reduce((sum, row) => sum + row.bytes, 0) + input.conflict.bytes > input.limits.maxOwnerBytes) return 'conflict_capacity' as const;
      this.rows.set(input.conflict.id, input.conflict);
      return 'conflict_saved' as const;
    }
    const others = (await this.list(input.owner)).filter(row => row.id !== input.headId);
    if (others.length + 1 > input.limits.maxOwnerRecords || others.reduce((sum, row) => sum + row.bytes, 0) + input.head.bytes > input.limits.maxOwnerBytes) return 'quota' as const;
    this.rows.set(input.headId, input.head);
    return 'saved' as const;
  }
  async remove(id: string, owner: string, expectedRevision: number) {
    const row = this.rows.get(id);
    if (!row || row.owner !== owner || row.localRevision !== expectedRevision || row.sendOutcome === 'unknown') return false;
    this.rows.delete(id);
    return true;
  }
}

async function journal(driver = new MemoryDriver(), ownerScope = scope, authorize = () => true, limits = nativeOfflineDraftLimits) {
  return createNativeEmailOfflineDraftJournal(ownerScope, { driver, authorize, limits, now: () => 1_800_000_000_000 });
}

test('encrypts native draft data and round-trips only under verified exact account scope', async () => {
  const driver = new MemoryDriver(), local = await journal(driver);
  const content = { ...emptyNativeDraft(), subject: 'Private Ω', body: 'Keep this encrypted' };
  const saved = await local.put({ expectedLocalRevision: 0, baseServerRevision: 3, content });
  assert.equal(saved.content.subject, 'Private Ω');
  const row = [...driver.rows.values()][0];
  assert.equal(JSON.stringify(row).includes('Private Ω'), false);
  assert.equal(JSON.stringify(row).includes('Keep this encrypted'), false);
  assert.deepEqual((await local.read())?.content, content);
  const reopened = await journal(driver);
  assert.deepEqual((await reopened.read())?.content, content, 'same browser-profile key must recover after journal recreation');

  const otherAccount = await journal(driver, { ...scope, accountId: 'account-b' });
  assert.equal(await otherAccount.read(), null);
  const otherOwner = await journal(driver, { ...scope, userId: 'user-b' });
  assert.equal(await otherOwner.read(), null);
  const otherDevice = await journal(new MemoryDriver('22222222-2222-4222-8222-222222222222'));
  assert.equal(await otherDevice.read(), null);
});

test('tampered revision metadata fails authenticated decryption', async () => {
  const driver = new MemoryDriver(), local = await journal(driver);
  await local.put({ expectedLocalRevision: 0, baseServerRevision: 4, content: { ...emptyNativeDraft(), subject: 'bound to revision four' } });
  const row = [...driver.rows.values()][0];
  row.baseServerRevision = 5;
  await assert.rejects(local.read(), error => (error as { code?: string }).code === 'storage');
});

test('denies decrypt and writes after current owner/account authorization expires', async () => {
  let allowed = true;
  const local = await journal(new MemoryDriver(), scope, () => allowed);
  await local.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'protected' } });
  allowed = false;
  await assert.rejects(local.read(), error => (error as { code?: string }).code === 'denied');
  await assert.rejects(local.put({ expectedLocalRevision: 1, baseServerRevision: 1, content: emptyNativeDraft() }), error => (error as { code?: string }).code === 'denied');
});

test('local revision CAS preserves the losing tab as an encrypted conflict branch', async () => {
  const driver = new MemoryDriver(), firstTab = await journal(driver), secondTab = await journal(driver);
  await firstTab.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'tab one' } });
  await assert.rejects(secondTab.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'tab two' } }), error => (error as { code?: string }).code === 'conflict');
  const conflicts = await secondTab.conflicts();
  assert.equal(conflicts.length, 1);
  assert.equal((await secondTab.readConflict(conflicts[0].branchId)).content.body, 'tab two');
  assert.equal((await firstTab.read())?.content.body, 'tab one');
});

test('when branch quota is full the current editor is not overwritten or evicted', async () => {
  const driver = new MemoryDriver(), limits = { maxOwnerBytes: 1024 * 1024, maxOwnerRecords: 1, maxDraftBytes: 480 * 1024 };
  const first = await journal(driver, scope, () => true, limits), second = await journal(driver, scope, () => true, limits);
  await first.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'kept head' } });
  await assert.rejects(second.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'caller still owns this buffer' } }), error => (error as { code?: string }).code === 'conflict');
  assert.equal((await first.read())?.content.body, 'kept head');
  assert.equal((await first.conflicts()).length, 0);
});

test('conflict quota counts the retained head at the exact byte limit', async () => {
  const driver = new MemoryDriver();
  const first = await journal(driver);
  await first.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'head' } });
  const head = [...driver.rows.values()][0];
  const exactRetainedBytes = head.bytes * 2;
  const limits = { maxOwnerBytes: exactRetainedBytes, maxOwnerRecords: 200, maxDraftBytes: 480 * 1024 };
  const staleTab = await journal(driver, scope, () => true, limits);
  await assert.rejects(staleTab.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'branch' } }), error => (error as { code?: string }).code === 'conflict');
  assert.equal(driver.rows.size, 1, 'retained head plus conflict would exceed the exact owner byte cap');
  assert.equal((await first.read())?.content.body, 'head');
});

test('authorization is rechecked after encryption before the IndexedDB commit', async () => {
  const driver = new MemoryDriver();
  let checks = 0;
  const local = await journal(driver, scope, () => ++checks === 1);
  await assert.rejects(local.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'must not commit' } }), error => (error as { code?: string }).code === 'denied');
  assert.equal(driver.rows.size, 0);
});

test('account metadata catalogue discovers unsaved IDs without decrypting other accounts and rechecks authorization', async () => {
  const driver = new MemoryDriver();
  await (await journal(driver, { ...scope, draftId: 'unsaved-one' })).put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'private one' } });
  await (await journal(driver, { ...scope, draftId: 'unsaved-two' })).put({ expectedLocalRevision: 0, baseServerRevision: 4, content: { ...emptyNativeDraft(), body: 'private two' }, sendOutcome: 'unknown' });
  await (await journal(driver, { ...scope, accountId: 'account-b', draftId: 'other-account' })).put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'must stay outside catalogue' } });
  const local = await journal(driver, scope);
  const catalog = await local.listAccount();
  assert.deepEqual(catalog.map(row => [row.draftId, row.sendOutcome]), [['unsaved-one', 'none'], ['unsaved-two', 'unknown']]);
  assert.equal(JSON.stringify(catalog).includes('private one'), false);
  assert.equal(JSON.stringify(catalog).includes('other-account'), false);
  assert.equal(classifyNativeOfflineDraftReconnect({ ...(await local.read())!, sendOutcome: 'unknown' }, 0), 'unknown_send_blocked');

  let allowed = true;
  const gated = await journal(driver, scope, () => allowed);
  const originalList = driver.list.bind(driver);
  driver.list = async owner => { const rows = await originalList(owner); allowed = false; return rows; };
  await assert.rejects(gated.listAccount(), error => (error as { code?: string }).code === 'denied');
});

test('unknown send outcome cannot be silently cleared or explicitly removed', async () => {
  const local = await journal();
  await local.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'submission uncertain' }, sendOutcome: 'unknown' });
  await assert.rejects(local.put({ expectedLocalRevision: 1, baseServerRevision: 0, content: { ...emptyNativeDraft(), body: 'new content' } }), error => (error as { code?: string }).code === 'conflict');
  await assert.rejects(local.remove(1), error => (error as { code?: string }).code === 'conflict');
  assert.equal((await local.read())?.sendOutcome, 'unknown');
  assert.equal((await local.conflicts()).length, 1);
});

test('quota errors do not evict dirty drafts or unknown send outcomes', async () => {
  const driver = new MemoryDriver();
  const tiny = { maxOwnerBytes: 1024, maxOwnerRecords: 1, maxDraftBytes: 480 * 1024 };
  const local = await journal(driver, scope, () => true, tiny);
  const body = 'x'.repeat(1800);
  await assert.rejects(local.put({ expectedLocalRevision: 0, baseServerRevision: 0, content: { ...emptyNativeDraft(), body, }, sendOutcome: 'unknown' }), error => (error as { code?: string }).code === 'quota');
  assert.equal(await local.read(), null);
  assert.equal((await local.listOwnerUsage()).records, 0);
  assert.throws(() => classifyNativeOfflineDraftReconnect(null, -1));
});

test('reconnect decision permits CAS save only when server revision still equals local base', async () => {
  const local = await journal();
  const saved = await local.put({ expectedLocalRevision: 0, baseServerRevision: 7, content: { ...emptyNativeDraft(), subject: 'offline edit' } });
  assert.equal(classifyNativeOfflineDraftReconnect(saved, 7), 'base_unchanged');
  assert.equal(classifyNativeOfflineDraftReconnect(saved, 8), 'server_changed');
  assert.equal(classifyNativeOfflineDraftReconnect(null, 8), 'no_local_copy');
});

test('configured product bounds support native drafts without silent eviction', async () => {
  assert.equal(nativeOfflineDraftLimits.maxOwnerRecords, 200);
  assert.equal(nativeOfflineDraftLimits.maxOwnerBytes, 64 * 1024 * 1024);
  assert.equal(nativeOfflineDraftLimits.maxDraftBytes, 480 * 1024);
});
