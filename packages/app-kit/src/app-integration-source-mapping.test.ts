import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AppIntegrationSourceMappingSchema,appIntegrationSourceMappingIsDeclared} from './app-integration-source-mapping.js';
const mapping={sync_descriptor_key:'inbox',record_id_field:'source_record_id',content_digest_field:'source_content_digest',observed_at_field:'source_observed_at',projection_identity_field:'logical_message_id',navigation_entry_key:'main'};
const descriptor={key:'inbox',record_schema:{properties:{source_record_id:{type:'string',maxLength:36},source_content_digest:{type:'string',maxLength:71},source_observed_at:{type:'string',maxLength:64},logical_message_id:{type:'string',maxLength:96}},required:['source_record_id','source_content_digest','source_observed_at','logical_message_id']}};
test('mapping admission requires declared required bounded scalar fields and signed installed navigation',()=>{
 assert.equal(AppIntegrationSourceMappingSchema.safeParse(mapping).success,true);assert.equal(appIntegrationSourceMappingIsDeclared(mapping,descriptor,['main']),true);
 assert.equal(appIntegrationSourceMappingIsDeclared(mapping,descriptor,['author_url']),false);
 assert.equal(appIntegrationSourceMappingIsDeclared(mapping,{...descriptor,key:'foreign'},['main']),false);
 assert.equal(appIntegrationSourceMappingIsDeclared(mapping,{...descriptor,record_schema:{...descriptor.record_schema,required:[]}},['main']),false);
 assert.equal(appIntegrationSourceMappingIsDeclared(mapping,{...descriptor,record_schema:{...descriptor.record_schema,properties:{...descriptor.record_schema.properties,logical_message_id:{type:'string',maxLength:4096}}}},['main']),false);
 assert.equal(AppIntegrationSourceMappingSchema.safeParse({...mapping,projection_identity_field:mapping.record_id_field}).success,false);
});
