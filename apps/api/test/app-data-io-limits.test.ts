import assert from 'node:assert/strict';
import test from 'node:test';
import {withAppDataBinaryIo} from '../src/lib/app-data-io-limits.js';

const owner=(user_id:string)=>({org_id:'synthetic-org',user_id});
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
const busy=(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='APP_PROVIDER_UNAVAILABLE';

test('large binary IO bounds each human and global work while ordinary JSON and images remain separate',async()=>{
 const hold=gate(),a=owner('a'),b=owner('b'),c=owner('c');
 const active=[withAppDataBinaryIo(a,'file_upload',()=>hold.promise),withAppDataBinaryIo(a,'resource_read_source',()=>hold.promise)];
 try{
  await assert.rejects(withAppDataBinaryIo(a,'file_read',async()=>{}),busy);
  assert.equal(await withAppDataBinaryIo(a,'record_read',async()=>42),42);
  active.push(withAppDataBinaryIo(b,'file_read',()=>hold.promise),withAppDataBinaryIo(b,'resource_read_file',()=>hold.promise));
  await assert.rejects(withAppDataBinaryIo(c,'file_upload',async()=>{}),busy);
  assert.equal(await withAppDataBinaryIo(a,'resource_read_image',async()=>7),7);
 }finally{hold.release();await Promise.all(active);}
 assert.equal(await withAppDataBinaryIo(a,'file_read',async()=>9),9);
});

test('image IO has independent eight-global/four-human bounds',async()=>{
 const hold=gate(),active:Promise<void>[]=[],a=owner('image-a'),b=owner('image-b');
 try{
  for(let i=0;i<4;i++)active.push(withAppDataBinaryIo(a,'resource_read_image',()=>hold.promise));
  await assert.rejects(withAppDataBinaryIo(a,'resource_read_image',async()=>{}),busy);
  for(let i=0;i<4;i++)active.push(withAppDataBinaryIo(b,'resource_read_image',()=>hold.promise));
  await assert.rejects(withAppDataBinaryIo(owner('image-c'),'resource_read_image',async()=>{}),busy);
  await withAppDataBinaryIo(a,'file_read',async()=>{});
 }finally{hold.release();await Promise.all(active);}
});

test('upload admission is reentrant for the same invocation and releases on failure',async()=>{
 const a=owner('nested'),hold=gate();
 const first=withAppDataBinaryIo(a,'file_upload',()=>withAppDataBinaryIo(a,'file_read',()=>hold.promise));
 const second=withAppDataBinaryIo(a,'resource_read_file',()=>hold.promise);
 try{await assert.rejects(withAppDataBinaryIo(a,'file_read',async()=>{}),busy);}
 finally{hold.release();await Promise.all([first,second]);}
 await assert.rejects(withAppDataBinaryIo(a,'file_upload',async()=>{throw Error('synthetic failure');}),/synthetic failure/);
 await Promise.all([withAppDataBinaryIo(a,'file_upload',async()=>{}),withAppDataBinaryIo(a,'file_read',async()=>{})]);
});
