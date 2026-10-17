import assert from 'node:assert/strict';
import test from 'node:test';
import { createExperienceResourceDocumentHost, createExperiencePresentationReviewCache } from './app-experience-resource-document';
import type { ExperienceNode } from './app-experience-bridge';
import type { SourcePresentation } from './app-experience-source-view';

const reference: Extract<ExperienceNode, { kind: 'resource_document' }> = {
  kind: 'resource_document', profile_version: 'deft.resource_document.v1', id: 'reader',
  resource_key: 'inbox', record_id: '11111111-1111-4111-8111-111111111111',
};
const presentation: SourcePresentation = { format: 'html', content: '<p>Host body</p>',
  plain_text: 'Host body', truncated: false, images: [], headers: [] };
function fixture() {
  const abort = new AbortController(); let current = true, disposed = 0, reads = 0;
  const locators: string[][] = [];
  const mountInputs: unknown[] = [];
  const host = createExperienceResourceDocumentHost({ resourceKeys: ['inbox'], current: () => current,
    load: async (key, id) => { reads++; locators.push([key, id]);
      return { presentation, expires_at: new Date(Date.now() + 60_000).toISOString() }; },
    mount: (...input) => { mountInputs.push(input); return () => { disposed++; }; } });
  return { host, context: { signal: abort.signal, current: () => current }, abort, locators, mountInputs,
    revoke: () => { current = false; }, reads: () => reads, disposed: () => disposed };
}
test('resource document reads the declared key and opaque record identity, then mounts the full host presentation', async () => {
  const f = fixture(), resolved = await f.host.resolveResourceDocument!(reference, f.context);
  assert.deepEqual(f.locators, [['inbox', reference.record_id]]);
  assert.equal(resolved.content, 'Host body'); assert.equal(resolved.format, 'plain');
  const close = f.host.enhanceResourceDocument!(reference, resolved, {} as HTMLElement, f.context);
  assert.equal(f.mountInputs.length, 1); assert.equal(typeof close, 'function');
  const load = (f.mountInputs[0] as unknown[])[4] as (signal: AbortSignal) => Promise<{ presentation: SourcePresentation }>;
  assert.equal((await load(f.context.signal)).presentation.content, '<p>Host body</p>');
  f.abort.abort(); if (typeof close === 'function') close(); assert.equal(f.disposed(), 1);
});
test('undeclared resource keys and a revoked scope do not start reads', async () => {
  const f = fixture();
  await assert.rejects(f.host.resolveResourceDocument!({ ...reference, resource_key: 'other' }, f.context));
  f.revoke(); await assert.rejects(f.host.resolveResourceDocument!(reference, f.context));
  assert.equal(f.reads(), 0);
});
test('revocation while a source read is pending discards the response', async () => {
  let active = true, resolve!: (value: { presentation: SourcePresentation; expires_at: string }) => void;
  const host = createExperienceResourceDocumentHost({ resourceKeys: ['inbox'], current: () => active,
    load: () => new Promise(done => { resolve = done; }), mount: () => () => {} });
  const pending = host.resolveResourceDocument!(reference, { signal: new AbortController().signal, current: () => true });
  active = false; resolve({ presentation, expires_at: new Date(Date.now() + 60_000).toISOString() });
  await assert.rejects(pending);
});
test('aborted renderer and expired presentations cannot attach', async () => {
  const f = fixture(); f.abort.abort(); await assert.rejects(f.host.resolveResourceDocument!(reference, f.context));
  const host = createExperienceResourceDocumentHost({ resourceKeys: ['inbox'], current: () => true,
    now: () => 1000, load: async () => ({ presentation, expires_at: new Date(1000).toISOString() }), mount: () => () => {} });
  await assert.rejects(host.resolveResourceDocument!(reference, { signal: new AbortController().signal, current: () => true }));
});
test('fallback is byte bounded without corrupting Unicode; complete HTML remains host owned', async () => {
  const rich = { ...presentation, plain_text: '🙂'.repeat(5000) };
  const host = createExperienceResourceDocumentHost({ resourceKeys: ['inbox'], current: () => true,
    load: async () => ({ presentation: rich, expires_at: new Date(Date.now() + 60_000).toISOString() }), mount: () => () => {} });
  const document = await host.resolveResourceDocument!(reference, { signal: new AbortController().signal, current: () => true });
  assert.equal(new TextEncoder().encode(document.content).byteLength, 16_384);
  assert.equal(document.content, '🙂'.repeat(4096)); assert.equal(document.truncated, true);
});

test('a newer render evicts aborted pending review and its predecessor cannot erase the replacement', async () => {
  const cache = createExperiencePresentationReviewCache<{ id: string }>();
  const a = new AbortController(), b = new AbortController();
  let reject!: (reason: Error) => void;
  const pending = cache.read(a.signal, async () => new Promise((_resolve, denied) => { reject = denied; }));
  const rejected = assert.rejects(pending); await Promise.resolve(); a.abort();
  const replacement = { id: 'b' }; let reads = 0;
  assert.equal(await cache.read(b.signal, async () => { reads++; return replacement; }), replacement);
  reject(Error('aborted older fetch')); await rejected;
  assert.equal(await cache.read(b.signal, async () => { reads++; return { id: 'wrong' }; }), replacement);
  assert.equal(reads, 1);
});
test('completed review survives producer abort, and invalidation is tied to the exact cached snapshot', async () => {
  const cache = createExperiencePresentationReviewCache<{ id: string }>();
  const a = new AbortController(), b = new AbortController(), first = { id: 'a' }, second = { id: 'b' };
  assert.equal(await cache.read(a.signal, async () => first), first); a.abort();
  assert.equal(await cache.read(b.signal, async () => second), first);
  cache.invalidate(first); assert.equal(await cache.read(b.signal, async () => second), second);
  cache.invalidate(first); assert.equal(await cache.read(b.signal, async () => first), second);
  cache.clear(); assert.equal(await cache.read(b.signal, async () => first), first);
});
