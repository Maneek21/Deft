import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWikiHistory, type WikiHistorySnapshot } from './wiki-history-loader';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const response = (versions: number[]) => ({ ok: true, json: async () => ({ versions }) });
test('an open panel refreshes v3 to v4 and replaces old snapshots with loading before the current versions', async () => {
 const seen: WikiHistorySnapshot<number>[] = []; const publish = (state: WikiHistorySnapshot<number>) => { seen.push(state); };
 const old = loadWikiHistory<number>({ key: 'session:page:v3', slug: 'page', request: async () => response([2, 1]), publish }); await old.finished;
 old.dispose(); const next = loadWikiHistory<number>({ key: 'session:page:v4', slug: 'page', request: async () => response([3, 2, 1]), publish });
 assert.deepEqual(seen.at(-1), { key: 'session:page:v4', status: 'loading', versions: [] }); await next.finished;
 assert.deepEqual(seen.at(-1), { key: 'session:page:v4', status: 'ready', versions: [3, 2, 1] });
});
test('late old-version, old-page and old-session responses cannot publish after the coordinated effect cleanup', async () => {
 for (const oldKey of ['session:page:v3', 'session:other:v4', 'old-session:page:v4']) {
  const pending = deferred<ReturnType<typeof response>>(); const seen: WikiHistorySnapshot<number>[] = [];
  const old = loadWikiHistory<number>({ key: oldKey, slug: 'page', request: () => pending.promise, publish: state => { seen.push(state); } }); old.dispose();
  const current = loadWikiHistory<number>({ key: 'session:page:v4', slug: 'page', request: async () => response([3, 2, 1]), publish: state => { seen.push(state); } }); await current.finished;
  pending.resolve(response([2, 1])); await old.finished; assert.equal(seen.at(-1)?.key, 'session:page:v4');
 }
});
test('cleanup during JSON decoding suppresses old body and errors are scoped without stale versions', async () => {
 const json = deferred<{ versions: number[] }>(); const seen: WikiHistorySnapshot<number>[] = []; let decoded = false;
 const request = loadWikiHistory<number>({ key: 'old', slug: 'page', request: async () => ({ ok: true, json: () => { decoded = true; return json.promise; } }), publish: state => { seen.push(state); } });
 await Promise.resolve(); assert.equal(decoded, true); request.dispose(); json.resolve({ versions: [1] }); await request.finished; assert.equal(seen.length, 1);
 const failed = loadWikiHistory<number>({ key: 'current', slug: 'page', request: async () => ({ ok: false, json: async () => ({}) }), publish: state => { seen.push(state); } }); await failed.finished;
 assert.deepEqual(seen.at(-1), { key: 'current', status: 'error', versions: [] });
});
