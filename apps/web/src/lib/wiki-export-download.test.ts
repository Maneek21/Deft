import assert from 'node:assert/strict';
import test from 'node:test';
import { createWikiExportDownload } from './wiki-export-download';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(get: (path: string) => Promise<Pick<Response, 'ok' | 'blob' | 'headers'>>) {
 let session: string | null = 'maya-session'; let clicks = 0, removed = 0, created = 0, revoked = 0; const names: string[] = [], scheduled: (() => void)[] = [], states: { busy: boolean; error: string | null }[] = [];
 const download = createWikiExportDownload({ get, currentSession: () => session, state: (busy, error) => { states.push({ busy, error }); }, environment: {
  createUrl: blob => { assert.equal(blob.type, 'text/markdown'); created++; return 'blob:owned'; }, revokeUrl: url => { assert.equal(url, 'blob:owned'); revoked++; },
  anchor: () => ({ href: '', download: '', rel: '', click() { clicks++; names.push(this.download); }, remove() { removed++; } }), append: () => {}, defer: callback => { scheduled.push(callback); },
 } });
 return { download, changeSession: () => { session = 'different-session'; }, clicks: () => clicks, removed: () => removed, created: () => created, revoked: () => revoked, names, states, flush: () => { scheduled.forEach(callback => callback()); } };
}
const response = () => ({ ok: true, headers: new Headers({ 'Content-Type': 'text/markdown' }), blob: async () => new Blob(['# Synthetic wiki'], { type: 'text/markdown' }) });
test('authenticated injected client gets exact export once; one blob download preserves filename and releases its URL', async () => {
 const request = deferred<ReturnType<typeof response>>(); const paths: string[] = []; const f = fixture(path => { paths.push(path); return request.promise; });
 const first = f.download(); assert.equal(await f.download(), false); assert.deepEqual(paths, ['/api/wiki/export?format=md']); request.resolve(response()); assert.equal(await first, true);
 assert.equal(f.clicks(), 1); assert.equal(f.created(), 1); assert.equal(f.removed(), 1); assert.deepEqual(f.names, ['wiki-export.md']); assert.equal(f.revoked(), 0); f.flush(); assert.equal(f.revoked(), 1); assert.deepEqual(f.states.at(-1), { busy: false, error: null });
});
test('non-ok response is a visible failure with no blob or navigation/download', async () => {
 let blobs = 0; const f = fixture(async () => ({ ok: false, headers: new Headers(), blob: async () => { blobs++; return new Blob(); } }));
 assert.equal(await f.download(), false); assert.equal(blobs, 0); assert.equal(f.clicks(), 0); assert.equal(f.created(), 0); assert.match(f.states.at(-1)?.error ?? '', /could not be exported/);
});
test('session change while authenticated response or blob is pending never starts a download', async () => {
 const pending = deferred<ReturnType<typeof response>>(); const f = fixture(() => pending.promise); const first = f.download(); f.changeSession(); pending.resolve(response()); assert.equal(await first, false); assert.equal(f.created(), 0);
 const body = deferred<Blob>(); const g = fixture(async () => ({ ...response(), blob: () => body.promise })); const second = g.download(); await Promise.resolve(); g.changeSession(); body.resolve(new Blob(['private'], { type: 'text/markdown' })); assert.equal(await second, false); assert.equal(g.clicks(), 0); assert.equal(g.created(), 0);
});
