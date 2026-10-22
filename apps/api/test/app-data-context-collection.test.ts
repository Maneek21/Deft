import test from 'node:test';
import assert from 'node:assert/strict';
import {collectAppDataContext} from '../src/lib/app-data-context-collection.js';

test('context collects eleven stores with two fresh authority captures, never a cross-request cache',async()=>{
 let captures=0,finished=0,consents=0;
 const ports={capture:async()=>{captures++;return {scope:'original',revision:3};},identity:(base:unknown)=>base,
  stores:async()=>{consents++;return Array.from({length:11},(_,i)=>({key:String(i)}));},
  metadata:async()=>['identity'],finish:async()=>{finished++;},denied:()=>Error('DENIED')};
 const first=await collectAppDataContext(ports);assert.equal(first.stores.length,11);assert.equal(captures,2);assert.equal(consents,1);assert.equal(finished,1);
 await collectAppDataContext(ports);assert.equal(captures,4);
});

test('changed connection, scope, account, policy or exposure never discloses metadata collected earlier',async()=>{
 for(const key of ['scope','connection','policy','exposure']){
  let calls=0,stores=0;
  await assert.rejects(collectAppDataContext({capture:async()=>({scope:'s',connection:'c',policy:'p',exposure:'e',...(calls++?{[key]:'replaced'}:{})}),identity:base=>base,
   metadata:async()=>['private'],stores:async()=>{stores++;return [];},finish:async()=>{},denied:()=>Error('DENIED')}),/DENIED/);
  assert.equal(stores,0);
 }
});

test('final consent state and terminal session check govern disclosure; no retries on denial',async()=>{
 let revoked=false,captures=0;
 const ports={capture:async()=>{captures++;return {id:'same'};},identity:(base:unknown)=>base,
  metadata:async()=>{revoked=true;return ['private'];},stores:async()=>revoked?[]:['store'],finish:async()=>{},denied:()=>Error('DENIED')};
 assert.deepEqual((await collectAppDataContext(ports)).stores,[]);assert.equal(captures,2);
 await assert.rejects(collectAppDataContext({...ports,finish:async()=>{throw Error('REVOKED');}}),/REVOKED/);
});


test('metadata-free resolution performs one final fresh capture immediately before stores and terminal saved checks',async()=>{
 const calls:string[]=[];
 const ports={capture:async()=>{calls.push('capture');return {revision:3};},identity:(base:unknown)=>base,
  stores:async()=>{calls.push('stores');return ['current'];},finish:async()=>{calls.push('finish');},denied:()=>Error('DENIED')};
 const result=await collectAppDataContext(ports);assert.deepEqual(calls,['capture','stores','finish']);assert.deepEqual(result.identities,[]);
 calls.length=0;await collectAppDataContext(ports);assert.deepEqual(calls,['capture','stores','finish'],'later requests capture again');
 for(const phase of ['capture','stores','finish'] as const){calls.length=0;
  await assert.rejects(collectAppDataContext({...ports,[phase]:async()=>{throw Error('CURRENT_FENCE_DENIED');}}),/CURRENT_FENCE_DENIED/);
 }
});
