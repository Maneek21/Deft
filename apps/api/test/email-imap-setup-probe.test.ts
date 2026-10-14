import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {verifyEmailImapSetup} from '../src/lib/email-imap-setup-probe.js';
import type {AppConnectionPins} from '../src/lib/app-connection-contract.js';
import type {NativeEmailConnectionContext} from '../src/lib/email-native-adapter-contract.js';
function fixture(options:{smtp?:boolean;failImap?:boolean;failSmtp?:boolean;revokeAfterAuth?:boolean;privateDns?:boolean}={}){
 const pins:AppConnectionPins={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),target_key:'mail',resource_key:'inbox',resource_binding_id:randomUUID(),action_key:'send_message',action_binding_id:randomUUID()};
 let revoked=false;const counts={connect:0,close:0,smtp:0,smtpClose:0,send:0};
 const context:NativeEmailConnectionContext={org_id:pins.org_id,owner_user_id:pins.owner_user_id,installation_id:pins.installation_id,account_id:'account',resource_binding_id:pins.resource_binding_id,authority_version:'setup-fixture',expires_at:Date.now()+60000,recheck:async()=>{if(revoked)throw Error('Revoked');}};
 const profile={host:'imap.example.test',port:993,transport:'implicit_tls',username:'user',password:'synthetic-imap',identity:{primary_address:'configured@example.test',display_label:'Configured account'},
  ...(options.smtp?{smtp:{host:'smtp.example.test',port:587,transport:'starttls_required',username:'sender',password:'synthetic-smtp'}}:{})};
 const keys={current:()=>({key_id:'fixture',key:Buffer.alloc(32,12)}),read:()=>({key_id:'fixture',key:Buffer.alloc(32,12)}),keyIds:()=>['fixture']};
 const constructors={ImapFlow:class{secureConnection=true;tls={authorized:true};authenticated=true;
  async connect(){counts.connect++;if(options.failImap)throw Error('Private authentication details');if(options.revokeAfterAuth)revoked=true;}
  async logout(){}close(){counts.close++;}},createTransport:()=>({async verify(){counts.smtp++;return !options.failSmtp;},async sendMail(){counts.send++;throw Error('Setup must not send');},close(){counts.smtpClose++;}})};
 return {counts,input:{context,pins,profile,keys,constructors,lookup:async()=>[{address:options.privateDns?'127.0.0.1':'8.8.8.8',family:4}]}};
}
test('account setup verifies IMAP and optional SMTP without reading or sending mail; only host stamps authentication time',async()=>{
 const f=fixture({smtp:true}),value=await verifyEmailImapSetup(f.input);
 assert.ok(value.verified_at);assert.equal(value.identity?.primary_address,'configured@example.test');assert.equal(value.password,'synthetic-imap');assert.equal(value.smtp?.password,'synthetic-smtp');
 assert.deepEqual(f.counts,{connect:1,close:1,smtp:1,smtpClose:1,send:0});assert.equal(f.input.profile.password,'synthetic-imap','Caller input is not mutated');
 const readOnly=fixture();await verifyEmailImapSetup(readOnly.input);assert.equal(readOnly.counts.smtp,0);
});
test('setup cannot bypass verification, SMTP reviewed binding, public host checks or current authority',async()=>{
 const forged=fixture();await assert.rejects(verifyEmailImapSetup({...forged.input,profile:{...forged.input.profile,verified_at:new Date().toISOString()}}));assert.equal(forged.counts.connect,0);
 const noSend=fixture({smtp:true});await assert.rejects(verifyEmailImapSetup({...noSend.input,pins:{...noSend.input.pins,action_key:null,action_binding_id:null}}),/EMAIL_ACCESS_DENIED/);assert.equal(noSend.counts.connect,0);
 for(const options of [{failImap:true},{smtp:true,failSmtp:true},{revokeAfterAuth:true},{privateDns:true}]){const f=fixture(options);await assert.rejects(verifyEmailImapSetup(f.input));assert.equal(f.counts.send,0);}
});
