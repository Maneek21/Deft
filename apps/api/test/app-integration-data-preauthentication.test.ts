import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createAppIntegrationDataGateway,type AppIntegrationDataGatewayPorts,type AppIntegrationInvocation} from '../src/lib/app-integration-data-gateway.js';

function fixture(entryCheck=false){
 const org=randomUUID(),owner=randomUUID(),digest='sha256:'+'a'.repeat(64),expires=Date.now()+60_000;
 const scope={org_id:org,owner_user_id:owner,installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
  package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,target_key:'primary',resource_key:'messages',resource_binding_id:randomUUID(),
  runtime_registration_id:randomUUID(),operator_user_id:owner,runtime_epoch:1,profile_digest:digest,consent_expires_at:new Date(expires).toISOString()};
 const caller={org_id:org,user_id:owner,kind:'human' as const,principal_id:owner,access_expires_at:expires};
 const target={installation_id:scope.installation_id,account_ref:'account',store_key:'messages'};
 const connection={session_id:randomUUID(),session_revision:1,runtime_session_ref:'runtime',account_ref:'account'};
 const authority={consent_id:null,consent_digest:null,data_policy_digest:digest};
 const context={schema_version:'deft.app_data_authority.v1' as const,request_id:randomUUID(),scope,connection,authority,
  operation:'resource_read_presentation' as const,input_digest:digest,expires_at:new Date(expires).toISOString()};
 let row:AppIntegrationInvocation={caller,target,purpose:'read',identity:'principal',authority_expires_at:expires,context,state:'inflight'};
 let account={identity:'principal',expires_at:expires,resource_binding_id:scope.resource_binding_id,resource_key:scope.resource_key,scope,connection,authority,profile:{}};
 const calls:string[]=[];let credential=true,current=true,final=true;
 let duringCurrent=()=>{};
 const ports:AppIntegrationDataGatewayPorts<unknown>={
  account:async()=>{calls.push('current');if(!current)throw Error('current revoked');duringCurrent();return structuredClone(account);},
  journal:{begin:async()=>{throw Error('unexpected journal write');},read:async()=>{calls.push('journal');return structuredClone(row);},finish:async()=>{throw Error('unexpected journal write');}},
  authenticate:async()=>{calls.push('full');if(!credential||!final)throw Error('final authentication denied');},
  ...(entryCheck?{preauthenticate:async()=>{calls.push('entry');if(!credential)throw Error('entry credential denied');}}:{}),
  transport:async()=>{throw Error('callback cannot perform provider transport');},
 };
 const gateway=createAppIntegrationDataGateway(ports);
 return {calls,context,gateway,ports,callback:()=>gateway.callback(context,'Bearer service'),credential:(value:boolean)=>{credential=value;},
  current:(value:boolean)=>{current=value;},revokeFinal:()=>{final=false;},duringCurrent:(fn:()=>void)=>{duringCurrent=fn;},
  mutateAccount:(patch:Partial<typeof account>)=>{account={...account,...patch};},mutateJournal:(patch:Partial<AppIntegrationInvocation>)=>{row={...row,...patch};}};
}

test('default callback keeps both full checks; optional entry admission still requires full current and final authentication',async()=>{
 const ordinary=fixture();assert.equal((await ordinary.callback()).allowed,true);
 assert.deepEqual(ordinary.calls,['full','journal','current','journal','full']);
 const fast=fixture(true);assert.equal((await fast.callback()).allowed,true);
 assert.deepEqual(fast.calls,['entry','journal','current','journal','full']);
});

test('bad entry credentials stop before journal reads and every current/final revocation withholds the allowed result',async()=>{
 const denied=fixture(true);denied.credential(false);await assert.rejects(denied.callback());assert.deepEqual(denied.calls,['entry']);
 const removed=fixture(true);removed.current(false);await assert.rejects(removed.callback());assert.deepEqual(removed.calls,['entry','journal','current']);
 const revoked=fixture(true);revoked.duringCurrent(()=>revoked.revokeFinal());await assert.rejects(revoked.callback());
 assert.deepEqual(revoked.calls,['entry','journal','current','journal','full']);
});

test('owner/epoch/replay and journal changes cannot turn credential-only entry admission into authority',async()=>{
 for(const change of [{owner_user_id:randomUUID()},{runtime_epoch:2},{runtime_registration_id:randomUUID()},{app_version_id:randomUUID()}]){
  const f=fixture(true);f.mutateAccount({scope:{...f.context.scope,...change}});await assert.rejects(f.callback());
  assert.deepEqual(f.calls,['entry','journal','current']);
 }
 const replay=fixture(true);replay.mutateJournal({context:{...replay.context,input_digest:'sha256:'+'b'.repeat(64)}});await assert.rejects(replay.callback());
 assert.deepEqual(replay.calls,['entry','journal']);
 const finished=fixture(true);finished.duringCurrent(()=>finished.mutateJournal({state:'completed'}));await assert.rejects(finished.callback());
 assert.deepEqual(finished.calls,['entry','journal','current','journal']);
});
