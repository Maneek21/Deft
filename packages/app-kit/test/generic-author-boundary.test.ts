import assert from 'node:assert/strict';
import test from 'node:test';
import {AppDataIdentitySchema,DeftExperienceRecordFormV3NodeSchema} from '../src/app-data.js';
import {AppConnectionFormAccountSchema} from '../src/connection-form.js';
import {ResourceContentPolicySchema} from '../src/resource-content-policy.js';

test('a non-mail principal and source use the same bounded public contracts',()=>{
 const identity={address:'warehouse:west/42',label:'West warehouse'};
 assert.deepEqual(AppDataIdentitySchema.parse(identity),identity);
 assert.ok(AppConnectionFormAccountSchema.safeParse({...identity,account_ref:'west_42',capabilities:['read'],identity_assurance:'owner_declared_authenticated'}).success);
 assert.ok(ResourceContentPolicySchema.safeParse({document:{max_characters:2000},source:{media_type:'application/json',filename:'inventory.json',max_bytes:4096},search_filters:['sku','in_stock']}).success);
 for(const address of ['', 'x\nheader', '<script>'])assert.equal(AppDataIdentitySchema.safeParse({...identity,address}).success,false);
 for(const filename of ['../inventory.json','x\nheader','a\\b'])assert.equal(ResourceContentPolicySchema.safeParse({document:{max_characters:1},source:{media_type:'application/json',filename,max_bytes:1}}).success,false);
});

test('generic forms retain unsaved seed, exact record references and declared controls',()=>{
 const node={kind:'record_form',id:'work_order',label:'Work order',store_key:'orders',record_id:'11111111-1111-4111-8111-111111111111',
  expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),seed:{schema_version:'deft.record_form_seed.v1',value:{title:''}},action_key:'submit_order',
  profile:{schema_version:'deft.record_form_profile.v3',max_record_bytes:4096,fields:[{kind:'text',field:'title',label:'Title',max_characters:100,required:true},{kind:'verified_identity',field:'principal',identity_field:'address',label:'Warehouse',editable:false}]}};
 assert.ok(DeftExperienceRecordFormV3NodeSchema.safeParse(node).success);
 assert.equal(DeftExperienceRecordFormV3NodeSchema.safeParse({...node,seed:undefined}).success,false);
 assert.equal(DeftExperienceRecordFormV3NodeSchema.safeParse({...node,content_digest:'sha256:'+'a'.repeat(64)}).success,false);
 assert.equal(DeftExperienceRecordFormV3NodeSchema.safeParse({...node,source_refs:[{resource_key:'orders',record_id:node.record_id,content_digest:node.content_digest}]}).success,false);
 for(const field of [{...node.profile.fields[0],presentation:'pills'},{...node.profile.fields[0],optional:true}])assert.equal(DeftExperienceRecordFormV3NodeSchema.safeParse({...node,profile:{...node.profile,fields:[field]}}).success,false);
 assert.equal(DeftExperienceRecordFormV3NodeSchema.safeParse({...node,profile:{...node.profile,fields:[node.profile.fields[0],node.profile.fields[0]]}}).success,false);
});
