import assert from 'node:assert/strict';import test from 'node:test';
import {createRecordEventDelivery} from './app-experience-record-event-delivery';
const tick=()=>new Promise<void>(resolve=>queueMicrotask(resolve));
const event=(revision:number,record_state='saved')=>({record_revision:revision,record_state});
test('slow live delivery coalesces pending snapshots, accepts only the delivered exact event, and preserves submitted order',async()=>{
 const sent:unknown[]=[],accepted:unknown[]=[];let release!:(value:boolean)=>void;
 const delivery=createRecordEventDelivery({current:()=>true,send:next=>{sent.push(next);return sent.length===1?new Promise<boolean>(resolve=>release=resolve):true;},accepted:next=>accepted.push(next)});
 const first=event(0,'unsaved'),latest=event(7),submitted=event(7,'submitted');const a=delivery.send(first),discarded=delivery.send(event(0,'saving')),b=delivery.send(latest),c=delivery.send(submitted);
 assert.equal(await discarded,false);assert.equal(sent.length,1);assert.equal(accepted.length,0);release(true);
 assert.equal(await a,true);assert.equal(await b,true);assert.equal(await c,true);assert.deepEqual(sent,[first,latest,submitted]);assert.deepEqual(accepted,sent);
});
test('false, undefined, rejected or no-longer-current delivery never acknowledges a reference',async()=>{
 for(const result of [false,undefined,Promise.reject(Error('denied'))]){let ack=0;const delivery=createRecordEventDelivery({current:()=>true,send:()=>result,accepted:()=>ack++});assert.equal(await delivery.send(event(1)),false);assert.equal(ack,0);}
 let current=true,ack=0,release!:(value:boolean)=>void;const delivery=createRecordEventDelivery({current:()=>current,send:()=>new Promise<boolean>(resolve=>release=resolve),accepted:()=>ack++});const sent=delivery.send(event(1));const queued=delivery.send(event(2));current=false;release(true);assert.equal(await sent,false);assert.equal(await queued,false);assert.equal(ack,0);
});
test('dispose cancels pending snapshots and seed is an ordering barrier',async()=>{
 let release!:(value:boolean)=>void,calls=0;const accepted:unknown[]=[];const delivery=createRecordEventDelivery({current:()=>true,send:()=>{calls++;return new Promise<boolean>(resolve=>release=resolve)},accepted:next=>accepted.push(next)});
 const first=delivery.send(event(0));const seed=delivery.send({...event(0),record_seed:true});const latest=delivery.send(event(1));delivery.dispose();assert.equal(await seed,false);assert.equal(await latest,false);release(true);assert.equal(await first,false);assert.equal(calls,1);assert.equal(accepted.length,0);await tick();
});
test('nonreplaceable events remain bounded while a delivery waits',async()=>{
 let release!:(value:boolean)=>void;const delivery=createRecordEventDelivery({current:()=>true,send:()=>new Promise<boolean>(resolve=>release=resolve),accepted:()=>{}});
 const first=delivery.send(event(0));const queued=Array.from({length:16},()=>delivery.send({...event(0),record_seed:true}));assert.equal(await delivery.send({...event(0),record_seed:true}),false);delivery.dispose();release(true);assert.equal(await first,false);assert.deepEqual(await Promise.all(queued),Array(16).fill(false));
});
