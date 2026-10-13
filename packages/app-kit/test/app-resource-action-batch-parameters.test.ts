import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AppResourceActionBatchPrepareSchema} from '../src/app-resource-action-batch.js';
const make=(parameters?:Record<string,string>)=>({action_key:'transform_records',store_key:'records',resource_key:'inbox',operation_key:'apply_policy',sources:[{resource_key:'inbox',record_id:randomUUID(),content_digest:'sha256:'+'a'.repeat(64)}],...(parameters?{parameters}:{})});
const request=(children:ReturnType<typeof make>[])=>({connection_session_id:randomUUID(),idempotency_key:randomUUID(),children});
test('generic grouped actions preserve the same bounded parameters across exact source groups',()=>{
 const parameters={policy_id:randomUUID(),revision:'2',digest:'sha256:'+'b'.repeat(64)};
 const rows=[make(parameters),make({digest:parameters.digest,revision:'2',policy_id:parameters.policy_id})];
 const accepted=AppResourceActionBatchPrepareSchema.parse(request(rows));assert.deepEqual(accepted.children[0]!.parameters,parameters);assert.deepEqual(accepted.children[1]!.parameters,rows[1]!.parameters);
 assert.equal(AppResourceActionBatchPrepareSchema.safeParse(request([make(),make()])).success,true);
});
test('mixed or oversized grouped parameters and duplicate sources stay rejected',()=>{
 const first=make({policy_id:randomUUID(),revision:'2'});
 for(const second of [make({...first.parameters,revision:'3'}),make(),make({policy_id:randomUUID(),revision:'2'}),make({body:'x'.repeat(8193)}),structuredClone(first)]){
  assert.equal(AppResourceActionBatchPrepareSchema.safeParse(request([first,second])).success,false);
 }
});
