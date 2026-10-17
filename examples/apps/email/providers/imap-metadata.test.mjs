import test from 'node:test';
import assert from 'node:assert/strict';
import {readImapMetadataPage} from './imap-metadata.mjs';
import {createImapAdapter} from './imap.mjs';

const scope={org_id:'metadata-org',owner_id:'metadata-owner',installation_id:'metadata-installation'},account={account_id:'imap',provider:'imap_smtp',display_label:'Synthetic IMAP',primary_address:'imap@example.test',verified_sender_identities:['imap@example.test'],capabilities:['read'],connection_target:'reviewed-imap',resource_binding_id:'resource-imap',action_binding_id:null,authority_epoch:1,health:'connected'};
function fixture({validity='3001',uids=[1,3,5,70],duplicate=false}={}){
 const calls=[],client={mailbox:null,async list(){calls.push({kind:'list'});return [{path:'INBOX'},{path:'Sent',specialUse:'\\Sent'},{path:'Archive',specialUse:'\\Archive'}];},async getMailboxLock(path){calls.push({kind:'lock',path});client.mailbox={uidValidity:validity,uidNext:path==='INBOX'?71:1};return {release(){calls.push({kind:'release',path});}};},async *fetch(range,options,selector){calls.push({kind:'fetch',range,options,selector});const [from,to]=range.split(':').map(Number);for(const uid of uids.filter(uid=>uid>=from&&uid<=to)){yield {uid,envelope:{subject:`Metadata ${uid}`,from:[{address:'sender@example.test'}],to:[{address:'imap@example.test'}],messageId:`<metadata-${uid}@example.test>`},flags:new Set(['\\Seen']),internalDate:new Date('2026-09-30T12:00:00Z'),size:10000000};if(duplicate)yield {uid};}},async fetchOne(){assert.fail('metadata path must not request source');},async logout(){calls.push({kind:'logout'});}};return {client,calls};
}
test('bounded UID windows resume gaps and partial page without source, bodies or file metadata',async()=>{
 const {client,calls}=fixture(),first=await readImapMetadataPage(client,{account_id:'imap',limit:2}),second=await readImapMetadataPage(client,{account_id:'imap',limit:2,cursor:first.next_state}),third=await readImapMetadataPage(client,{account_id:'imap',limit:2,cursor:second.next_state}),sent=await readImapMetadataPage(client,{account_id:'imap',limit:2,cursor:third.next_state}),archive=await readImapMetadataPage(client,{account_id:'imap',limit:2,cursor:sent.next_state});
 assert.deepEqual(first.messages.map(row=>row.locator.uid),[1,3]);assert.deepEqual(second.messages.map(row=>row.locator.uid),[5]);assert.deepEqual(third.messages.map(row=>row.locator.uid),[70]);assert.equal(archive.has_more,false);assert.equal(archive.next_state.round,1);
 const fetches=calls.filter(call=>call.kind==='fetch');assert.deepEqual(fetches.map(call=>call.range),['1:64','4:67','68:70']);assert.ok(fetches.every(call=>Object.keys(call.options).sort().join(',')==='envelope,flags,internalDate,size,uid'));assert.ok(first.messages.every(row=>row.body_status==='lazy'&&row.files_status==='unknown'));
 assert.equal(calls.filter(call=>call.kind==='lock').length,calls.filter(call=>call.kind==='release').length);assert.deepEqual(first.folder_map,{inbox:['INBOX'],sent:['Sent'],archive:['Archive']});
});
test('UIDVALIDITY change restarts safely; malformed duplicate UIDs release locks and fail closed',async()=>{
 const one=fixture(),page=await readImapMetadataPage(one.client,{account_id:'imap',limit:2}),changed=fixture({validity:'3002'}),restart=await readImapMetadataPage(changed.client,{account_id:'imap',limit:2,cursor:page.next_state});assert.equal(restart.messages[0].locator.uid,1);assert.equal(restart.messages[0].locator.uidvalidity,'3002');
 const bad=fixture({duplicate:true});await assert.rejects(readImapMetadataPage(bad.client,{account_id:'imap',limit:2}),/EMAIL_PROVIDER_RESPONSE_INVALID/);assert.equal(bad.calls.at(-1).kind,'release');
 const changedFolders=fixture();changedFolders.client.list=async()=>[{path:'INBOX'},{path:'OtherSent',specialUse:'\\Sent'},{path:'Archive',specialUse:'\\Archive'}];await assert.rejects(readImapMetadataPage(changedFolders.client,{account_id:'imap',cursor:page.next_state}),/EMAIL_PROVIDER_CURSOR_INVALID/);
});
test('account adapter binds metadata cursor, rechecks current consent and closes verified connector',async()=>{
 let allowed=true;const one=fixture(),adapter=createImapAdapter({account,scope,assertAuthority:async()=>allowed,connect:async()=>one.client}),page=await adapter.listMetadataMessages({limit:2});assert.equal(page.messages[0].account_id,'imap');assert.ok(page.checkpoint_cursor);assert.equal(one.calls.at(-1).kind,'logout');
 const other=fixture(),foreign=createImapAdapter({account:{...account,account_id:'another-imap'},scope,assertAuthority:async()=>true,connect:async()=>other.client});await assert.rejects(foreign.listMetadataMessages({limit:2,cursor:page.next_cursor}),/EMAIL_PROVIDER_CURSOR_INVALID/);assert.equal(other.calls.length,0);
 allowed=false;await assert.rejects(adapter.listMetadataMessages({limit:2}),/EMAIL_ACCOUNT_REVOKED/);
});
test('metadata deadline closes a stalled client and never returns partial rows',async()=>{
 let closed=false;const client={list:()=>new Promise(()=>{}),close(){closed=true;}};await assert.rejects(readImapMetadataPage(client,{account_id:'imap',timeout_ms:5}),/EMAIL_PROVIDER_SCAN_DEADLINE/);assert.equal(closed,true);
 const stalled=fixture(),page=readImapMetadataPage(stalled.client,{account_id:'imap',timeout_ms:5,onProgress:()=>new Promise(()=>{})});await assert.rejects(page,/EMAIL_PROVIDER_SCAN_DEADLINE/);assert.equal(stalled.calls.at(-1).kind,'release');
});

test('elapsed metadata deadline before the first check closes the client exactly once',async t=>{
 let clockReads=0,closed=0,listed=0;t.mock.method(Date,'now',()=>clockReads++===0?1000:1006);
 const client={list(){listed++;return new Promise(()=>{});},close(){closed++;}};
 await assert.rejects(readImapMetadataPage(client,{account_id:'imap',timeout_ms:5}),/EMAIL_PROVIDER_SCAN_DEADLINE/);
 assert.equal(listed,0);assert.equal(closed,1);
});
