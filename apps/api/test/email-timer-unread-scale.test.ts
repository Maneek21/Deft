import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {drizzle} from 'drizzle-orm/node-postgres';
import {emailAccounts,emailTimers,notifications} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {EmailTimerStore} from '../src/lib/email-timer-store.js';

const scope={org_id:'org-scale',owner_user_id:'owner-scale',account_id:'account-scale'};
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');
const digest=(id:string)=>createHash('sha256').update(canonicalCapabilityJson(['deft.email.timer.target.v1',scope.org_id,scope.owner_user_id,scope.account_id,id])).digest('hex');

test('large unread snooze lookup keeps one bounded array bind and both authority guards in the same transaction',async()=>{
  const statements:Array<{sql:string;values:unknown[]}>=[],guards:unknown[]=[];
  const driver={async query(query:string|{text:string;rowMode?:string},values:unknown[]=[]){
    const sql=typeof query==='string'?query:query.text;statements.push({sql,values});
    if(/^(begin|commit|rollback)/i.test(sql))return {rows:[],rowCount:0};
    assert.match(sql,/from "email_timers"/);
    const hidden=digest(logical(81159));return {rows:typeof query!=='string'&&query.rowMode==='array'?[[hidden]]:[{logical_message_digest:hidden}],rowCount:1};
  }};
  const db=drizzle(driver as never,{schema:{emailAccounts,emailTimers,notifications}});
  const store=new EmailTimerStore(db,{} as never,()=>new Date('2026-10-07T10:00:00.000Z'));
  const ids=Array.from({length:81160},(_,n)=>logical(n));
  const hidden=await store.hiddenInboxMessageIds(scope,ids,async tx=>{guards.push(tx);});
  assert.deepEqual([...hidden],[logical(81159)]);
  const query=statements.find(row=>/from "email_timers"/.test(row.sql))!;
  assert.ok(query.values.length<32,`Large unread query generated ${query.values.length} parameters; PostgreSQL allows 65535`);
  assert.match(query.sql,/= ANY\(\$\d+::text\[\]\)/);
  const array=query.values.find(Array.isArray) as string[];assert.equal(array.length,81160);
  for(const value of Object.values(scope))assert.ok(query.values.includes(value));
  assert.ok(query.values.includes('snooze'));assert.ok(query.values.includes('scheduled'));assert.ok(query.values.includes('firing'));
  assert.equal(guards.length,2);assert.equal(guards[0],guards[1]);assert.equal(statements.at(-1)?.sql,'commit');
});

test('empty unread lookup issues no query and late authority denial rolls back the array lookup',async()=>{
  const statements:string[]=[];let guards=0;
  const driver={async query(query:string|{text:string}){const sql=typeof query==='string'?query:query.text;statements.push(sql);return {rows:[],rowCount:0};}};
  const store=new EmailTimerStore(drizzle(driver as never,{schema:{emailAccounts,emailTimers,notifications}}),{} as never);
  assert.equal((await store.hiddenInboxMessageIds(scope,[],async()=>{guards++;})).size,0);
  assert.equal(guards,0);assert.equal(statements.length,0);
  await assert.rejects(store.hiddenInboxMessageIds(scope,[logical(1)],async()=>{if(++guards===2)throw Error('synthetic revoked');}),/synthetic revoked/);
  assert.equal(statements.at(-1),'rollback');assert.equal(statements.filter(sql=>/from "email_timers"/.test(sql)).length,1);
});
