import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmailSmtpHost} from '../src/lib/email-smtp-host.js';
import type {EmailImapHostAccount} from '../src/lib/email-imap-host.js';
import type {NativeEmailConnectionContext} from '../src/lib/app-connection-contract.js';
const account=():EmailImapHostAccount=>({org_id:'org',owner_user_id:'owner',installation_id:'install',account_id:'account',provider:'imap_smtp',resource_binding_id:'binding',authority_epoch:1,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','send'],primary_address:'sender@example.test',display_label:'Mailbox',connection_target:'target',action_binding_id:'send-binding',verified_sender_identities:['sender@example.test']});
function fixture(options:{privateDns?:boolean;held?:boolean;reject?:boolean;revoke?:boolean;verifyFalse?:boolean}={}){
 let metadata=account(),transportOptions:Record<string,any>|undefined,requests:any[]=[],closes=0,lookups=0,settle:()=>void=()=>{};
 const controller=new AbortController(),context:NativeEmailConnectionContext={org_id:'org',owner_user_id:'owner',installation_id:'install',account_id:'account',resource_binding_id:'binding',authority_version:'v1',expires_at:Date.now()+60000,recheck:async()=>{},signal:controller.signal};
 const {org_id:_org,owner_user_id:_owner,installation_id:_install,connection_target:_target,action_binding_id:_action,verified_sender_identities:_senders,...expected}=metadata;
 const host=createEmailSmtpHost({current:async(_context,purpose)=>{assert.equal(purpose,'send');return structuredClone(metadata);},
  custody:{async withVerifiedSmtpProfile(_context,_expected,work){return work({host:'smtp.example.test',port:587,username:'sender@example.test',password:'synthetic-only',tls:{mode:'starttls_required',minVersion:'TLSv1.2',rejectUnauthorized:true}});}},
  lookup:async()=>{lookups++;return [{address:options.privateDns?'127.0.0.1':'8.8.8.8',family:4}];},
  createTransport:value=>{transportOptions=value;return {close(){closes++;settle();},async verify(){if(options.revoke)metadata={...metadata,connection_revision:2};return !options.verifyFalse;},async sendMail(input){requests.push({...input,raw:Buffer.from(input.raw)});
   if(options.held)await new Promise<void>(resolve=>{settle=resolve;});if(options.reject)throw Error('SMTP private detail');if(options.revoke)metadata={...metadata,connection_revision:2};return {accepted:['hidden@example.test'],rejected:[]};}};}});
 const input={raw:Buffer.from('Subject: synthetic\r\n\r\nHello'),envelope:{from:'sender@example.test',to:['hidden@example.test']},disableFileAccess:true as const,disableUrlAccess:true as const};
 return {host,context,expected,input,controller,get options(){return transportOptions;},get requests(){return requests;},get closes(){return closes;},get lookups(){return lookups;}};
}
test('SMTP pins public host with original SNI, mandatory TLS, private credentials and exact trusted envelope',async()=>{
 const f=fixture();await f.host.withAuthorizedSmtp(f.context,f.expected,transport=>transport.sendMail(f.input));
 assert.equal(f.options?.host,'8.8.8.8');assert.equal(f.options?.tls.servername,'smtp.example.test');assert.equal(f.options?.requireTLS,true);assert.equal(f.options?.tls.rejectUnauthorized,true);
 assert.equal(f.options?.debug,false);assert.equal(f.options?.disableFileAccess,true);assert.equal(f.options?.disableUrlAccess,true);assert.equal(f.options?.auth.pass,'');
 assert.deepEqual(f.requests[0].envelope,f.input.envelope);assert.deepEqual(f.requests[0].raw,f.input.raw);assert.equal(f.requests.length,1);assert.equal(f.closes,1);
});
test('private DNS and sender spoofing cannot reach SMTP delivery',async()=>{
 const privateHost=fixture({privateDns:true});await assert.rejects(privateHost.host.withAuthorizedSmtp(privateHost.context,privateHost.expected,transport=>transport.sendMail(privateHost.input)),/EMAIL_ACCESS_DENIED/);assert.equal(privateHost.options,undefined);
 const f=fixture();await assert.rejects(f.host.withAuthorizedSmtp(f.context,f.expected,transport=>transport.sendMail({...f.input,envelope:{...f.input.envelope,from:'other@example.test'}})),/EMAIL_ACCESS_DENIED/);assert.equal(f.requests.length,0);
});
test('a host callback may transmit once; errors and late identity changes remain uncertain to the caller',async()=>{
 const f=fixture();await assert.rejects(f.host.withAuthorizedSmtp(f.context,f.expected,async transport=>{await transport.sendMail(f.input);await transport.sendMail(f.input);}),/EMAIL_ACCESS_DENIED/);assert.equal(f.requests.length,1);
 for(const options of [{reject:true},{revoke:true}]){const f=fixture(options);await assert.rejects(f.host.withAuthorizedSmtp(f.context,f.expected,transport=>transport.sendMail(f.input)),/EMAIL_(SMTP_UNAVAILABLE|ACCESS_DENIED)/);assert.equal(f.requests.length,1);assert.equal(f.closes,1);}
});
test('abort closes a held SMTP transport and cannot retry',async()=>{
 const f=fixture({held:true}),pending=f.host.withAuthorizedSmtp(f.context,f.expected,transport=>transport.sendMail(f.input));
 while(!f.requests.length)await new Promise<void>(resolve=>setImmediate(resolve));f.controller.abort();await assert.rejects(pending);assert.equal(f.closes,1);assert.equal(f.requests.length,1);
});

test('setup authenticates SMTP without sending, and rejects false verification or late revocation',async()=>{
 const f=fixture();assert.equal(await f.host.withAuthorizedSmtp(f.context,f.expected,transport=>transport.verify!()),true);
 assert.equal(f.requests.length,0);assert.equal(f.closes,1);assert.equal(f.options?.auth.pass,'');
 for(const options of [{verifyFalse:true},{revoke:true}]){const f=fixture(options);await assert.rejects(f.host.withAuthorizedSmtp(f.context,f.expected,transport=>transport.verify!()),/EMAIL_(SMTP_UNAVAILABLE|ACCESS_DENIED)/);assert.equal(f.requests.length,0);assert.equal(f.closes,1);}
});
