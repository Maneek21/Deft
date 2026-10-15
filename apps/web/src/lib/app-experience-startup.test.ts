import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceStartup, experienceStartupStatus} from './app-experience-startup';

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
