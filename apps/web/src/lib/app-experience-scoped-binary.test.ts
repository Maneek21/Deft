import test from 'node:test';
import assert from 'node:assert/strict';
import {readExperienceScopedBinary} from './app-experience-scoped-binary';
test('source and file ports enforce exact metadata/limits and discard late changed authority',async()=>{
 for(const changed of ['media','size','filename','scope','source_limit'] as const){let live=true;const bytes=new Uint8Array(changed==='source_limit'?36700161:8);await assert.rejects(readExperienceScopedBinary({signal:new AbortController().signal,current:()=>live,mediaType:'message/rfc822',maxBytes:36700160,size:changed==='size'?9:undefined,filename:changed==='filename'?'other.eml':undefined,read:async()=>{if(changed==='scope')live=false;return {bytes,media_type:changed==='media'?'text/html':'message/rfc822',filename:'message.eml'};}}));assert.ok(bytes.every(byte=>byte===0));}
});
test('held original-source port is bounded and late bytes wiped without replay',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let release!:(value:{bytes:Uint8Array;media_type:string;filename:string})=>void,reads=0;
 const pending=readExperienceScopedBinary({signal:new AbortController().signal,current:()=>true,mediaType:'message/rfc822',maxBytes:36700160,read:()=>{reads++;return new Promise(resolve=>{release=resolve;});}});
 t.mock.timers.tick(30000);await assert.rejects(pending);const bytes=new Uint8Array([8]);release({bytes,media_type:'message/rfc822',filename:'message.eml'});await Promise.resolve();assert.equal(bytes[0],0);assert.equal(reads,1);
});
