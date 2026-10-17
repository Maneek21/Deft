import assert from 'node:assert/strict';
import test from 'node:test';
import { createExperienceSuspension, experienceOperationAllowedWhileHidden } from './app-experience-suspension';
import { experienceLifetimeIsCurrent } from './app-experience-session';
import { isSameWebSession } from './api';
import {createExperienceConnection} from './app-experience-connection';

const token = (sid: string, exp: number) => `header.${Buffer.from(JSON.stringify({id:'owner',org_id:'org',sid,exp})).toString('base64url')}.signature`;

test('hide and return flush final edits and restore only after revalidation', async () => {
  const calls: string[] = []; let hidden = true;
  const suspension = createExperienceSuspension({current:()=>true,live:async()=>true,hidden:()=>hidden,
    flush:()=>calls.push('last edits'),clear:()=>calls.push('clear'),restore:()=>calls.push('restore'),end:()=>calls.push('retire')});
  suspension.hide(); assert.deepEqual(calls,['last edits','clear']); hidden=false;
  assert.equal(await suspension.show(),true); assert.deepEqual(calls,['last edits','clear','restore']);
});

test('hidden operation policy permits only private-state put, not reads, deletion or external actions', () => {
  assert.equal(experienceOperationAllowedWhileHidden('private_state',{operation:'put'}),true);
  for(const operation of ['list','read','delete']) assert.equal(experienceOperationAllowedWhileHidden('private_state',{operation}),false);
  for(const operation of ['resource','action','dialog','navigate','open_resource','run_status']) assert.equal(experienceOperationAllowedWhileHidden(operation,{operation:'put'}),false);
});

test('same SID rotation preserves original interval; new SID, expiry and revocation end without rendering', async () => {
  const initial=token('original',200);let currentToken=token('original',400),now=1000,authority=true,ends=0,renders=0;
  const suspension=createExperienceSuspension({current:()=>isSameWebSession(initial,currentToken)&&experienceLifetimeIsCurrent(new Date(3000).toISOString(),new Date(2000).toISOString(),now),
    live:async()=>authority,hidden:()=>false,flush:()=>{},clear:()=>{},restore:()=>renders++,end:()=>ends++});
  assert.equal(await suspension.show(),true);assert.equal(renders,1);
  currentToken=token('replacement',400);assert.equal(await suspension.show(),false);assert.equal(ends,1);
  currentToken=token('original',400);now=2000;assert.equal(await suspension.show(),false);assert.equal(ends,2);
  now=1000;authority=false;assert.equal(await suspension.show(),false);assert.equal(ends,3);assert.equal(renders,1);
});

test('late resumed callback cannot restore after a second hide or disposal', async () => {
  let finish!: (value:boolean)=>void;let renders=0;
  const suspension=createExperienceSuspension({current:()=>true,live:()=>new Promise(resolve=>{finish=resolve}),hidden:()=>false,
    flush:()=>{},clear:()=>{},restore:()=>renders++,end:()=>{}});
  const first=suspension.show();suspension.hide();finish(true);assert.equal(await first,false);assert.equal(renders,0);
  const second=suspension.show();suspension.dispose();finish(true);assert.equal(await second,false);assert.equal(renders,0);
});

test('an obsolete failed revalidation cannot end a newer successful resume', async () => {
  const checks: Array<(value: boolean) => void> = [];
  let renders = 0, ends = 0;
  const suspension = createExperienceSuspension({ current: () => true,
    live: () => new Promise(resolve => checks.push(resolve)), hidden: () => false,
    flush: () => {}, clear: () => {}, restore: () => renders++, end: () => ends++ });
  const oldReturn = suspension.show();
  suspension.hide();
  const latestReturn = suspension.show();
  checks[1]!(true);
  assert.equal(await latestReturn, true);
  checks[0]!(false);
  assert.equal(await oldReturn, false);
  assert.equal(renders, 1);
  assert.equal(ends, 0, 'a stale network failure must not close the current app');

  const currentReturn = suspension.show();
  checks[2]!(false);
  assert.equal(await currentReturn, false);
  assert.equal(ends, 1, 'failure of the current authority check remains terminal');
});

test('unresolved connection recovery is bounded, stays suspended and retries only fresh authority',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,restored=0,ended=0,notices=0;const signals:AbortSignal[]=[];
 const suspension=createExperienceSuspension({current:()=>true,hidden:()=>false,flush:()=>{},clear:()=>{},restore:()=>restored++,end:()=>ended++,unavailable:()=>notices++,
  live:async signal=>{signals.push(signal);if(++calls===1)return await new Promise<boolean>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return true;}});
 const pending=suspension.show();t.mock.timers.tick(10000);assert.equal(await pending,false);assert.equal(signals[0]!.aborted,true);assert.equal(notices,1);assert.equal(restored,0);assert.equal(ended,0);
 assert.equal(await suspension.show(),true);assert.equal(restored,1);assert.equal(calls,2);assert.notEqual(signals[0],signals[1]);suspension.dispose();
});
test('a current denied resume is terminal and never becomes a retry notice',async()=>{
 let ends=0,notices=0;const suspension=createExperienceSuspension({current:()=>true,hidden:()=>false,live:async()=>false,flush:()=>{},clear:()=>{},restore:()=>assert.fail('denied view'),end:()=>ends++,unavailable:()=>notices++});
 assert.equal(await suspension.show(),false);assert.equal(ends,1);assert.equal(notices,0);suspension.dispose();
});

test('actual unavailable connection waiter cannot leave visibility resume pending forever',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let available=false,restores=0,notices=0,reads=0;
 const connection=createExperienceConnection({current:()=>true,valid:()=>true,read:async()=>{reads++;return available?'available':'unavailable';},change:()=>{}});
 const suspension=createExperienceSuspension({current:()=>true,hidden:()=>false,live:signal=>connection.ensure(signal),flush:()=>{},clear:()=>{},restore:()=>restores++,end:()=>assert.fail('transient recovery must not retire authority'),unavailable:()=>notices++});
 const pending=suspension.show();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(connection.state,'unavailable');t.mock.timers.tick(10000);assert.equal(await pending,false);assert.equal(restores,0);assert.equal(notices,1);
 available=true;assert.equal(await suspension.show(),true);assert.equal(restores,1);assert.equal(reads,2);suspension.dispose();connection.dispose();
});

test('resume deadline remains bounded even if a shared authority read ignores cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let restores=0,notices=0;
 const suspension=createExperienceSuspension({current:()=>true,hidden:()=>false,live:()=>new Promise<boolean>(()=>{}),flush:()=>{},clear:()=>{},restore:()=>restores++,end:()=>assert.fail('uncertainty is not denial'),unavailable:()=>notices++});
 const pending=suspension.show();t.mock.timers.tick(10000);assert.equal(await pending,false);assert.equal(restores,0);assert.equal(notices,1);suspension.dispose();
});
