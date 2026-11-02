import assert from 'node:assert/strict';
import test from 'node:test';
import {withAppDataBinaryIo} from '../src/lib/app-data-io-limits.js';

const owner=(user_id:string)=>({org_id:'synthetic-org',user_id});
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
const busy=(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='APP_PROVIDER_UNAVAILABLE';

test('file IO admits four per owner and eight global; overflow waits the queue interval then fails busy',async()=>{
 const hold=gate(),a=owner('a'),b=owner('b'),c=owner('c'),active:Promise<unknown>[]=[];
 for(let i=0;i<4;i++)active.push(withAppDataBinaryIo(a,'file_read',()=>hold.promise));
 for(let i=0;i<4;i++)active.push(withAppDataBinaryIo(b,'resource_read_file',()=>hold.promise));
 const started=Date.now();
 await assert.rejects(withAppDataBinaryIo(c,'file_upload',async()=>{}),busy);
 assert.ok(Date.now()-started>=1900,'overflow must wait the queue interval before failing');
 hold.release();await Promise.all(active);
});

test('image IO admits six per owner and twelve global independently of file slots',async()=>{
 const hold=gate(),a=owner('image-a'),b=owner('image-b'),active:Promise<unknown>[]=[];
 for(let i=0;i<6;i++)active.push(withAppDataBinaryIo(a,'resource_read_image',()=>hold.promise));
 for(let i=0;i<6;i++)active.push(withAppDataBinaryIo(b,'resource_read_image',()=>hold.promise));
 const started=Date.now();
 await assert.rejects(withAppDataBinaryIo(owner('image-c'),'resource_read_image',async()=>{}),busy);
 assert.ok(Date.now()-started>=1900,'image overflow must wait the queue interval before failing');
 await withAppDataBinaryIo(a,'file_read',async()=>{});
 hold.release();await Promise.all(active);
});

test('ordinary JSON operations bypass admission and re-entrant same-group work cannot deadlock',async()=>{
 assert.equal(await withAppDataBinaryIo(owner('plain'),'record_read',async()=>42),42);
 const a=owner('nested');
 assert.equal(await withAppDataBinaryIo(a,'file_upload',()=>withAppDataBinaryIo(a,'file_read',async()=>42)),42);
 await assert.rejects(withAppDataBinaryIo(a,'file_upload',async()=>{throw Error('synthetic failure');}),/synthetic failure/);
 await Promise.all([withAppDataBinaryIo(a,'file_upload',async()=>{}),withAppDataBinaryIo(a,'file_read',async()=>{})]);
});

test('a released slot drains the waiting queue so a queued transfer is admitted instead of failing',async()=>{
 const hold=gate(),a=owner('drain-a'),active:Promise<unknown>[]=[];
 for(let i=0;i<4;i++)active.push(withAppDataBinaryIo(a,'file_read',()=>hold.promise));
 const waiting=withAppDataBinaryIo(a,'file_read',async()=>'admitted');
 hold.release();
 assert.equal(await waiting,'admitted');
 await Promise.all(active);
});
