import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectedEmailMailboxAuthority } from '../src/lib/email-mailbox-connected-authority.js';
import type { EmailAuthority, EmailCapability } from '../src/lib/email-mailbox-service.js';
import type {NativeEmailAccount} from '../src/lib/email-native-adapter-contract.js';
const scope={org_id:'org',owner_user_id:'owner',account_id:'account'};
const actor={user_id:'owner',web_session_id:'sid',access_expires_at:10000};
function fixture() {
  let version='base',generation=1,health='connected',calls=0,implementation_digest:string|undefined;
  const transactions:unknown[]=[];
  const base:EmailAuthority={current:async (_actor,_scope,_operation,tx)=>{calls++;transactions.push(tx);return {scope,resource_binding_id:'binding',authority_version:version,expires_at:10000};}};
  const account=():NativeEmailAccount=>({account_id:'account',resource_binding_id:'binding',provider:'gmail',authority_epoch:1,
    connection_revision:generation,principal_digest:'a'.repeat(64),health,capabilities:['read','send'],primary_address:'fixture@example.test',display_label:'Fixture',...(implementation_digest?{implementation_digest}:{})});
  let during=()=>{};
  const connection={assertConnected:async (_scope:typeof scope,_cap:EmailCapability,recheck:()=>Promise<void>)=>{
    await recheck();during();await recheck();return account();}};
  const authority=new ConnectedEmailMailboxAuthority(base,connection,()=>1000);
  return {authority,transactions,calls:()=>calls,change:()=>{version='changed';},implementation:()=>{implementation_digest='e'.repeat(64);},reconnect:()=>{generation++;},disconnect:()=>{health='revoked';},during:(fn:()=>void)=>{during=fn;}};
}
test('custody checks use SQL-only callback and preserve caller transaction',async()=>{
  const f=fixture(),tx={transaction:'fixture'};
  const value=await f.authority.current(actor,scope,'human_read',tx);
  assert.match(value.authority_version,/^[a-f0-9]{64}$/);
  assert.equal(f.calls(),4);assert.ok(f.transactions.every(value=>value===tx));
});
test('same-account reconnect advances the authority fingerprint',async()=>{
  const f=fixture(),first=await f.authority.current(actor,scope,'human_read');
  f.reconnect();const second=await f.authority.current(actor,scope,'human_read');
  assert.notEqual(first.authority_version,second.authority_version);
});
test('reviewed implementation update changes held capability without changing credential generation',async()=>{
 const f=fixture(),first=await f.authority.current(actor,scope,'human_read');f.implementation();const second=await f.authority.current(actor,scope,'human_read');assert.notEqual(first.authority_version,second.authority_version);
});
test('OAuth disconnect denies native cached authority even when SQL binding remains active',async()=>{
  const f=fixture();f.disconnect();await assert.rejects(f.authority.current(actor,scope,'human_read'),/EMAIL_ACCESS_DENIED/);
});
test('SQL grant change during credential lookup denies the old capability',async()=>{
  const f=fixture();f.during(f.change);await assert.rejects(f.authority.current(actor,scope,'human_read'),/EMAIL_ACCESS_DENIED/);
});
