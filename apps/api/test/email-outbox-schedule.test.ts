import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolveEmailOutboxSchedule} from '../src/lib/email-outbox-schedule.js';
import {EmailOutboxCrypto} from '../src/lib/email-outbox-crypto.js';
import {createEmailOutboxJobHandler} from '../src/lib/email-outbox-job.js';
test('schedule resolves DST folds only with explicit choice and rejects gaps/invalid zones/dates',()=>{
 const now=new Date('2026-01-01T00:00:00Z'),input={wall_time:'2026-11-01T01:30',zone:'America/New_York',ambiguity:'reject',missed_policy:'send_when_available'};
 assert.throws(()=>resolveEmailOutboxSchedule(input,now),/AMBIGUOUS/);
 assert.equal(resolveEmailOutboxSchedule({...input,ambiguity:'earlier'},now).instant,'2026-11-01T05:30:00.000Z');
 assert.equal(resolveEmailOutboxSchedule({...input,ambiguity:'later'},now).instant,'2026-11-01T06:30:00.000Z');
 assert.throws(()=>resolveEmailOutboxSchedule({...input,wall_time:'2026-03-08T02:30'},now),/GAP/);
 assert.throws(()=>resolveEmailOutboxSchedule({...input,wall_time:'2026-02-30T12:00'},now),/INVALID/);
 assert.throws(()=>resolveEmailOutboxSchedule({...input,zone:'not/a-zone'},now),/INVALID/);
 assert.throws(()=>resolveEmailOutboxSchedule({...input,wall_time:'2025-12-31T12:00',zone:'UTC'},now),/PAST/);
});
test('half-hour DST ambiguity and saved UTC instant remain independent of machine timezone',()=>{
 const input={wall_time:'2026-04-05T01:45',zone:'Australia/Lord_Howe',ambiguity:'earlier',missed_policy:'pause_if_late'},now=new Date('2026-01-01Z');
 assert.equal(resolveEmailOutboxSchedule(input,now).instant,'2026-04-04T14:45:00.000Z');
 assert.equal(resolveEmailOutboxSchedule({...input,ambiguity:'later'},now).instant,'2026-04-04T15:15:00.000Z');
 const saved=resolveEmailOutboxSchedule({...input,zone:'Asia/Kolkata'},now);assert.equal(saved.instant,'2026-04-04T20:15:00.000Z');assert.match(saved.rules_version,/node-tz:/);
});
test('outbox MIME encryption rejects alternate scope/digest/op identity and tampering',()=>{
 const keys={current:()=>({key_id:'outbox-test',key:Buffer.alloc(32,17)}),read:(_p:unknown,id:string)=>({key_id:id,key:Buffer.alloc(32,17)}),keyIds:()=>['outbox-test']};
 const cipher=new EmailOutboxCrypto(keys),context={org_id:'org',owner_user_id:'owner',account_id:'account',outbox_id:randomUUID(),operation_id:randomUUID(),mime_digest:'a'.repeat(64)},bytes=Buffer.from('private full MIME');
 const sealed=cipher.seal(context,bytes);assert.equal(sealed.ciphertext.includes(bytes),false);assert.deepEqual(cipher.open(context,sealed),bytes);
 for(const changed of [{account_id:'other'},{owner_user_id:'other'},{operation_id:randomUUID()},{mime_digest:'b'.repeat(64)}])assert.throws(()=>cipher.open({...context,...changed},sealed));
 assert.throws(()=>cipher.seal({...context,outbox_id:'a'.repeat(36)},bytes));assert.throws(()=>cipher.seal({...context,operation_id:'-'.repeat(36)},bytes));
 const tampered={...sealed,ciphertext:Buffer.from(sealed.ciphertext)};tampered.ciphertext[0]=tampered.ciphertext[0]!^1;assert.throws(()=>cipher.open(context,tampered));
});
test('worker uses exact lease without human identity and only defers known predispatch waiting',async()=>{
 let received:any;const defer=()=>Error('DEFER'),handler=createEmailOutboxJobHandler({enabled:()=>true,defer,dispatch:async(scope,lease)=>{received={scope,lease};return {state:'waiting',delay_ms:6000};}}),data={org_id:'org',owner_user_id:'owner',account_id:'account',outbox_id:randomUUID(),operation_id:randomUUID(),authority_revision:2};
 await assert.rejects(handler({id:randomUUID(),name:'native-email-outbox',data,lockToken:'lease',attempts:1}),/DEFER/);assert.equal(received.lease.job_name,'native-email-outbox');assert.equal('web_session_id' in received.lease,false);
 await assert.rejects(handler({id:randomUUID(),name:'native-email-outbox',data,attempts:1}),/LEASE_DENIED/);
});
