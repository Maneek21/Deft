import test from 'node:test';
import assert from 'node:assert/strict';
import {EmailSentCopySettingsService} from '../src/lib/email-sent-copy-settings.js';
test('public Sent-copy settings honor scoped human read/modify, exact revision, availability and explicit CAS authority change',async()=>{
 const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},actor={user_id:'owner',web_session_id:'real-human-session',access_expires_at:Date.now()+60000};let revision=3,mode:'server_managed'|'append'='server_managed',available=true,revoked=false,writes=0;const operations:string[]=[];
 const authority={current:async(a:any,s:any,operation:string)=>{assert.deepEqual(a,actor);assert.deepEqual(s,scope);operations.push(operation);if(revoked)throw Error('REVOKED');return {scope,resource_binding_id:'binding',authority_version:'version'+revision,expires_at:Date.now()+60000};}};
 const provider={settings:async(s:any,cap:any,check:any)=>{assert.deepEqual(s,scope);await check();assert.equal(cap.authority_version,'version'+revision);return {account_id:scope.account_id,revision,sent_copy_mode:mode,provider:'imap_smtp' as const,append_available:available,...(available?{}:{reason:'sent_folder_unavailable' as const})};}};
 const custodyFor=async(s:any,check:any)=>{assert.deepEqual(s,scope);await check();return {updateSentCopyMode:async(s2:any,expected:number,next:'server_managed'|'append',guard:any)=>{assert.deepEqual(s2,scope);await guard();assert.equal(expected,revision);revision++;mode=next;writes++;await guard();return {account_id:scope.account_id,revision,sent_copy_mode:mode};}};};
 const service=new EmailSentCopySettingsService(authority,provider,custodyFor);assert.equal((await service.read(actor,scope)).sent_copy_mode,'server_managed');assert.ok(operations.every(op=>op==='human_read'));
 assert.equal((await service.update(actor,scope,{expected_revision:3,sent_copy_mode:'append'})).revision,4);assert.ok(new Set<string>(operations).has('human_modify'));assert.equal(writes,1);
 await assert.rejects(service.update(actor,scope,{expected_revision:3,sent_copy_mode:'server_managed'}),/CONFLICT/);available=false;await assert.rejects(service.update(actor,scope,{expected_revision:4,sent_copy_mode:'append'}),/UNAVAILABLE/);assert.equal(writes,1);
 await assert.rejects(service.update(actor,scope,{expected_revision:4,sent_copy_mode:'server_managed',password:'caller-secret'}));await assert.rejects(service.read({...actor,user_id:'foreign'},scope),/DENIED/);revoked=true;await assert.rejects(service.read(actor,scope),/REVOKED/);
});
