import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {prepareDeftExperienceArtifact,buildDeftAppPackage} from '@deft/app-kit';
import {EMAIL_METADATA_DESCRIPTOR} from './metadata-resource.mjs';

const root=realpathSync(process.cwd());
for(const name of ['@deft/app-kit','esbuild']) assert.ok(realpathSync(resolve('node_modules',name)).startsWith(root+sep));
const bundle=entry=>build({entryPoints:[entry+'.mjs'],outfile:entry+'.bundle.js',bundle:true,minify:true,format:'iife',platform:'browser',target:'es2022',metafile:true});
const legacyBuild=await bundle('worker');
assert.ok(!Object.keys(legacyBuild.metafile.inputs).some(path=>path.endsWith('/dist/index.js')||path.includes('/node_modules/zod/')));
const metadataBuild=await bundle('metadata-worker');
assert.ok(!Object.keys(metadataBuild.metafile.inputs).some(path=>path.endsWith('/dist/index.js')||path.includes('/node_modules/zod/')));
const actions=['send_message'];
const artifact=await prepareDeftExperienceArtifact('experiences/main.json',{
  schema_version:'deft.experience_bundle.v3',state_keys:['drafts','requests'],search_resource_keys:['inbox'],
  worker_source:readFileSync('worker.bundle.js','utf8'),entry_view:'main',resource_keys:['inbox'],action_keys:actions,
});
const metadataArtifact=await prepareDeftExperienceArtifact('experiences/indexed.json',{
  schema_version:'deft.experience_bundle.v2',search_resource_keys:['mail_index'],
  worker_source:readFileSync('metadata-worker.bundle.js','utf8'),entry_view:'main',resource_keys:['mail_index'],action_keys:[],
});
const string=maxLength=>({type:'string',maxLength});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const schemas={
  send_message:object({to:{...string(2048),minLength:1,format:'mailbox_list',maxItems:32,title:'To'},cc:{...string(2048),format:'mailbox_list',maxItems:32,title:'Cc'},subject:{...string(200),minLength:1,format:'single_line',title:'Subject'},body:string(4096),parent_record_id:{...string(36),minLength:0,format:'resource_record_list',maxItems:1,resourceKey:'inbox',readOnly:true,title:'Original message reference'}}),
  reply_message:object({to:{...string(2048),minLength:1,format:'mailbox_list',maxItems:32,title:'To'},cc:{...string(2048),format:'mailbox_list',maxItems:32,title:'Cc'},subject:{...string(200),minLength:1,format:'single_line',title:'Subject'},body:string(4096),parent_resource_id:{...string(36),minLength:1,format:'resource_record_list',maxItems:1,resourceKey:'inbox',readOnly:true,title:'Original message reference'}}),
  archive_message:object({resource_id:string(200)}),
};
const output=object({operation_id:string(120),transport_outcome:string(40),sent_copy_outcome:string(40)});
const record=object({
  subject:string(200),body:string(4096),body_truncated:{type:'boolean'},sender:string(200),recipients:string(200),
  message_id:string(200),in_reply_to:string(200),references:string(1000),resource_id:string(200),uidvalidity:string(80),
  mailbox:string(128),folder:string(16),date:string(40),seen:{type:'boolean'},answered:{type:'boolean'},flagged:{type:'boolean'},
  attachment_count:{type:'number',minimum:0,maximum:1000000},downloadable_attachment_count:{type:'number',minimum:0,maximum:1000000},
  skipped_attachment_count:{type:'number',minimum:0,maximum:1000000},attachment_metadata_complete:{type:'boolean'},
  body_status:string(24),body_2:string(4096),body_3:string(4096),body_4:string(4096),body_text_length:{type:'number',minimum:-1,maximum:8388608},
  full_body_attachment_key:string(256),full_body_status:string(24),
});
const experience=(key,label,item)=>({key,label,artifact_path:item.path,artifact_digest:item.digest,bridge_version:'deft.experience_bridge.v1',renderer_version:'deft.trusted_renderer.v1'});
const manifest={
  schema_version:'7',id:'io.deft.email',version:'1.6.0-stage1.1',name:'Email',license:'AGPL-3.0-only',compatibility:{app_protocol:'7'},modules:[],navigation:[],
  runtime_requirements:[{key:'sync_provider',protocol_version:'deft.app_runtime_channel.v3'},{key:'mail_provider',protocol_version:'deft.app_runtime_channel.v1'}],
  private_capabilities:actions.map(key=>({key,version:'1',input_schema:schemas[key],output_schema:output})),
  runtime_actions:actions.map(key=>({key,label:({send_message:'Send message',reply_message:'Reply',archive_message:'Archive'})[key],capability_key:key,runtime_requirement_key:'mail_provider'})),
  sync_descriptors:[{...EMAIL_METADATA_DESCRIPTOR,key:'inbox'}],
  resource_content:[{resource_key:'inbox',document:{max_characters:16384,metadata_schema:object(Object.fromEntries(Object.entries({account_id:200,primary_address:256,verified_sender_identities:8192,reply_from:2048,reply_to:2048,reply_to_list:2048,reply_cc:2048,subject:200,message_id:200,references:1000,conversation_id:96,conversation_coverage_state:16,conversation_indexed_count:5,conversation_exact_count:5,conversation_observed_at:24,conversation_drained:5,mailbox_reset_required:5}).map(([key,max])=>[key,{...string(max),format:'single_line'}])))}}],
  experiences:[experience('main','Inbox',artifact)],
  owner_connections:[{key:'personal_mailbox',resource_key:'inbox',action_keys:actions,max_consent_seconds:90*86400}],
  private_state:[
    {key:'drafts',label:'Private drafts',schema:object({mode:string(16),to:string(2048),cc:string(2048),subject:string(200),body:string(4096),reply_record_id:string(36)}),max_record_bytes:16384,max_records:32,max_total_bytes:131072,retention_days:30,
      files:{max_file_bytes:2097152,max_files_per_record:1,max_total_bytes_per_record:2097152,allowed_media_types:['application/pdf']},
      action_payloads:[{action_key:'send_message',max_payload_bytes:4194304}]},
    {key:'requests',label:'Private request history',schema:object({action_key:string(80),label:string(80),summary:string(400),source_record_id:string(36),draft_record_id:string(36),run_id:string(36),state:string(32),created_at:string(40)}),max_record_bytes:16384,max_records:10,max_total_bytes:131072,retention_days:30},
  ],native_actions:[],public_actions:[],
};
// The current host contract permits one Experience per package. Build a
// separately reviewed experimental variant instead of widening that contract
// or replacing the legacy source/draft/action grants implicitly.
const {private_state:_privateState,owner_connections:_ownerConnections,resource_content:_resourceContent,...indexedBase}=manifest;
const indexedManifest={...indexedBase,version:'1.5.7-indexed.1',
  runtime_requirements:[{key:'sync_provider',protocol_version:'deft.app_runtime_channel.v3'}],
  private_capabilities:[],runtime_actions:[],sync_descriptors:[EMAIL_METADATA_DESCRIPTOR],
  experiences:[experience('indexed','Mail index',metadataArtifact)],
};
const pkg=await buildDeftAppPackage({manifest,artifacts:[artifact]});
const indexedPackage=await buildDeftAppPackage({manifest:indexedManifest,artifacts:[metadataArtifact]});
writeFileSync('app.deft.json',pkg.json);
writeFileSync('app-indexed.deft.json',indexedPackage.json);
writeFileSync('artifact.json',JSON.stringify(artifact));
writeFileSync('metadata-artifact.json',JSON.stringify(metadataArtifact));
writeFileSync('build-result.json',JSON.stringify({
  packageDigest:pkg.digest,artifactDigest:artifact.digest,sourceInputs:Object.keys(legacyBuild.metafile.inputs),normalBundler:true,
  workerSha256:createHash('sha256').update(readFileSync('worker.bundle.js')).digest('hex'),
  indexedPackageDigest:indexedPackage.digest,indexedVersion:indexedManifest.version,
  indexedArtifactDigest:metadataArtifact.digest,indexedSourceInputs:Object.keys(metadataBuild.metafile.inputs),
  indexedWorkerSha256:createHash('sha256').update(readFileSync('metadata-worker.bundle.js')).digest('hex'),
},null,2));
console.log(JSON.stringify({passed:true,packageDigest:pkg.digest}));
