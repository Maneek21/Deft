import assert from 'node:assert/strict';
import test from 'node:test';
import { createExperienceSuspension, experienceOperationAllowedWhileHidden } from './app-experience-suspension';
import { experienceLifetimeIsCurrent } from './app-experience-session';
import { isSameWebSession } from './api';

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
