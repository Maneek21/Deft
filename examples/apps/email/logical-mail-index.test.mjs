import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LogicalMailIndex,logicalMailIdForProviderMessage} from './logical-mail-index.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/launch-stage0/fixtures.json',import.meta.url))),scope={...fixture.scope,installation_id:'stage1-installation'};
function summary(row){const provider=fixture.accounts.find(account=>account.id===row.account_id).provider_hint;let locator;if(provider==='gmail')locator={kind:'gmail',...row.locator};else if(provider==='microsoft')locator={kind:'microsoft',...row.locator,id_type:'immutable'};else{const [,uidvalidity,uid]=row.locator.resource_id.split(':');locator={kind:'imap_smtp',mailbox:row.locator.mailbox,uidvalidity,uid:Number(uid)};}return {account_id:row.account_id,provider:locator.kind,locator,subject:'Review the launch brief',message_id:row.message_id,date:`2026-09-30T09:0${fixture.messages.indexOf(row)}:00.000Z`,folders:[row.folder],body_status:'lazy'};}

test('fixture inbox, Sent and followup assemble one stable Gmail conversation across pages',()=>{
 const index=new LogicalMailIndex(scope),rows=fixture.messages.slice(0,3).map(row=>index.upsert(scope,summary(row))),conversation_id=rows[0].conversation_id;
 assert.ok(rows.every(row=>row.conversation_id===conversation_id));const first=index.conversationPage(scope,{account_id:'gmail-personal',conversation_id,limit:2}),second=index.conversationPage(scope,{account_id:'gmail-personal',conversation_id,limit:2,cursor:first.next_cursor});assert.equal(first.messages.length,2);assert.equal(second.messages.length,1);assert.equal(second.complete,false);
 index.markCoverage(scope,{account_id:'gmail-personal',conversation_id,complete:true,covers_folders:['INBOX','SENT'],observed_at:'2026-09-30T10:00:00Z'});assert.equal(index.conversationPage(scope,{account_id:'gmail-personal',conversation_id}).count.exact_total,3);
 assert.throws(()=>index.conversationPage(scope,{account_id:'gmail-personal',conversation_id,limit:2,cursor:first.next_cursor}),/EMAIL_LOGICAL_CURSOR_EXPIRED/);
});
test('equal subjects and Message-IDs, including equal native IDs in another account, never collapse',()=>{
 const index=new LogicalMailIndex(scope),personal=summary(fixture.messages[0]),first=index.upsert(scope,personal),work=index.upsert(scope,{...personal,account_id:'gmail-work'}),other=index.upsert(scope,{...personal,locator:{...personal.locator,message_id:'another-provider-message',thread_id:'another-provider-thread'}});
 assert.notEqual(first.logical_message_id,work.logical_message_id);assert.notEqual(first.conversation_id,work.conversation_id);assert.notEqual(first.logical_message_id,other.logical_message_id);assert.notEqual(first.conversation_id,other.conversation_id);
 assert.throws(()=>index.get(scope,'gmail-work',first.logical_message_id),/EMAIL_LOGICAL_NOT_FOUND/);assert.throws(()=>index.get({...scope,org_id:'another-org'},'gmail-personal',first.logical_message_id),/EMAIL_LOGICAL_SCOPE_DENIED/);
});
test('authoritative IMAP move keeps logical links and old aliases through restart, replay and expired-cursor rebuild',()=>{
 const index=new LogicalMailIndex(scope),row=summary(fixture.messages.find(row=>row.id==='imap-stable-001')),first=index.upsert(scope,row),change=fixture.locator_changes[0],after=change.after.resource_id.split(':'),destination={kind:'imap_smtp',mailbox:change.after.mailbox,uidvalidity:after[1],uid:Number(after[2])};
 assert.throws(()=>index.recordMove(scope,{account_id:row.account_id,logical_message_id:first.logical_message_id,from_locator:row.locator,to_locator:destination}),/EMAIL_LOGICAL_MOVE_EVIDENCE_REQUIRED/);
 const moved=index.recordMove(scope,{account_id:row.account_id,logical_message_id:first.logical_message_id,from_locator:row.locator,to_locator:destination,evidence:{kind:'provider_move',operation_id:'trusted-imap-move'}});assert.equal(moved.logical_message_id,first.logical_message_id);assert.equal(moved.conversation_id,first.conversation_id);
 const restored=new LogicalMailIndex(scope,{state:index.exportState(scope)});assert.equal(restored.resolveLocator(scope,row.account_id,row.locator).locator.mailbox,'Archive');assert.equal(restored.upsert(scope,row).locator.mailbox,'Archive');restored.restartScan(scope,row.account_id);assert.equal(restored.upsert(scope,{...row,locator:destination}).logical_message_id,first.logical_message_id);assert.equal(restored.exportState(scope).records.length,1);
});
test('Graph immutable IDs retain identity across folders; ambiguous IMAP reappearance stays distinct',()=>{
 const index=new LogicalMailIndex(scope),graph=summary(fixture.messages.find(row=>row.account_id==='microsoft')),first=index.upsert(scope,graph),moved=index.upsert(scope,{...graph,locator:{...graph.locator,folder_id:'archive'}});assert.equal(first.logical_message_id,moved.logical_message_id);
 const imap=summary(fixture.messages.find(row=>row.account_id==='imap')),original=index.upsert(scope,imap),duplicate=index.upsert(scope,{...imap,locator:{...imap.locator,mailbox:'Archive',uid:27}});assert.notEqual(original.logical_message_id,duplicate.logical_message_id);
 const state=index.exportState(scope);assert.throws(()=>new LogicalMailIndex(scope,{state:{...state,scope:{...scope,owner_id:'different'}}}),/EMAIL_LOGICAL_STATE_INVALID/);
});
test('logical index rejects secret/body fields and malformed metadata instead of persisting them',()=>{
 const index=new LogicalMailIndex(scope),message=summary(fixture.messages[0]);for(const addition of [{access_token:'secret'},{body:'large private body'},{date:42},{flags:{seen:'yes'}}])assert.throws(()=>index.upsert(scope,{...message,...addition}),/EMAIL_LOGICAL_MESSAGE_INVALID/);
 index.upsert(scope,message);const state=index.exportState(scope);state.records[0].summary.account_id='gmail-work';assert.throws(()=>new LogicalMailIndex(scope,{state}),/EMAIL_LOGICAL_STATE_INVALID/);
});
test('stable logical identity survives equivalent scope property ordering during rebuild',()=>{
 const first=new LogicalMailIndex(scope).upsert(scope,summary(fixture.messages[0])),reordered={installation_id:scope.installation_id,owner_id:scope.owner_id,org_id:scope.org_id},second=new LogicalMailIndex(reordered).upsert(reordered,summary(fixture.messages[0]));assert.equal(first.logical_message_id,second.logical_message_id);assert.equal(first.conversation_id,second.conversation_id);
});

test('authenticated provider absence derives existing Gmail and Graph IDs without fabricated metadata',()=>{
 for(const provider of ['gmail','microsoft']){
  const row=summary(fixture.messages.find(row=>fixture.accounts.find(account=>account.id===row.account_id).provider_hint===provider));
  const expected=new LogicalMailIndex(scope).upsert(scope,row).logical_message_id,reordered={installation_id:scope.installation_id,owner_id:scope.owner_id,org_id:scope.org_id};
  assert.equal(logicalMailIdForProviderMessage(reordered,row.account_id,provider,row.locator.message_id),expected);
  assert.notEqual(logicalMailIdForProviderMessage(scope,'another-account',provider,row.locator.message_id),expected);
 }
 assert.throws(()=>logicalMailIdForProviderMessage(scope,'account','imap_smtp','uid'),/EMAIL_LOGICAL_LOCATOR_INVALID/);
});

test('v2 conversation attestation round-trips with legacy compatibility and paired authority fencing',()=>{
 const index=new LogicalMailIndex(scope),row=index.upsert(scope,summary(fixture.messages[0])),base={account_id:row.account_id,conversation_id:row.conversation_id,complete:true,covers_folders:['INBOX','SENT'],observed_at:'2026-09-30T00:00:00.000Z'};
 index.markCoverage(scope,{...base,authority_epoch:7,resource_binding_id:'resource'});const restored=new LogicalMailIndex(scope,{state:index.exportState(scope)});assert.equal(restored.conversationPage(scope,{account_id:row.account_id,conversation_id:row.conversation_id}).coverage.authority_epoch,7);
 index.markCoverage(scope,base);assert.equal(new LogicalMailIndex(scope,{state:index.exportState(scope)}).conversationPage(scope,{account_id:row.account_id,conversation_id:row.conversation_id}).coverage.authority_epoch,undefined);
 assert.throws(()=>index.markCoverage(scope,{...base,authority_epoch:7}));assert.throws(()=>index.markCoverage(scope,{...base,resource_binding_id:'resource'}));
});
