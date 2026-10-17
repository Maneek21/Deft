import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {drizzle} from 'drizzle-orm/node-postgres';
import {emailAccounts,emailTimers,notifications,emailMessages,emailMemberships,emailCheckpoints,emailProviderStates,emailSyncReceipts} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {PostgresEmailMailboxStore} from '../src/lib/email-mailbox-store.js';
import {EmailTimerStore} from '../src/lib/email-timer-store.js';

const scope={org_id:'org-scale',owner_user_id:'owner-scale',account_id:'account-scale'};
const logical=(n:number)=>'mail_'+n.toString(16).padStart(64,'0');
const schema={emailAccounts,emailTimers,notifications,emailMessages,emailMemberships,emailCheckpoints,emailProviderStates,emailSyncReceipts};

test('aggregate count transfers no unread IDs, keeps one array bind for 70000 snoozes, and snapshots checkpoint with count',async()=>{
  const statements:Array<{sql:string;values:unknown[]}>=[];
  const driver={async query(query:string|{text:string;rowMode?:string},values:unknown[]=[]){
    const text=typeof query==='string'?query:query.text;statements.push({sql:text,values});
    if(/^select count\(/.test(text))return {rows:[['100002']],rowCount:1};
    if(/from "email_checkpoints"/.test(text))return {rows:[[10,'complete',null,null,'idle']],rowCount:1};
    return {rows:[],rowCount:0};
  }};
  const store=new PostgresEmailMailboxStore(drizzle(driver as never,{schema}),{} as never);
  const hidden=Array.from({length:70000},(_,n)=>logical(n));
  const result=await store.readUnreadCount(scope,'inbox',hidden);
  assert.equal(result.cached_unread_count,100002);assert.equal(result.coverage,'complete');
  assert.match(statements[0]!.sql,/isolation level repeatable read read only/);
  const query=statements.find(row=>/^select count\(/.test(row.sql))!;
  assert.ok(query.values.length<32);assert.match(query.sql,/NOT \("email_messages"\."logical_message_id" = ANY\(\$\d+::text\[\]\)\)/);
  assert.equal((query.values.find(Array.isArray) as string[]).length,70000);
  assert.match(query.sql,/"deleted_at" is null/);assert.match(query.sql,/exists \(select/);
  for(const value of Object.values(scope))assert.ok(query.values.includes(value));
  assert.equal(statements.filter(row=>/^select/.test(row.sql)).length,2);
  assert.equal(statements.at(-1)?.sql,'commit');
});

test('sparse future snoozes validate encrypted scoped target, query future firing/scheduled only, and guard twice',async()=>{
  const statements:Array<{sql:string;values:unknown[]}>=[],guards:unknown[]=[];
  const timerId=randomUUID(),instant=new Date('2026-10-07T10:00:00.000Z');
  const crypto=new EmailMailboxCrypto({current:()=>({key_id:'synthetic',key:Buffer.alloc(32,19)}),read:()=>({key_id:'synthetic',key:Buffer.alloc(32,19)}),keyIds:()=>['synthetic']});
  const envelope=crypto.seal({logical_message_id:logical(1),kind:'snooze'},{...scope,kind:'timer',record_id:`timer:${timerId}`,revision:1});
  let digest=createHash('sha256').update(canonicalCapabilityJson(['deft.email.timer.target.v1',scope.org_id,scope.owner_user_id,scope.account_id,logical(1)])).digest('hex');
  const driver={async query(query:string|{text:string;rowMode?:string},values:unknown[]=[]){
    const text=typeof query==='string'?query:query.text;statements.push({sql:text,values});
    return /from "email_timers"/.test(text)?{rows:[[timerId,1,envelope,digest],[timerId,1,envelope,digest]],rowCount:2}:{rows:[],rowCount:0};
  }};
  const store=new EmailTimerStore(drizzle(driver as never,{schema}),crypto,()=>instant);
  assert.deepEqual([...await store.futureInboxMessageIds(scope,async tx=>{guards.push(tx);})],[logical(1)]);
  const query=statements.find(row=>/from "email_timers"/.test(row.sql))!;
  for(const value of [...Object.values(scope),'snooze','scheduled','firing',instant.toISOString()])assert.ok(query.values.includes(value));
  assert.match(query.sql,/"scheduled_at" > \$\d+/);assert.equal(guards.length,2);assert.equal(guards[0],guards[1]);
  assert.equal(statements.at(-1)?.sql,'commit');
  let calls=0;await assert.rejects(store.futureInboxMessageIds(scope,async()=>{if(++calls===2)throw Error('synthetic late denial');}),/synthetic late denial/);
  assert.equal(statements.at(-1)?.sql,'rollback');
  digest='0'.repeat(64);await assert.rejects(store.futureInboxMessageIds(scope,async()=>{}),/timer envelope mismatch/);
  assert.equal(statements.at(-1)?.sql,'rollback');
  await assert.rejects(store.futureInboxMessageIds({...scope,owner_user_id:'other-owner'},async()=>{}));
  assert.equal(statements.at(-1)?.sql,'rollback');
});
