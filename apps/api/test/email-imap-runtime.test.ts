import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createPinnedEmailImapHost} from '../src/lib/email-imap-runtime.js';
import {EmailImapCredentialCustody,type EmailImapCredentialRecord} from '../src/lib/email-imap-custody.js';
import type {AppConnectionPins} from '../src/lib/app-connection-contract.js';
import type {NativeEmailConnectionContext} from '../src/lib/email-native-adapter-contract.js';
const keys={current:()=>({key_id:'fixture',key:Buffer.alloc(32,9)}),read:()=>({key_id:'fixture',key:Buffer.alloc(32,9)}),keyIds:()=>['fixture']};
async function fixture(verified=true){
 const pins:AppConnectionPins={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),target_key:'mail',resource_key:'inbox',resource_binding_id:randomUUID(),action_key:'send_message',action_binding_id:randomUUID()};
 const scope={org_id:pins.org_id,owner_user_id:pins.owner_user_id,account_id:'account'};let record:EmailImapCredentialRecord|null=null,reads=0,revoked=false,state='paused';
 const custody=new EmailImapCredentialCustody(keys,{read:async()=>record,compareAndSwap:async input=>{record=input.record;return true;}});
 const saved=await custody.saveProfile(scope,0,{host:'imap.example.test',port:993,transport:'implicit_tls',username:'login-name',password:'synthetic-imap',
  smtp:{host:'smtp.example.test',port:587,transport:'starttls_required',username:'smtp-login',password:'synthetic-smtp'},
  identity:{primary_address:'configured@example.test',display_label:'Configured work account'},...(verified?{verified_at:new Date().toISOString()}:{})},async()=>{});
 const context:NativeEmailConnectionContext={...scope,installation_id:pins.installation_id,resource_binding_id:pins.resource_binding_id,authority_version:'fixture',expires_at:Date.now()+60000,recheck:async()=>{if(revoked)throw Error('revoked');}};
 const host=createPinnedEmailImapHost(pins,{ImapFlow:class{async connect(){}async logout(){}close(){}},createTransport:()=>({async sendMail(){throw Error('No fixture send');},close(){}})},
  {keys:async()=>keys,read:async()=>{reads++;return {provider:'imap_smtp',state,authority_revision:2,principal_digest:saved.principal_digest,credential:record!};}});
 return {host,context,pins,record:()=>record,reads:()=>reads,revoke:()=>{revoked=true;},state:(value:string)=>{state=value;}};
}
test('registry host exposes only explicitly configured and tested identity from encrypted profile; paused adoption needs no extra account lock',async()=>{
 const f=await fixture();const account=await f.host.current(f.context,'send');
 assert.equal(account.primary_address,'configured@example.test');assert.equal(account.connection_target,'mail');assert.equal(account.action_binding_id,f.pins.action_binding_id);
 assert.deepEqual(account.capabilities,['read','modify','send']);assert.deepEqual(account.verified_sender_identities,['configured@example.test']);
 assert.equal(JSON.stringify(account).includes('synthetic-'),false);assert.equal(JSON.stringify(account).includes('login-name'),false);
 assert.equal(JSON.stringify(f.record()).includes('configured@example.test'),false);
 assert.equal(await f.host.sentCopyMode(f.context,account),'server_managed');await assert.rejects(f.host.sentCopyMode(f.context,{...account,connection_revision:account.connection_revision+1}),/EMAIL_ACCESS_DENIED/);
});
test('wrong registry context, revoked authority and unverified setup never expose native identity',async()=>{
 const f=await fixture();await assert.rejects(f.host.current({...f.context,owner_user_id:randomUUID()}),/EMAIL_ACCESS_DENIED/);assert.equal(f.reads(),0);
 f.revoke();await assert.rejects(f.host.current(f.context),/EMAIL_ACCESS_DENIED/);assert.equal(f.reads(),0);
 const unverified=await fixture(false);await assert.rejects(unverified.host.current(unverified.context),/EMAIL_ACCESS_DENIED/);
});

test('standalone IMAP consent narrows effects while lifecycle metadata remains socket-free and cannot authorize clients',async()=>{
 const f=await fixture(),read={...f.context,owner_capabilities:['read'] as const};
 assert.deepEqual((await f.host.current(read)).capabilities,['read']);await assert.rejects(f.host.current(read,'modify'),/EMAIL_ACCESS_DENIED/);await assert.rejects(f.host.current(read,'send'),/EMAIL_ACCESS_DENIED/);
 f.state('disconnected');await assert.rejects(f.host.current(f.context),/EMAIL_ACCESS_DENIED/);
 const inspect={...f.context,lifecycle_inspect:true as const},account=await f.host.current(inspect);assert.equal(account.primary_address,'configured@example.test');assert.deepEqual(account.capabilities,['read','modify','send']);
 await assert.rejects(f.host.withAuthorizedClient(inspect,account,async()=>assert.fail('inspection cannot connect')),/EMAIL_ACCESS_DENIED/);await assert.rejects(f.host.withAuthorizedSmtp(inspect,account,async()=>assert.fail('inspection cannot send')),/EMAIL_ACCESS_DENIED/);
});
