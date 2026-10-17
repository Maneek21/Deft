import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicPackageValidationMemo } from '../src/lib/app-public-package-validation-memo.js';

test('memo keys exact fresh public bytes and preserves values without aliases',async()=>{
 let calls=0;const memo=createPublicPackageValidationMemo(async raw=>{calls++;return {raw,nested:{value:1},optional:undefined};});
 const first=await memo('{"a":1}');first.nested.value=9;const second=await memo('{"a":1}');assert.equal(second.nested.value,1);assert.ok(Object.hasOwn(second,'optional'));second.nested.value=8;assert.equal((await memo('{"a":1}')).nested.value,1);assert.equal(calls,1);
 await memo('{"a":1 }');await memo('{"a":2}');assert.equal(calls,3);
});
test('failed validation is never retained',async()=>{
 let calls=0;const memo=createPublicPackageValidationMemo(async()=>{calls++;throw Error('synthetic');});await assert.rejects(memo('bad'));await assert.rejects(memo('bad'));assert.equal(calls,2);
});
test('memo evicts at entry bound and refuses oversized serialized output',async()=>{
 let calls=0;const memo=createPublicPackageValidationMemo(async raw=>{calls++;return {raw};},{entries:2,bytes:1000,entryBytes:500});await memo('a');await memo('b');await memo('c');await memo('a');assert.equal(calls,4);
 let largeCalls=0;const large=createPublicPackageValidationMemo(async()=>{largeCalls++;return 'x'.repeat(1000);},{entries:8,bytes:1000,entryBytes:100});await large('same');await large('same');assert.equal(largeCalls,2);
});
test('memo enforces total serialized byte bound',async()=>{
 let calls=0;const memo=createPublicPackageValidationMemo(async raw=>{calls++;return raw.repeat(30);},{entries:8,bytes:100,entryBytes:100});await memo('aa');await memo('bb');await memo('aa');assert.equal(calls,3);
});
test('Web Crypto disappearance does not turn a cached validation into success',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');assert.ok(descriptor);let calls=0;const memo=createPublicPackageValidationMemo(async()=>{calls++;if(!globalThis.crypto?.subtle)throw Error('crypto unavailable');return {ok:true};});await memo('same');Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});try{await assert.rejects(memo('same'));assert.equal(calls,2);}finally{Object.defineProperty(globalThis,'crypto',descriptor);}
});
