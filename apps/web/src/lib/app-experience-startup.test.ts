import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceStartup, experienceStartupStatus} from './app-experience-startup';
import {createExperienceSuspension} from './app-experience-suspension';

test('a hidden opening waits for current authority before spending its visible startup budget', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const failures:string[]=[];let hidden=true,allowed=false,starts=0;
  const startup=createExperienceStartup(phase=>failures.push(phase),{hidden:()=>hidden});
  const suspension=createExperienceSuspension({current:()=>true,hidden:()=>hidden,live:async()=>allowed,
    flush:()=>{},clear:()=>startup.pause(),restore:()=>{startup.resume();starts++;},end:()=>startup.dispose()});
  startup.ready();
  t.mock.timers.tick(60_000);
  assert.deepEqual(failures,[],'a background tab cannot fail before its Worker may start');
  hidden=false;allowed=true;
  assert.equal(await suspension.show(),true);assert.equal(starts,1);
  startup.started();t.mock.timers.tick(29_999);assert.deepEqual(failures,[]);
  startup.view();t.mock.timers.tick(60_000);assert.deepEqual(failures,[]);
  suspension.dispose();startup.dispose();
});

test('visibility pauses retain one finite startup budget across repeated returns', t => {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const failures:string[]=[];const startup=createExperienceStartup(phase=>failures.push(phase));
  t.mock.timers.tick(12_000);startup.pause();startup.pause();
  t.mock.timers.tick(60_000);assert.deepEqual(failures,[]);
  startup.resume();startup.resume();t.mock.timers.tick(8_000);startup.pause();
  t.mock.timers.tick(60_000);assert.deepEqual(failures,[]);
  startup.ready();startup.resume();t.mock.timers.tick(9_999);assert.deepEqual(failures,[]);
  t.mock.timers.tick(1);assert.deepEqual(failures,['worker_start']);
  startup.resume();t.mock.timers.tick(60_000);assert.deepEqual(failures,['worker_start']);
});

test('startup deadline identifies the last acknowledged phase and never retries', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for (const phase of ['bootstrap','worker_start','first_view'] as const) {
    const failures:string[]=[];
    const startup=createExperienceStartup(value=>failures.push(value));
    if(phase!=='bootstrap')startup.ready();
    if(phase==='first_view')startup.started();
    t.mock.timers.tick(29_999);assert.deepEqual(failures,[]);
    t.mock.timers.tick(1);assert.deepEqual(failures,[phase]);
    t.mock.timers.tick(60_000);startup.fail();assert.deepEqual(failures,[phase]);
  }
});

test('first rendered view cancels startup timeout but an actual Worker failure still ends its lifetime', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const failures:string[]=[];
  const startup=createExperienceStartup(value=>failures.push(value));
  startup.ready();startup.started();startup.view();
  t.mock.timers.tick(60_000);assert.deepEqual(failures,[]);
  startup.fail('worker_runtime');startup.fail('worker_runtime');
  assert.deepEqual(failures,['worker_runtime']);
});

test('phase changes do not extend the overall startup deadline', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const failures:string[]=[];
  const startup=createExperienceStartup(value=>failures.push(value));
  t.mock.timers.tick(20_000);startup.ready();
  t.mock.timers.tick(9_999);startup.started();assert.deepEqual(failures,[]);
  t.mock.timers.tick(1);assert.deepEqual(failures,['first_view']);
});

test('retired startup ignores late timeout and Worker status', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const failures:string[]=[];
  const startup=createExperienceStartup(value=>failures.push(value));
  startup.dispose();startup.ready();startup.started();startup.fail('worker_start');
  t.mock.timers.tick(60_000);assert.deepEqual(failures,[]);
});

test('startup status is accepted only from the exact opaque frame and session without extra data',()=>{
  const frame={} as Window,session='11111111-1111-4111-8111-111111111111';
  const event={source:frame,origin:'null',data:{kind:'deft_experience_bootstrap_status.v1',session_id:session,state:'started',phase:'first_view'}};
  assert.equal(experienceStartupStatus(event,frame,session),'started');
  for(const patch of [{source:{}},{origin:'https://deft.test'},{data:{...event.data,session_id:'old'}},{data:{...event.data,private_error:'secret'}},{data:{...event.data,phase:'unknown'}}])
    assert.equal(experienceStartupStatus({...event,...patch} as MessageEvent,frame,session),null);
  assert.equal(experienceStartupStatus(event,null,session),null);
  assert.equal(experienceStartupStatus({...event,data:{...event.data,state:'failed',phase:'worker_runtime'}},frame,session),'worker_runtime');
});
