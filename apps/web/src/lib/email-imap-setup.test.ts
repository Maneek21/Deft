import test from 'node:test';
import assert from 'node:assert/strict';
import {parseImapSetupTargets,submitImapSetup,loadImapSetupTargets,type ImapProfile} from './email-imap-setup';
const target={account_id:'imap_scoped',resource_binding_id:'11111111-1111-4111-8111-111111111111',credential_revision:0,display_label:'',primary_address:'',state:'available' as const};
const profile=():ImapProfile=>({host:'imap.example.com',port:993,transport:'implicit_tls',username:'user',password:'secret',identity:{primary_address:'user@example.com',display_label:'Personal'}});
test('setup targets are closed scope nominations; no credentials/private projection accepted',()=>{
 assert.deepEqual(parseImapSetupTargets({items:[target],has_more:false}),{items:[target],has_more:false});for(const value of [{items:[{...target,password:'secret'}],has_more:false},{items:[target,target],has_more:false},{items:[{...target,credential_revision:-1}],has_more:false}])assert.throws(()=>parseImapSetupTargets(value));
});
test('one secure setup POST uses reviewed binding/revision and clears credentials, with no browser authority fields',async()=>{
 const value=profile();value.smtp={host:'smtp.example.com',port:587,transport:'starttls_required',username:'user',password:'smtp-secret'};let calls=0;
 await submitImapSetup(target,value,{current:()=>true,fetch:async(path,options)=>{calls++;assert.equal(path,'/api/email/accounts/imap_scoped/imap-setup');assert.equal(options.method,'POST');assert.equal(options.cache,'no-store');const body=JSON.parse(options.body as string);assert.deepEqual(Object.keys(body).sort(),['expected_revision','profile','resource_binding_id']);assert.equal(body.expected_revision,0);assert.equal(body.profile.password,'secret');assert.equal(body.profile.smtp.password,'smtp-secret');return new Response(JSON.stringify({account_id:target.account_id,provider:'imap_smtp',state:'active',authority_revision:1}));}});
 assert.equal(calls,1);assert.equal(value.password,'');assert.equal(value.smtp.password,'');
});
test('lost acknowledgment, stale scope and invalid port do not retry or retain credentials',async()=>{
 let calls=0;const value=profile();await assert.rejects(submitImapSetup(target,value,{current:()=>true,fetch:async()=>{calls++;throw Error('lost');}}),/Reload its status/);assert.equal(calls,1);assert.equal(value.password,'');
 const unsafe=profile();unsafe.port=143;await assert.rejects(submitImapSetup(target,unsafe,{current:()=>true,fetch:async()=>{calls++;return new Response();}}));assert.equal(calls,1);assert.equal(unsafe.password,'');
 let active=true;const late=profile();await assert.rejects(submitImapSetup(target,late,{current:()=>active,fetch:async()=>{active=false;return new Response('{}');}}),/access changed/);assert.equal(late.password,'');
});
test('foreign or private successful setup receipt cannot claim a connected account; oversized target response bounded',async()=>{
 for(const ack of [{account_id:'other',provider:'imap_smtp',state:'active',authority_revision:1},{account_id:target.account_id,provider:'imap_smtp',state:'active',authority_revision:1,password:'secret'}]){const value=profile();await assert.rejects(submitImapSetup(target,value,{current:()=>true,fetch:async()=>new Response(JSON.stringify(ack))}));assert.equal(value.password,'');}
 await assert.rejects(loadImapSetupTargets({current:()=>true,fetch:async()=>new Response('x'.repeat(65537))}));
});
