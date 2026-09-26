import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm,writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { LocalAppAttachmentObjectStore } from '../src/lib/app-attachment-object-store.js';
import { appAttachmentMediaAllowed } from '../src/lib/app-attachment-media.js';

test('quarantine object publication is exclusive, bounded, abortable and never exposes a partial replacement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'deft-attachment-ciphertext-'));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(`${resolve(tmpdir())}${sep}`) && basename(dir).startsWith('deft-attachment-ciphertext-'));
    return rm(dir, { recursive: true, force: true });
  });
  const store = new LocalAppAttachmentObjectStore(dir), object = crypto.randomUUID();
  const signal = new AbortController().signal, bytes = Buffer.from('ciphertext');
  await store.putExclusive(object, bytes, signal);
  await assert.rejects(store.putExclusive(object, Buffer.from('replacement'), signal));
  assert.deepEqual(await store.get(object, signal), bytes);
  assert.deepEqual(await readdir(dir), [object]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.putExclusive(crypto.randomUUID(), bytes, controller.signal));
  await assert.rejects(store.putExclusive(crypto.randomUUID(), new Uint8Array(2_097_153), signal));
  assert.throws(() => store.get('../foreign', signal));
  assert.deepEqual(await readdir(dir), [object]);
  await store.delete(object); await store.delete(object); assert.deepEqual(await readdir(dir), []);
});

test('conservative media classification blocks active document declarations, mismatches and malformed UTF8', () => {
  assert.equal(appAttachmentMediaAllowed(Buffer.from('title,value\n☃,literal'), 'text/csv'), true);
  assert.equal(appAttachmentMediaAllowed(Buffer.from('{"literal":"<script>"}'), 'application/json'), true);
  for (const text of ['<!DOCTYPE html><html>x</html>', '<svg onload="x">', 'x\0y']) {
    assert.equal(appAttachmentMediaAllowed(Buffer.from(text), 'text/plain'), false);
  }
  assert.equal(appAttachmentMediaAllowed(new Uint8Array([0xff]), 'text/csv'), false);
  assert.equal(appAttachmentMediaAllowed(Buffer.from('csv text'), 'image/png'), false);
  assert.equal(appAttachmentMediaAllowed(Buffer.from('not JSON'), 'application/json'), false);
});

test('confirmed quarantine purge removes reserved prepublication ciphertext from a retained crash fixture',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'deft-attachment-ciphertext-'));
  t.after(()=>{assert.ok(resolve(dir).startsWith(`${resolve(tmpdir())}${sep}`)&&basename(dir).startsWith('deft-attachment-ciphertext-'));return rm(dir,{recursive:true,force:true});});
  const object=crypto.randomUUID(),store=new LocalAppAttachmentObjectStore(dir);
  // Explicit filesystem crash-state fixture, not a process-death claim. Only
  // ciphertext is retained before the publication link exists.
  await writeFile(join(dir,`.pending-${object}`),Buffer.from('synthetic encrypted quarantine'),{flag:'wx'});
  await assert.rejects(store.putExclusive(object,Buffer.from('replacement'),new AbortController().signal));
  assert.equal((await readFile(join(dir,`.pending-${object}`))).toString(),'synthetic encrypted quarantine','Uncertain prepublication identity is never retried or removed by failed exclusive open');
  await store.delete(object);assert.deepEqual(await readdir(dir),[]);
});
