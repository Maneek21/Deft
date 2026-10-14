import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {parseAppPreparedEffectDetails,canonicalAppPreparedEffectJson,AppPreparedEffectReceiptSchema} from '../src/prepared-effect.js';
import {AppDataPreparedRecordActionSchema} from '../src/app-data.js';
const id='11111111-1111-4111-8111-111111111111',hash='sha256:'+'a'.repeat(64);
const declaration={key:'audit_copy',action_key:'submit_order',version:'inventory.audit.v1',details_schema:{type:'object',properties:{destination:{type:'string',maxLength:80}},required:['destination'],additionalProperties:false}};
const effect={schema_version:'deft.app_prepared_effect.v1',effect_key:'audit_copy',version:'inventory.audit.v1',account_ref:'warehouse_42',custody_generation:1,action_binding_id:id,content_digest:hash,content_bytes:10,details:{destination:'reviewed archive'},plan_digest:hash};
effect.plan_digest='sha256:'+createHash('sha256').update(canonicalAppPreparedEffectJson(effect)).digest('hex');
test('non-mail supplemental effects validate the package declaration and canonical content',()=>{
 assert.deepEqual(parseAppPreparedEffectDetails(declaration,effect),effect);
 assert.equal(canonicalAppPreparedEffectJson({...effect,plan_digest:'sha256:'+'b'.repeat(64)}),canonicalAppPreparedEffectJson(effect));
 for(const value of [{...effect,effect_key:'foreign'},{...effect,version:'foreign.v1'},{...effect,details:{destination:'x'.repeat(81)}},{...effect,details:{destination:'x',url:'https://foreign.test'}}])assert.throws(()=>parseAppPreparedEffectDetails(declaration,value));
});
test('prepared input pins must match the same sealed effect and account',()=>{
 const prepared={schema_version:'deft.app_prepared_record_action.v1',snapshot_id:id,snapshot_digest:hash,record_id:id,revision:1,action_key:'submit_order',input:{account_ref:effect.account_ref,effect_key:effect.effect_key,effect_version:effect.version,effect_plan_digest:effect.plan_digest,effect_content_digest:effect.content_digest,effect_custody_generation:1},preview:{title:'Order'},expires_at:'2026-10-15T00:00:00.000Z',supplemental_effect:effect};
 assert.ok(AppDataPreparedRecordActionSchema.safeParse(prepared).success);
 for(const field of ['account_ref','effect_key','effect_version','effect_plan_digest','effect_content_digest','effect_custody_generation'])assert.equal(AppDataPreparedRecordActionSchema.safeParse({...prepared,input:{...prepared.input,[field]:'foreign'}}).success,false);
 assert.equal(AppDataPreparedRecordActionSchema.safeParse({...prepared,supplemental_effect:undefined}).success,false);
});
test('unknown primary acceptance cannot authorize a supplemental effect or retry',()=>{
 const receipt={schema_version:'deft.app_prepared_effect_receipt.v1',operation_id:id,run_id:id,attempt_id:id,effect_key:effect.effect_key,version:effect.version,account_ref:effect.account_ref,custody_generation:1,action_binding_id:id,snapshot_digest:hash,plan_digest:effect.plan_digest,content_digest:hash,primary_outcome:'accepted',effect_outcome:'unknown',automatic_retry:false};
 assert.ok(AppPreparedEffectReceiptSchema.safeParse(receipt).success);
 assert.equal(AppPreparedEffectReceiptSchema.safeParse({...receipt,primary_outcome:'unknown'}).success,false);
 assert.ok(AppPreparedEffectReceiptSchema.safeParse({...receipt,primary_outcome:'unknown',effect_outcome:'not_attempted'}).success);
 assert.equal(AppPreparedEffectReceiptSchema.safeParse({...receipt,automatic_retry:true}).success,false);
});
