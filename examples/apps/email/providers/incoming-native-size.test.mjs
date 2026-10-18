import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectEmailSourceFiles} from './incoming-source-files.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(size,{base64=true}={}){
 const file=Buffer.alloc(size,0x41),content=base64?file.toString('base64').replace(/.{1,76}/gu,'$&\r\n'):file.toString('ascii');file.fill(0);
 return Buffer.from('From: synthetic@example.test\r\nTo: owner@example.test\r\nMessage-ID: <m18@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=m18\r\n\r\n--m18\r\nContent-Type: text/plain\r\n\r\nBODY_PRESERVED\r\n--m18\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="business.bin"\r\nContent-Transfer-Encoding: '+(base64?'base64':'binary')+'\r\n\r\n'+content+'\r\n--m18--\r\n');
}
test('native ordinary six-MiB attachment preserves body, stable source-bound nomination and exact downloaded bytes; legacy remains eight',async()=>{
 const bytes=fixture(6*1024*1024);assert.ok(bytes.length>8*1024*1024);
 try{
  await assert.rejects(inspectEmailSourceFiles(bytes,{presentation:true}));
  const output=await inspectEmailSourceFiles(bytes,{profile:'native',presentation:true});
  assert.match(output.presentation.plain_text,/BODY_PRESERVED/);assert.equal(output.files.length,1);assert.equal(output.files[0].size_bytes,6*1024*1024);
  assert.equal(output.files[0].file_ref,hash(`${hash(bytes)}:file:0`));assert.equal(output.files[0].preview,'unsupported');
  const result=await inspectEmailSourceFiles(bytes,{profile:'native',file_ref:output.files[0].file_ref});
  try{assert.equal(result.bytes.length,6*1024*1024);assert.ok(result.bytes.every(value=>value===0x41));}finally{result.bytes.fill(0);}
  await assert.rejects(inspectEmailSourceFiles(bytes,{profile:'native',file_ref:'f'.repeat(64)}));
  let checks=0;await assert.rejects(inspectEmailSourceFiles(bytes,{profile:'native',presentation:true,check:async()=>{if(++checks===3)throw Error('Revoked');}}),/Revoked/);
 }finally{bytes.fill(0);}
});
test('native oversized decoded part retains body and visible metadata but never returns unsupported file bytes',async()=>{
 const bytes=fixture(25*1024*1024+1,{base64:false});assert.ok(bytes.length<35*1024*1024);
 try{
  const output=await inspectEmailSourceFiles(bytes,{profile:'native',presentation:true});
  assert.match(output.presentation.plain_text,/BODY_PRESERVED/);assert.equal(output.files.length,1);assert.equal(output.files[0].filename,'business.bin');
  assert.equal(output.files[0].size_bytes,25*1024*1024+1);assert.equal(output.files[0].preview,'unsupported');assert.equal(output.omitted_file_count,undefined);
  await assert.rejects(inspectEmailSourceFiles(bytes,{profile:'native',file_ref:output.files[0].file_ref}));
 }finally{bytes.fill(0);}
});
test('native inventory retains multipart aggregate above outgoing25MiB and up to incoming35MiB with both exact refs',async()=>{
 const header='From: synthetic@example.test\r\nTo: owner@example.test\r\nContent-Type: multipart/mixed; boundary=m18\r\n\r\n--m18\r\nContent-Type: text/plain\r\n\r\nBODY_PRESERVED\r\n';
 const part=(size,index)=>'--m18\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="business'+index+'.bin"\r\nContent-Transfer-Encoding: binary\r\n\r\n'+'A'.repeat(size)+'\r\n';
 const bytes=Buffer.from(header+part(18*1024*1024,0)+part(16*1024*1024,1)+'--m18--\r\n');
 try{assert.ok(bytes.length<=35*1024*1024);const output=await inspectEmailSourceFiles(bytes,{profile:'native',presentation:true});assert.match(output.presentation.plain_text,/BODY_PRESERVED/);
  assert.deepEqual(output.files.map(file=>file.size_bytes),[18*1024*1024,16*1024*1024]);assert.equal(output.omitted_file_count,undefined);
  assert.deepEqual(output.files.map(file=>file.file_ref),[0,1].map(index=>hash(`${hash(bytes)}:file:${index}`)));
 }finally{bytes.fill(0);}
});
test('native raw cap is enforced independently of caller max_bytes and legacy profile cannot opt into native size',async()=>{
 const bytes=fixture(9*1024*1024,{base64:false});
 try{await assert.rejects(inspectEmailSourceFiles(bytes,{profile:'legacy',max_bytes:35*1024*1024}));
  await assert.rejects(inspectEmailSourceFiles(bytes,{profile:'native',max_bytes:8*1024*1024}));
  await assert.rejects(inspectEmailSourceFiles(new Uint8Array(35*1024*1024+1),{profile:'native',max_bytes:36*1024*1024}));
 }finally{bytes.fill(0);}
});
