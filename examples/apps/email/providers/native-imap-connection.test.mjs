import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppConnectionAdapter} from './native-imap-connection.mjs';
const account={org_id:'org',owner_user_id:'owner',installation_id:'installation',account_id:'account',provider:'imap_smtp',resource_binding_id:'binding',authority_epoch:1,connection_revision:2,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','modify','send'],primary_address:'explicit-sender@example.test',display_label:'Configured IMAP account',connection_target:'target',action_binding_id:'action',verified_sender_identities:['explicit-sender@example.test']};
const context={org_id:'org',owner_user_id:'owner',installation_id:'installation',account_id:'account',resource_binding_id:'binding',authority_version:'v1',expires_at:Date.now()+60000,recheck:async()=>{}};
test('registered native IMAP bundle supplies real transport constructors to pin-bound host factory and exposes native ports',async()=>{
 let boot=0,work=0;const adapter=await createAppConnectionAdapter({host:{async nativeEmailImapHost(constructors){boot++;assert.deepEqual(Object.keys(constructors).sort(),['ImapFlow','createTransport']);assert.equal(typeof constructors.ImapFlow,'function');assert.equal(typeof constructors.createTransport,'function');assert.equal(Object.isFrozen(constructors),true);
  // Nodemailer stream transport exercises the shipped constructor without DNS,
  // credentials or SMTP effects. Production host selects its own strict TLS options.
  const stream=constructors.createTransport({streamTransport:true,buffer:true});assert.equal(typeof stream.verify,'function');const result=await stream.sendMail({raw:Buffer.from('From: a@example.test\r\nTo: b@example.test\r\n\r\nSynthetic'),envelope:{from:'a@example.test',to:['b@example.test']}});assert.ok(Buffer.isBuffer(result.message));stream.close();
  return {async current(_context,purpose='read'){assert.ok(['read','modify','send'].includes(purpose));return structuredClone(account);},async withAuthorizedClient(){work++;assert.fail('Status never opens IMAP');},async withAuthorizedSmtp(){work++;assert.fail('Identity never opens SMTP');}};}}});
 assert.equal(boot,1);for(const method of ['nativeEmailAccount','nativeEmailPage','nativeEmailTriage','nativeEmailSendIdentity','nativeEmailSend','nativeEmailSnapshotFactory','handle'])assert.equal(typeof adapter[method],'function');
 const status=await adapter.nativeEmailAccount(context);assert.equal(status.provider,'imap_smtp');assert.equal(Object.hasOwn(status,'verified_sender_identities'),false);
 const identity=await adapter.nativeEmailSendIdentity(context);assert.equal(identity.primary_address,'explicit-sender@example.test');assert.deepEqual(identity.verified_sender_identities,['explicit-sender@example.test']);assert.equal(work,0);
 const response=await adapter.handle(new Request('https://deft-connection.invalid/connections/begin'),{projection:{}});assert.equal(response.status,409);assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');assert.equal(response.headers.get('cache-control'),'no-store');
});
test('IMAP registered options cannot supply plaintext profiles, sender, provider or account and missing trusted host denies',async()=>{
 for(const options of [{password:'synthetic'},{host:'imap.example.test'},{account_id:'arbitrary'},{provider:'imap_smtp'},{primary_address:'caller@example.test'}])await assert.rejects(createAppConnectionAdapter({options,host:{nativeEmailImapHost:async()=>assert.fail('Bad options never bootstrap')}}));
 await assert.rejects(createAppConnectionAdapter({options:{},host:{}}));await assert.rejects(createAppConnectionAdapter({host:{nativeEmailImapHost:async()=>({current:async()=>account})}}));
});
