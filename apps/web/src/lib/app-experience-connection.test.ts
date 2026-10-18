import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperienceConnection,experienceAuthorityResponse,type ExperienceAuthorityState} from './app-experience-connection';
test('exhausted transport failure pauses private presentation without terminal teardown',async()=>{
 let ended=0,hidden=0;
 const connection=createExperienceConnection({current:()=>true,valid:()=>true,read:async()=>{throw new TypeError('Exhausted network retries');},change:state=>{if(state==='denied')ended++;if(state==='unavailable')hidden++;}});
 assert.equal(await connection.check(),'unavailable');assert.equal(ended,0);assert.equal(hidden,1);
 connection.dispose();
});

test('broker waits through outage and resumes only after fresh successful authority',async()=>{
 let answer:ExperienceAuthorityState='unavailable',reads=0,settled=false;
 const connection=createExperienceConnection({current:()=>true,valid:()=>true,read:async()=>{reads++;return answer;},change:()=>{}});
 const waiting=connection.ensure().then(value=>{settled=true;return value;});
 await connection.check();await Promise.resolve();assert.equal(settled,false);
 answer='available';assert.equal(await connection.check(),'available');assert.equal(await waiting,true);
 await connection.check();assert.equal(reads,3,'successful permission is not cached');connection.dispose();
});
test('definitive revoke settles queued checks false and never reconnects automatically',async()=>{
 let answer:ExperienceAuthorityState='unavailable';
 const connection=createExperienceConnection({current:()=>true,valid:()=>true,read:async()=>answer,change:()=>{}});
 const waiting=connection.ensure();await connection.check();answer='denied';assert.equal(await connection.check(),'denied');
 assert.equal(await waiting,false);answer='available';assert.equal(await connection.check(),'denied');connection.dispose();
});
test('session replacement or disposal while response is pending cannot restore private data',async()=>{
 for(const dispose of [false,true]){let current=true,finish!:(value:ExperienceAuthorityState)=>void;
 const connection=createExperienceConnection({current:()=>current,valid:()=>true,read:()=>new Promise(resolve=>{finish=resolve;}),change:()=>{}});
 const checking=connection.ensure();if(dispose)connection.dispose();else current=false;finish('available');assert.equal(await checking,false);}
});
test('technical expiry never permits cached authority or pending operation dispatch',async()=>{
 let valid=true,answer:ExperienceAuthorityState='unavailable';
 const connection=createExperienceConnection({current:()=>true,valid:()=>valid,read:async()=>answer,change:()=>{}});
 const waiting=connection.ensure();await connection.check();valid=false;answer='available';await connection.check();assert.equal(await waiting,false);
});

test('only authenticated denial is terminal; server overload and absence remain unavailable',()=>{
 for(const status of [401,403,404,409,422])assert.equal(experienceAuthorityResponse(new Response(null,{status})),'denied');
 for(const status of [408,429,500,502,503,504])assert.equal(experienceAuthorityResponse(new Response(null,{status})),'unavailable');
 assert.equal(experienceAuthorityResponse(null),'unavailable');assert.equal(experienceAuthorityResponse(new Response()),'available');
});
