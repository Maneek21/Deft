import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm,writeFile,readFile,open,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
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
  await store.delete(object); await store.delete(object); assert.deepEqual(await readdir(dir), [object]);
  assert.equal((await store.get(object,signal)).length,0,'Retired identity retains only a permanent empty fence');
  await assert.rejects(store.putExclusive(object,bytes,signal));
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
  assert.equal((await readFile(join(dir,`.pending-${object}`))).toString(),'synthetic encrypted quarantine','Uncertain prepublication identity is never retried or removed by failed exclusive open');
  await store.delete(object);assert.deepEqual(await readdir(dir),[object]);
  assert.equal((await readFile(join(dir,object))).length,0);
  await assert.rejects(new LocalAppAttachmentObjectStore(dir).putExclusive(object,Buffer.from('replacement'),new AbortController().signal));
});

test('atomic retirement fences an actual opened Windows writer, late writes and restarted publication',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'deft-attachment-ciphertext-'));
  t.after(()=>{assert.ok(resolve(dir).startsWith(`${resolve(tmpdir())}${sep}`)&&basename(dir).startsWith('deft-attachment-ciphertext-'));return rm(dir,{recursive:true,force:true});});
  const object=crypto.randomUUID(),store=new LocalAppAttachmentObjectStore(dir);
  const writer=await open(join(dir,object),'wx');
  try{
    await writer.writeFile(Buffer.from('partial synthetic ciphertext'));
    if(process.platform==='win32'){
      await assert.rejects(store.delete(object),error=>!!error&&typeof error==='object'&&'code' in error&&error.code==='EPERM');
      assert.ok((await readFile(join(dir,object))).length>0,'Windows refusal retains ciphertext until the opened writer closes');
    }else await store.delete(object);
    await writer.write(Buffer.from('late ciphertext'),0,15,0);
    if(process.platform==='win32')assert.ok((await readFile(join(dir,object))).length>0);
    else assert.equal((await readFile(join(dir,object))).length,0,'Open writer now targets the replaced inode, never the retained namespace');
  }finally{await writer.close();}
  await store.delete(object);
  const restarted=new LocalAppAttachmentObjectStore(dir);
  await assert.rejects(restarted.putExclusive(object,Buffer.from('new ciphertext'),new AbortController().signal));
  assert.equal((await restarted.get(object,new AbortController().signal)).length,0);
  assert.deepEqual(await readdir(dir),[object],'No ciphertext temporary path survives retirement or restart');
  const moduleUrl=new URL('../src/lib/app-attachment-object-store.ts',import.meta.url).href;
  const script=`const {LocalAppAttachmentObjectStore}=await import(${JSON.stringify(moduleUrl)});
    const store=new LocalAppAttachmentObjectStore(${JSON.stringify(dir)});
    try{await store.putExclusive(${JSON.stringify(object)},Buffer.from('restart ciphertext'),new AbortController().signal);process.exit(2);}
    catch(error){if(error.code!=='EEXIST')process.exit(3);}
    if((await store.get(${JSON.stringify(object)},new AbortController().signal)).length!==0)process.exit(4);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),windowsHide:true,stdio:'ignore'});
  const timeout=setTimeout(()=>child.kill(),10_000);
  try{assert.equal(await new Promise<number|null>((ready,reject)=>{child.once('error',reject);child.once('exit',ready);}),0,'A separate cold process retains the same durable publication fence');}
  finally{clearTimeout(timeout);}
});

test('failed atomic retirement preserves legacy pending ciphertext for a later confirmed purge',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'deft-attachment-ciphertext-'));
  t.after(()=>{assert.ok(resolve(dir).startsWith(`${resolve(tmpdir())}${sep}`)&&basename(dir).startsWith('deft-attachment-ciphertext-'));return rm(dir,{recursive:true,force:true});});
  const object=crypto.randomUUID(),store=new LocalAppAttachmentObjectStore(dir);
  await mkdir(join(dir,object));await writeFile(join(dir,`.pending-${object}`),Buffer.from('legacy encrypted bytes'));
  await assert.rejects(store.delete(object),'A directory prevents atomic file replacement');
  assert.equal((await readFile(join(dir,`.pending-${object}`))).toString(),'legacy encrypted bytes');
});
