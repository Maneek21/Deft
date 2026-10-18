import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {inspectEmailSourceFiles} from './incoming-source-files.mjs';
const CAP=262144,reference=value=>Buffer.from(value,'utf8').subarray(0,CAP).toString('utf8').replace(/\ufffd$/u,'');
const expression=readFileSync(process.env.DEFT_M18_BOUNDED_SOURCE??new URL('./incoming-source-files.mjs',import.meta.url),'utf8').match(/^const bounded=(.*);$/mu)?.[1];assert.ok(expression);
function production(onEncode=()=>{}){return vm.runInNewContext('('+expression+')',{MAX_HTML:CAP,Buffer:{from:(value,...rest)=>{onEncode(value);return Buffer.from(value,...rest);}}});}
test('actual bounded presentation helper matches retained byte semantics at ASCII, Latin1, surrogate and replacement boundaries',()=>{
 const bounded=production(),values=['','ASCII','é','😀','\ud800','\udc00','legitimate\ufffd',Buffer.from([0xff,0x80,0xfe]).toString('utf8'),
  ...['A','é','漢','😀','\ud800','\udc00','\ufffd'].flatMap(value=>[value.repeat(CAP-1),value.repeat(CAP),value.repeat(CAP+1)]),
  'A'.repeat(CAP-1)+'😀TAIL','A'.repeat(CAP-2)+'😀TAIL','A'.repeat(CAP)+'\ud800TAIL',
  'é'.repeat(CAP/2-1)+'\ufffdTAIL',Buffer.alloc(CAP+7,0xff).toString('utf8')];
 for(const value of values)assert.equal(bounded(value),reference(value),JSON.stringify(value.slice(-12)));
});
test('actual bounded helper limits UTF8 encoding input before allocation even for long malformed-decoded content',()=>{
 let largest=0;const bounded=production(value=>largest=Math.max(largest,value.length));
 const input=Buffer.alloc(CAP+9,0xff).toString('utf8');assert.equal(bounded(input),reference(input));assert.ok(largest<=CAP,`UTF16 encode input ${largest} exceeds ${CAP}`);
});
test('actual native MIME retains byte-identical bounded plain text and truthful truncation for malformed UTF8 source',async()=>{
 const body=Buffer.concat([Buffer.from('BODY_PRESERVED\r\n'),Buffer.alloc(CAP+11,0xff)]),bytes=Buffer.concat([Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\n'),body]);
 try{const result=await inspectEmailSourceFiles(bytes,{profile:'native',presentation:true});assert.match(result.presentation.plain_text,/BODY_PRESERVED/);assert.equal(result.presentation.truncated,true);assert.equal(result.presentation.plain_text,reference(body.toString('utf8').replace(/\r\n/gu,'\n')));assert.ok(Buffer.byteLength(result.presentation.plain_text)<=CAP);}finally{bytes.fill(0);body.fill(0);}
});
