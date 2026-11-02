import assert from 'node:assert/strict';
import test from 'node:test';
import {withAppDataBinaryIo} from '../src/lib/app-data-io-limits.js';

const owner=(user_id:string)=>({org_id:'synthetic-org',user_id});
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const busy=(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='APP_PROVIDER_UNAVAILABLE';

test('three overlapping read_file transfers for one owner complete with zero 503s',async()=>{
 const a=owner('concurrent-a');
 const results=await Promise.all([1,2,3].map(()=>withAppDataBinaryIo(a,'resource_read_file',async()=>{await delay(50);return 'ok';})));
 assert.deepEqual(results,['ok','ok','ok']);
});

test('read_file and read_image overlap without sharing a budget',async()=>{
 const a=owner('mixed');
 const files=await Promise.all(Array.from({length:4},()=>withAppDataBinaryIo(a,'resource_read_file',async()=>{await delay(50);return 'file';})));
 const images=await Promise.all(Array.from({length:4},()=>withAppDataBinaryIo(a,'resource_read_image',async()=>{await delay(50);return 'image';})));
 assert.deepEqual(files,['file','file','file','file']);
 assert.deepEqual(images,['image','image','image','image']);
});

test('excess concurrent reads fail only after the queue interval, never instantly',async()=>{
 const a=owner('burst-a'),hold=gate();
 const held=Array.from({length:4},()=>withAppDataBinaryIo(a,'resource_read_file',()=>hold.promise));
 await delay(10);
 const started=Date.now();
 await assert.rejects(withAppDataBinaryIo(a,'resource_read_file',async()=>{}),busy);
 const elapsed=Date.now()-started;
 assert.ok(elapsed>=1900,'the excess transfer must wait the queue interval, not fail instantly');
 hold.release();await Promise.all(held);
});
