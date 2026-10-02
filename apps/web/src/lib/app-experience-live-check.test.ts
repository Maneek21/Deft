import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceLease, type ExperienceLease} from './app-experience-lease';
import {createExperienceLiveCheck} from './app-experience-live-check';
const at=(time:number):ExperienceLease=>({session_expires_at:new Date(time).toISOString(),exposure:{exposure_id:'grant',exposure_epoch:0,review_digest:'scope',expires_at:new Date(time).toISOString()}});
test('delayed exposure response crossing renewal window cannot falsely retire current lease',async()=>{
 let now=0,reads=0,refreshes=0,finish!:()=>void;
 const lease=createExperienceLease({initial:at(100000),now:()=>now,current:()=>true,refresh:async()=>{refreshes++;return at(1000000);}});
 const live=createExperienceLiveCheck({current:()=>true,valid:lease.valid,check:async()=>{
   await lease.ensure();const status={...lease.value.exposure};reads++;
   if(reads===1)await new Promise<void>(resolve=>{finish=resolve;});
   return lease.valid()&&status.expires_at===lease.value.exposure.expires_at;
 }});
 const first=live();await Promise.resolve();await Promise.resolve();now=20000;
 const second=live();await Promise.resolve();await Promise.resolve();finish();
 assert.deepEqual(await Promise.all([first,second]),[true,true]);
 assert.equal(reads,1);assert.equal(refreshes,0);
 assert.equal(await live(),true);assert.equal(reads,2);assert.equal(refreshes,1);
});
test('revocation or teardown while authority response is pending rejects all callers',async()=>{
 let current=true,finish!:(value:boolean)=>void;
 const live=createExperienceLiveCheck({current:()=>current,valid:()=>current,check:()=>new Promise(resolve=>{finish=resolve;})});
 const first=live(),second=live();await Promise.resolve();current=false;finish(true);
 assert.deepEqual(await Promise.all([first,second]),[false,false]);assert.equal(await live(),false);
});
test('shared denial is not cached and subsequent checks require a new response',async()=>{
 let calls=0;
 const live=createExperienceLiveCheck({current:()=>true,valid:()=>true,check:async()=>{calls++;return calls>1;}});
 assert.deepEqual(await Promise.all([live(),live()]),[false,false]);assert.equal(await live(),true);assert.equal(calls,2);
});
