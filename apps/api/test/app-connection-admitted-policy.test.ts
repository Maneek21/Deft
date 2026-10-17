import test from 'node:test';import assert from 'node:assert/strict';
import {selectAdmittedConnectionPolicy} from '../src/lib/app-connection-admitted-policy';
const gmail={key:'personal_mailbox',resource_key:'inbox',action_keys:['organize_messages','send_message'],provider_profile_key:'gmail_readwrite',runtime_requirement_key:'sync_provider',max_consent_seconds:7776000},graph={...gmail,key:'microsoft_mailbox',provider_profile_key:'microsoft_readwrite'},imap={...gmail,key:'imap_mailbox',action_keys:['send_message'],provider_profile_key:'imap_smtp'},current={resource_key:'inbox',runtime_requirement_key:'sync_provider'};
test('one existing Gmail admission retains its exact policy and broader resource catalog selects only admitted profile',()=>{
 assert.equal(selectAdmittedConnectionPolicy([gmail],gmail,current),gmail);assert.equal(selectAdmittedConnectionPolicy([imap,graph,gmail],gmail,current),gmail);assert.equal(selectAdmittedConnectionPolicy([imap,graph,gmail],graph,current),graph);assert.equal(selectAdmittedConnectionPolicy([imap,graph,gmail],imap,current),imap);
});
test('ambiguous policy key, absent admission, changed ceiling or profile cannot nominate another policy',()=>{
 for(const rows of [[gmail,gmail],[graph,imap],[{...gmail,provider_profile_key:'microsoft_readwrite'}],[{...gmail,action_keys:['send_message']}],[{...gmail,max_consent_seconds:60}]])assert.equal(selectAdmittedConnectionPolicy(rows,gmail,current),null);
});
test('a reviewed admission cannot escape its exact resource/runtime or omit the external profile',()=>{
 assert.equal(selectAdmittedConnectionPolicy([gmail],gmail,{...current,resource_key:'foreign'}),null);assert.equal(selectAdmittedConnectionPolicy([gmail],gmail,{...current,runtime_requirement_key:'foreign'}),null);const legacy={...gmail,provider_profile_key:undefined,runtime_requirement_key:undefined};assert.equal(selectAdmittedConnectionPolicy([legacy],legacy,current),null);
});
