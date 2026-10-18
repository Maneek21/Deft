import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sha256Hex} from './worker-sha256.mjs';
import {workerTriageInput} from './triage-ui.mjs';
const expected=text=>createHash('sha256').update(text).digest('hex');
test('portable SHA-256 matches standard vectors, padding boundaries and UTF-8',()=>{
 for(const value of ['', 'abc', 'abcdbcdecdefdefgefghfghijhijkijkljklmklmnlmnomnopnopq', '語🪴\ud800', ...[1,55,56,63,64,65,127,128,129,10000].map(n=>'a'.repeat(n))])assert.equal(sha256Hex(value),expected(value));
});
test('all bounded triage nominations keep the exact previous UTF-8 JSON fingerprint without Web Crypto',async()=>{
 const ids=Array.from({length:25},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
 const previous=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues(){throw Error('Fingerprint must not need randomness');}}});
 try {
  for(const [operation,options]of [['mark_read',{}],['archive',{}],['labels',{add_labels:['語'.repeat(256)],remove_labels:['Label_2']}],['move',{destination:'folder-id'}],['undo',{undo_of:ids[0]}],['permanent_delete',{}]]){
   const result=await workerTriageInput(operation,[...ids].reverse(),()=>({account_id:'controlled'}),options);
   assert.equal(result.summary,`${operation.replaceAll('_',' ')} · 25 message(s) · ${expected(JSON.stringify(result.input))}`);
  }
 }finally{if(previous)Object.defineProperty(globalThis,'crypto',previous);else delete globalThis.crypto;}
});
