import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {LogicalMailIndex} from '../logical-mail-index.mjs';

// Pass the frozen prior logical-mail-index.mjs; this checks the actual legacy
// implementation rather than a test double of its schema-version gate.
const {LogicalMailIndex:LegacyIndex}=await import(pathToFileURL(resolve(process.argv[2])).href);
const scope={org_id:'compat-org',owner_id:'compat-owner',installation_id:'compat-installation'};
const message={account_id:'compat-account',provider:'gmail',locator:{kind:'gmail',message_id:'stable-provider-id',thread_id:'stable-thread',label_ids:['INBOX']},subject:'Compatibility',body_status:'lazy',files_status:'unknown'};
const old=new LegacyIndex(scope),original=old.upsert(scope,message),v1=old.exportState(scope);assert.equal(v1.schema_version,'deft.email_logical_index.v1');
const current=new LogicalMailIndex(scope,{state:v1});assert.equal(current.get(scope,message.account_id,original.logical_message_id).logical_message_id,original.logical_message_id);
const tombstone=current.recordProviderDeletion(scope,{account_id:message.account_id,provider:'gmail',provider_message_id:message.locator.message_id,provider_conversation_id:message.locator.thread_id,evidence:{kind:'provider_mailbox_deleted',authority_epoch:1,event_id:'101',observed_at:new Date().toISOString()}});
const v2=current.exportState(scope);assert.equal(v2.schema_version,'deft.email_logical_index.v2');assert.throws(()=>new LegacyIndex(scope,{state:v2}),/EMAIL_LOGICAL_STATE_INVALID/);
const reopened=new LogicalMailIndex(scope,{state:v2});assert.equal(reopened.get(scope,message.account_id,tombstone.id).deletion.kind,'provider_mailbox_deleted');assert.equal(reopened.upsert(scope,message).deletion.kind,'provider_mailbox_deleted');assert.equal(reopened.resolveLocator(scope,message.account_id,message.locator).logical_message_id,original.logical_message_id);
console.log(JSON.stringify({legacy_v1_read:true,identity_preserved:true,v2_roundtrip:true,actual_legacy_rejects_v2:true,deletion_stable_link:true,stale_replay_cannot_resurrect:true}));
