import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSyncPageV2,digestResourceSyncDescriptorV2} from '@deft/app-kit';
import {LogicalMailIndex} from './logical-mail-index.mjs';
import {EMAIL_METADATA_DESCRIPTOR,projectEmailMetadata,assertEmailMetadataDescriptor,validateMetadataFolderMap} from './metadata-resource.mjs';
import {buildEmailMetadataFixturePages,loadEmailMetadataFixtureSummaries} from './metadata-fixtures.mjs';
import {createEmailMetadataReader,emailMetadataInFolder,emailMetadataRelated} from './metadata-ui.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/launch-stage0/fixtures.json',import.meta.url))),scope={...fixture.scope,installation_id:'metadata-fixture-installation'};
const request={schema_version:'deft.app_sync_request.v2',cursor:null,max_items:2,attachments:EMAIL_METADATA_DESCRIPTOR.attachments};
test('Stage 0 MIME headers -> logical DTO -> actual reviewed Kit resource page -> scoped browser reader',async()=>{
 const personal=await buildEmailMetadataFixturePages({scope,account_id:'gmail-personal'}),work=await buildEmailMetadataFixturePages({scope,account_id:'gmail-work',index:personal.index}),graph=await buildEmailMetadataFixturePages({scope,account_id:'microsoft',index:personal.index}),imap=await buildEmailMetadataFixturePages({scope,account_id:'imap',index:personal.index}),rows=[];
 for(const page of [...personal.pages,...work.pages,...graph.pages,...imap.pages])rows.push(...parseSyncPageV2(EMAIL_METADATA_DESCRIPTOR,request,page).upserts);
 assert.equal(rows.length,7);assert.equal(EMAIL_METADATA_DESCRIPTOR.key,'mail_index');assert.equal(EMAIL_METADATA_DESCRIPTOR.requested_visibility,'user_private');
 const serialized=JSON.stringify(rows);for(const forbidden of ['synthetic-gmail-personal-001','synthetic-graph-message-001','inbox:3001:1','Please review the synthetic brief','Content-Type','staging_id','<script'])assert.equal(serialized.includes(forbidden),false,forbidden);
 assert.ok(rows.every(row=>row.attachments.length===0&&row.data.body_status==='lazy'&&!Object.hasOwn(row.data,'body')&&!Object.hasOwn(row.data,'provider_message_id')));
 const calls=[],uuid='00000000-0000-4000-8000-000000000001',reader=createEmailMetadataReader({readResourceRecord:async(key,id)=>{calls.push([key,id]);return {item:{record_id:id,data:rows[0].data}};}},{account_id:'gmail-personal'}),view=await reader.read(uuid);
 assert.deepEqual(calls,[['mail_index',uuid]]);assert.equal(view.resource_id,'');assert.equal(view.message_id,'');assert.match(view.body_notice,/unavailable/);assert.match(view.files_notice,/unavailable/);assert.equal(view.files_status,'unknown');assert.equal(emailMetadataInFolder(view,'inbox'),true);
 const related=rows.map(row=>({...view,...row.data}));assert.equal(emailMetadataRelated(view,related).length,3);assert.ok(emailMetadataRelated(view,related).some(row=>row.in_sent));
 const graphRow=rows.find(row=>row.data.provider==='microsoft');assert.equal(graphRow.data.files_status,'unknown');assert.equal(graphRow.data.in_inbox,true);assert.equal(rows.find(row=>row.data.provider==='imap_smtp').data.in_inbox,true);
});
test('no same-subject/header-ID account collapse; labels are bounded with explicit preview truncation',async()=>{
 const [summary]=await loadEmailMetadataFixtureSummaries('gmail-personal'),index=new LogicalMailIndex(scope),subject='S'.repeat(1000),first=index.upsert(scope,{...summary,subject}),second=index.upsert(scope,{...summary,subject,account_id:'gmail-work'}),a=projectEmailMetadata(first),b=projectEmailMetadata(second);
 assert.notEqual(a.id,b.id);assert.notEqual(a.data.conversation_id,b.data.conversation_id);assert.equal(a.data.label.length,200);assert.equal(a.data.subject.length,1000);assert.equal(a.data.subject_preview_truncated,true);
});
test('unknown opaque Graph folders stay incomplete; only reviewed folder maps classify them',async()=>{
 const [summary]=await loadEmailMetadataFixtureSummaries('microsoft'),record=new LogicalMailIndex(scope).upsert(scope,summary),unknown=projectEmailMetadata(record),known=projectEmailMetadata(record,{folder_map:{inbox:[summary.locator.folder_id]}});
 assert.equal(unknown.data.folder_membership_complete,false);assert.equal(unknown.data.in_inbox,false);assert.equal(known.data.folder_membership_complete,true);assert.equal(known.data.in_inbox,true);
 assert.throws(()=>validateMetadataFolderMap({inbox:['same'],sent:['same']}),/EMAIL_PROVIDER_FOLDER_MAP_INVALID/);
});
test('exact descriptor pin rejects widening visibility/attachment policy/schema before provider access',async()=>{
 const digest=await digestResourceSyncDescriptorV2(EMAIL_METADATA_DESCRIPTOR);await assertEmailMetadataDescriptor(EMAIL_METADATA_DESCRIPTOR,digest);
 for(const descriptor of [{...EMAIL_METADATA_DESCRIPTOR,key:'inbox'},{...EMAIL_METADATA_DESCRIPTOR,attachments:{...EMAIL_METADATA_DESCRIPTOR.attachments,max_attachment_bytes:2}},{...EMAIL_METADATA_DESCRIPTOR,requested_visibility:'organization'}])await assert.rejects(assertEmailMetadataDescriptor(descriptor,digest),/EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED/);
 const reader=createEmailMetadataReader({readResourceRecord:async()=>({item:{record_id:'other',data:{}}})});await assert.rejects(reader.read('selected'),/EMAIL_METADATA_RECORD_UNAVAILABLE/);
 const [summary]=await loadEmailMetadataFixtureSummaries('gmail-personal'),data=projectEmailMetadata(new LogicalMailIndex(scope).upsert(scope,summary)).data,cross=createEmailMetadataReader({readResourceRecord:async()=>({item:{record_id:'selected',data}})},{account_id:'gmail-work'});await assert.rejects(cross.read('selected'),/EMAIL_METADATA_RECORD_UNAVAILABLE/);
});


test('only historical mail_index and reviewed inbox names accept their own exact host-attested digest',async()=>{
 for(const key of ['inbox','mail_index']){
  const descriptor={...EMAIL_METADATA_DESCRIPTOR,key},digest=await digestResourceSyncDescriptorV2(descriptor);await assertEmailMetadataDescriptor(descriptor,digest);
  for(const changed of [{...descriptor,key:'other_mail'},{...descriptor,runtime_requirement_key:'other_runtime'},{...descriptor,label_field:'metadata_version'},{...descriptor,resource_type:'other_type'},{...descriptor,attachments:{...descriptor.attachments,max_attachment_bytes:2}},{...descriptor,record_schema:{...descriptor.record_schema,required:descriptor.record_schema.required.slice(1)}},{...descriptor,requested_visibility:'organization'}]){
   // Even the changed descriptor's real digest cannot authorize a widened shape.
   let changedDigest;try{changedDigest=await digestResourceSyncDescriptorV2(changed);}catch{changedDigest=digest;}await assert.rejects(assertEmailMetadataDescriptor(changed,changedDigest),/EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED/);
  }
  const other={...descriptor,key:key==='inbox'?'mail_index':'inbox'};await assert.rejects(assertEmailMetadataDescriptor(descriptor,await digestResourceSyncDescriptorV2(other)),/EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED/);
  await assert.rejects(assertEmailMetadataDescriptor(descriptor,'sha256:'+'a'.repeat(64)),/EMAIL_PROVIDER_SYNC_DESCRIPTOR_UNSUPPORTED/);
 }
});
