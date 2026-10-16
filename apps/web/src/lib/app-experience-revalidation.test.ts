import test from 'node:test';
import assert from 'node:assert/strict';
import { readExperienceAuthority } from './app-experience-revalidation';

test('one transient authority read failure requires a fresh successful response', async () => {
  let reads = 0;
  const response = await readExperienceAuthority(() => true, async () => new Response(null, { status: ++reads === 1 ? 503 : 200 }));
  assert.equal(response?.status, 200); assert.equal(reads, 2);
});

test('persistent server failure is returned after one retry, never converted into authority', async () => {
  let reads = 0;
  const response = await readExperienceAuthority(() => true, async () => { reads++; return new Response(null, { status: 503 }); });
  assert.equal(response?.ok, false); assert.equal(reads, 2);
});

test('authorization failures are immediate and successful responses are not cached', async () => {
  for (const status of [200, 401, 403, 404, 409, 429]) {
    let reads = 0;
    const read = async () => { reads++; return new Response(null, { status }); };
    assert.equal((await readExperienceAuthority(() => true, read))?.status, status);
    assert.equal(reads, 1);
    await readExperienceAuthority(() => true, read); assert.equal(reads, 2);
  }
});

test('authority ending during the retry delay prevents another read', async () => {
  let current = true, reads = 0;
  const response = await readExperienceAuthority(() => current, async () => {
    reads++; setTimeout(() => { current = false; }, 0);
    return new Response(null, { status: 503 });
  });
  assert.equal(response, null); assert.equal(reads, 1);
});

test('a response cannot outlive local expiry or a replaced session', async () => {
  let current = true, reads = 0;
  assert.equal(await readExperienceAuthority(() => current, async () => { reads++; current = false; return new Response(); }), null);
  assert.equal(await readExperienceAuthority(() => current, async () => { reads++; return new Response(); }), null);
  assert.equal(reads, 1);
});

test('transport failures still fail closed through the existing API retry policy', async () => {
  let reads = 0;
  await assert.rejects(readExperienceAuthority(() => true, async () => { reads++; throw new TypeError('Network failed'); }), /Network failed/);
  assert.equal(reads, 1);
});
