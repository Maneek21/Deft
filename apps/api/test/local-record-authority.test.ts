import test from 'node:test';
import assert from 'node:assert/strict';
import {AppDataService} from '../src/lib/app-data-service';
import {PostgresAppDataStore} from '../src/lib/app-data-store';
import {appDataConnectionActionSelection} from '../src/lib/app-data-read-authority';
import {fixture,uuid} from './app-data-record-changes-test-fixture';

test('actual AppDataService saved-content admission selects fresh data authority for both stores without unrelated action grants',async()=>{
 const original=PostgresAppDataStore.prototype.begin;
 PostgresAppDataStore.prototype.begin=async()=>false;
 try{
  for(const operation of ['record_prepare_change','record_apply_change'] as const){
   const f=fixture(),plan=f.prepare(),calls:any[]=[];
   const service=new AppDataService({org_id:f.scope.org_id,user_id:f.scope.owner_user_id,sid:uuid(),access_expires_at:Date.now()+60000} as any,(async()=>{}) as any);
   service.current=async(...args:any[])=>{calls.push(args);assert.equal(appDataConnectionActionSelection(args[3]),'none');return (args[1]==='drafts'?f.destination:f.source) as any;};
   const input=operation==='record_prepare_change'?f.input:{...f.input,prepared_id:plan.prepared_id,prepared_digest:plan.prepared_digest};
   await assert.rejects(service.invoke(f.connection.session_id,{schema_version:'deft.app_data_request.v1',request_id:uuid(),operation,input}),{code:'APP_STATE_CONFLICT'});
   assert.deepEqual(calls.map(c=>[c[1],c[2],c[3]]),[['drafts',true,operation],['templates',true,operation]]);
  }
 }finally{PostgresAppDataStore.prototype.begin=original;}
});

test('saved-content selections remain data-only while unknown and provider-action paths retain full capture',()=>{
 for(const operation of ['record_prepare_change','record_apply_change'])assert.equal(appDataConnectionActionSelection(operation),'none');
 for(const operation of [undefined,'prepare_action','prepared_action_commit','prepared_action_restore','unrecognized'])assert.equal(appDataConnectionActionSelection(operation),undefined);
});
