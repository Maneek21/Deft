import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createEmailSendJournal} from './outgoing-operation-store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEmailFileCustodyStore} from './providers/custody-file-store.mjs';

function fixture(){
 const rows=new Map(),queue=new Map();const store={async withLock({key},fn){const previous=queue.get(key)??Promise.resolve();let release;
  const waiting=new Promise(resolve=>{release=resolve;});queue.set(key,waiting);await previous;
  try{return await fn({read:async()=>structuredClone(rows.get(key)??null),compareAndSwap:async({expected_revision,value})=>{
   const row=rows.get(key);if((row?.revision??null)!==expected_revision)return false;rows.set(key,{revision:(row?.revision??0)+1,value:structuredClone(value)});return true;
  }});}finally{release();if(queue.get(key)===waiting)queue.delete(key);}}};
 const identity={operation_id:'mail-'+randomUUID(),snapshot_id:randomUUID(),snapshot_digest:'a'.repeat(64),mime_digest:'b'.repeat(64),
  scope:{org_id:'synthetic-org',owner_id:'private-owner',installation_id:'synthetic-install'},account_id:'private-account',authority_epoch:1,draft_id:randomUUID(),draft_revision:2};
 const full={...identity,run_id:identity.operation_id.slice(5),resource_binding_id:randomUUID(),action_binding_id:randomUUID()};
 const options={store,encryption_key:new Uint8Array(32).fill(9),key_id:'journal-test'};
 const journal=()=>createEmailSendJournal(options);
 return {journal,rows,identity,full,options};
}
test('restart preserves reservation, exclusive provider admission and immutable accepted outcome',async()=>{
 const f=fixture();assert.equal(await f.journal().reserve(f.identity),'reserved');assert.equal(await f.journal().reserve(f.identity),'replay');
 assert.deepEqual(await Promise.all([f.journal().reserveTransport(f.full),f.journal().reserveTransport(f.full)]),[true,false]);
 const output={operation_id:f.identity.operation_id,transport_outcome:'provider_accepted',sent_copy_outcome:'pending'};
 assert.equal(await f.journal().recordOutcome({identity:f.full,state:'accepted',output}),true);
 assert.equal(await f.journal().recordOutcome({identity:f.full,state:'unknown'}),false);
 assert.deepEqual(await f.journal().readOutcome(f.full),{identity:f.full,state:'accepted',output});
 assert.equal(await f.journal().reserveTransport(f.full),false);assert.equal(await f.journal().reserve(f.identity),'replay');
 const disk=JSON.stringify([...f.rows.values()]);for(const secret of ['private-owner','private-account','provider_accepted'])assert.equal(disk.includes(secret),false);
});
test('changed payload identity, altered ciphertext, wrong key and uncertain outcome never authorize resend',async()=>{
 const f=fixture();await f.journal().reserve(f.identity);
 await assert.rejects(f.journal().reserve({...f.identity,mime_digest:'c'.repeat(64)}));
 await f.journal().reserveTransport(f.full);await f.journal().recordOutcome({identity:f.full,state:'unknown'});
 assert.equal(await f.journal().reserveTransport(f.full),false);
 assert.equal(await f.journal().recordOutcome({identity:f.full,state:'accepted',output:{operation_id:f.full.operation_id,transport_outcome:'provider_accepted',sent_copy_outcome:'pending'}}),false);
 await assert.rejects(createEmailSendJournal({...f.options,encryption_key:new Uint8Array(32).fill(8)}).readOutcome(f.full));
 const [key,row]=[...f.rows][0];row.value.envelope.ciphertext='AAAA';f.rows.set(key,row);
 await assert.rejects(f.journal().reserve(f.identity));
});
test('POSIX ciphertext journal persists across actual file-store reopen', {skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'deft-email-send-journal-'));
 try{
  const f=fixture(),first=await createEmailFileCustodyStore({root});
  const journal=store=>createEmailSendJournal({...f.options,store});
  assert.equal(await journal(first).reserve(f.identity),'reserved');
  const reopened=await createEmailFileCustodyStore({root});
  assert.equal(await journal(reopened).reserve(f.identity),'replay');
  assert.equal(await journal(reopened).reserveTransport(f.full),true);
  assert.equal(await journal(first).reserveTransport(f.full),false);
  assert.equal(await journal(first).recordOutcome({identity:f.full,state:'unknown'}),true);
  assert.equal((await journal(reopened).readOutcome(f.full)).state,'unknown');
  const accepted=fixture(),output={operation_id:accepted.full.operation_id,transport_outcome:'provider_accepted',sent_copy_outcome:'pending'};
  const provider_receipt={provider:'gmail',provider_message_id:'synthetic-reopened-private-locator'};
  await journal(first).reserve(accepted.identity);await journal(first).reserveTransport(accepted.full);
  assert.equal(await journal(first).recordOutcome({identity:accepted.full,state:'accepted',output,provider_receipt}),true);
  assert.deepEqual((await journal(await createEmailFileCustodyStore({root})).readOutcome(accepted.full)).provider_receipt,provider_receipt);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('optional provider receipt is encrypted, immutable and backward compatible with legacy accepted rows',async()=>{
 const f=fixture();await f.journal().reserve(f.identity);await f.journal().reserveTransport(f.full);
 const output={operation_id:f.full.operation_id,transport_outcome:'provider_accepted',sent_copy_outcome:'pending'};
 const provider_receipt={provider:'gmail',provider_message_id:'private-provider-message-id'};
 assert.equal(await f.journal().recordOutcome({identity:f.full,state:'accepted',output,provider_receipt}),true);
 assert.deepEqual((await f.journal().readOutcome(f.full)).provider_receipt,provider_receipt);
 assert.equal(JSON.stringify([...f.rows.values()]).includes('private-provider-message-id'),false);
 assert.equal(await f.journal().recordOutcome({identity:f.full,state:'accepted',output,provider_receipt}),true);
 assert.equal(await f.journal().recordOutcome({identity:f.full,state:'accepted',output,provider_receipt:{...provider_receipt,provider_message_id:'different-id'}}),false);
 assert.equal(await f.journal().recordOutcome({identity:f.full,state:'accepted',output}),false);
 assert.equal(await f.journal().reserveTransport(f.full),false);
});
test('malformed or oversized private receipt cannot be recorded as accepted',async()=>{
 for(const provider_receipt of [{provider:'gmail',provider_message_id:'x'.repeat(2049)},{provider:'gmail',provider_message_id:'bad\nlocator'},{provider:'unknown',provider_message_id:'id'},{provider:'gmail',provider_message_id:'id',extra:true}]){
  const f=fixture();await f.journal().reserve(f.identity);await f.journal().reserveTransport(f.full);
  const output={operation_id:f.full.operation_id,transport_outcome:'provider_accepted',sent_copy_outcome:'pending'};
  assert.equal(await f.journal().recordOutcome({identity:f.full,state:'accepted',output,provider_receipt}),false);
  assert.equal((await f.journal().readOutcome(f.full)).state,'provider_started');
  assert.equal(await f.journal().reserveTransport(f.full),false);
 }
});

test('Microsoft accepted response without a provider locator retains explicit null privately',async()=>{
 const f=fixture();await f.journal().reserve(f.identity);await f.journal().reserveTransport(f.full);
 const output={operation_id:f.full.operation_id,transport_outcome:'provider_accepted',sent_copy_outcome:'pending'};
 const provider_receipt={provider:'microsoft',provider_message_id:null};
 assert.equal(await f.journal().recordOutcome({identity:f.full,state:'accepted',output,provider_receipt}),true);
 assert.deepEqual((await f.journal().readOutcome(f.full)).provider_receipt,provider_receipt);
});
