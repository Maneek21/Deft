import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {AppRunTransaction} from '../src/lib/app-run-repository.js';
process.env.DATABASE_URL='postgresql://fixture@127.0.0.1:1/observation_unit_no_database';
process.env.ENCRYPTION_KEY='synthetic-observation-unit-key-only-32';
const {hasResourceObservationPin,requireCurrentResourceObservationRun,assertResourceObservationEnabled,assertObservationMetadataCatalogAbsent}=
 await import('../src/lib/app-resource-observation-authority.js');
test('additional immutable policy pin cannot downgrade to the manual sync lane when its link is absent',async()=>{
 const binding=randomUUID(),consent=randomUUID();
 assert.equal(hasResourceObservationPin({authority_refs:[{authority_kind:'policy',authority_id:binding}]},binding),false);
 assert.equal(hasResourceObservationPin({authority_refs:[{authority_kind:'policy',authority_id:binding},{authority_kind:'policy',authority_id:consent}]},binding),true);
 let queried=0;
 const tx={select(){queried++;return {from(){return {where(){return {limit:async()=>[]};}};}};}} as unknown as AppRunTransaction;
 await assert.rejects(requireCurrentResourceObservationRun(tx,randomUUID(),randomUUID(),{} as any,()=>new Date()),
  (error:any)=>error.code==='APP_ACCESS_DENIED'&&error.status===403);
 assert.equal(queried,1,'absence is denied before any account or legacy fallback');
});
test('current observation kill switch rejects either Apps or owner-connection disablement',()=>{
 const previous={apps:process.env.DEFT_APPS_ENABLED,owner:process.env.DEFT_APP_OWNER_CONNECTIONS_ENABLED};
 try{process.env.DEFT_APPS_ENABLED='false';assert.throws(assertResourceObservationEnabled,(error:any)=>error.code==='APP_FEATURE_DISABLED');
  process.env.DEFT_APPS_ENABLED='true';process.env.DEFT_APP_OWNER_CONNECTIONS_ENABLED='false';
  assert.throws(assertResourceObservationEnabled,(error:any)=>error.code==='APP_FEATURE_DISABLED');
 }finally{for(const [name,value] of [['DEFT_APPS_ENABLED',previous.apps],['DEFT_APP_OWNER_CONNECTIONS_ENABLED',previous.owner]]){
  if(value===undefined)delete process.env[name!];else process.env[name!]=value;
 }}
});

test('a retained live attachment catalog denies scalar observation without changing custody',async()=>{
 let writes=0;
 const tx={select(){return {from(){return {where(){return {limit:async()=>[{id:randomUUID()}]};}};}};},update(){writes++;throw Error('Unexpected mutation');}} as unknown as AppRunTransaction;
 await assert.rejects(assertObservationMetadataCatalogAbsent(tx,randomUUID(),randomUUID()),(error:any)=>error.code==='APP_ACCESS_DENIED');
 assert.equal(writes,0);
});
