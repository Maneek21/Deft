import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {LogicalMailIndex} from '../logical-mail-index.mjs';
import {providerSourceForParent} from './provider-browser.mjs';
import {resolveNativeImapSource} from './native-imap-alias.mjs';
const scope={org_id:'org',owner_id:'owner',installation_id:'original-installation'},account={account_id:'account',provider:'imap_smtp',authority_epoch:1},base={kind:'imap_smtp',mailbox:'INBOX',uidvalidity:'10',uid:1},current={kind:'imap_smtp',mailbox:'Localized Sent',uidvalidity:'20',uid:8};
const source=providerSourceForParent(account,new LogicalMailIndex(scope).upsert(scope,{account_id:account.account_id,provider:account.provider,locator:base}));
const proof={schema_version:'deft.email_imap_alias.v1',provider_scope:scope,account_id:account.account_id,logical_message_id:source.logical_message_id,conversation_id:source.conversation_id,base_locator:base,current_locator:current,operation_id:randomUUID()};
test('only durable host MOVE proof preserves logical identity across a new UID and binding installation',async()=>{
 const moved={...source,locator:current},parent=await resolveNativeImapSource({scope:{...scope,installation_id:'current-reviewed-installation'},account,source:moved,aliases:{lookup:async()=>proof},check:async()=>{}});
 assert.equal(parent.logical_message_id,source.logical_message_id);assert.equal(parent.conversation_id,source.conversation_id);assert.deepEqual(parent.locator,current);
 await assert.rejects(resolveNativeImapSource({scope,account,source:moved,aliases:{lookup:async()=>null},check:async()=>{}}));
});
test('wrong account/base/scope/locator and a held old source deny; late revocation returns no parent',async()=>{
 for(const bad of [{...proof,account_id:'foreign'},{...proof,provider_scope:{...scope,owner_id:'other'}},{...proof,logical_message_id:'mail_'+'b'.repeat(64)},{...proof,base_locator:{...base,uid:2}},{...proof,current_locator:{...current,uidvalidity:'21'}},{...proof,operation_id:'not-a-journal-uuid'}])await assert.rejects(resolveNativeImapSource({scope,account,source:{...source,locator:current},aliases:{lookup:async()=>bad},check:async()=>{}}));
 await assert.rejects(resolveNativeImapSource({scope,account,source,aliases:{lookup:async()=>proof},check:async()=>{}}));
 let checks=0;await assert.rejects(resolveNativeImapSource({scope,account,source:{...source,locator:current},aliases:{lookup:async()=>proof},check:async()=>{if(++checks===2)throw Error('REVOKED');}}),/REVOKED/);
});
