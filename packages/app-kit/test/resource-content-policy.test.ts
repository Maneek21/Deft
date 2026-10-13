import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceContentPolicySchema, ResourceContentDeclarationsSchema, buildDeftAppPackage, diffDeftAppRequestedAuthority,
  parseAttachmentAppManifest, verifyDeftAppPackageJson } from '../dist/index.js';

const scalar={type:'object' as const,additionalProperties:false as const,properties:{title:{type:'string' as const,maxLength:200,format:'single_line' as const}},required:['title']};
const document={max_characters:16384,metadata_schema:scalar};
const policy={resource_key:'documents',document};
const manifest={schema_version:'7' as const,compatibility:{app_protocol:'7' as const},id:'community.example.document',version:'1.0.0',name:'Documents',license:'AGPL-3.0-only' as const,
  modules:[],navigation:[],runtime_requirements:[{key:'source',protocol_version:'deft.app_runtime_channel.v3' as const}],private_capabilities:[],runtime_actions:[],native_actions:[],
  sync_descriptors:[{schema_version:'deft.app_sync_descriptor.v2' as const,key:'documents',runtime_requirement_key:'source',resource_type:'document',requested_visibility:'user_private' as const,
    record_schema:scalar,label_field:'title',attachments:{max_attachment_bytes:1024,max_attachments_per_record:1,max_attachments_per_run:1,max_attachment_bytes_per_run:1024,retention_days:1,allowed_media_types:['application/pdf'] as ['application/pdf']}}],experiences:[],public_actions:[]};

test('document disclosure defaults to plain and admits explicit reviewed HTML and original source',()=>{
  assert.deepEqual(ResourceContentPolicySchema.parse({document}),{document});
  assert.deepEqual(ResourceContentPolicySchema.parse({document:{max_characters:1}}),{document:{max_characters:1}});
  assert.ok(ResourceContentPolicySchema.safeParse({document:{...document,formats:['plain','html']},source:{media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608}}).success);
  for(const invalid of [{},{source:{media_type:'message/rfc822'}},{document:{max_characters:0}},{document:{max_characters:16385}},
    {document:{max_characters:1,format:'html'}},{document,account_id:'other'},{document,url:'https://other.test'},
    {document:{...document,metadata_schema:{...scalar,additionalProperties:true}}}]) assert.equal(ResourceContentPolicySchema.safeParse(invalid).success,false);
});
test('document declarations are sorted, unique and confined to declared user-private resources',()=>{
  assert.deepEqual(ResourceContentDeclarationsSchema.parse([policy]),[policy]);
  for(const rows of [[],[policy,policy],[{...policy,resource_key:'z'},policy]]) assert.equal(ResourceContentDeclarationsSchema.safeParse(rows).success,false);
  assert.ok(parseAttachmentAppManifest({...manifest,resource_content:[policy]}));
  assert.throws(()=>parseAttachmentAppManifest({...manifest,resource_content:[{...policy,resource_key:'foreign'}]}),/declared user-private resource/);
});
test('document and metadata review changes invalidate carry-forward authority and alter verified package digests',async()=>{
  const original=await buildDeftAppPackage({manifest,artifacts:[]}),declared={...manifest,resource_content:[policy]},built=await buildDeftAppPackage({manifest:declared,artifacts:[]});
  assert.notEqual(built.package.manifest_digest,original.package.manifest_digest);assert.deepEqual(await verifyDeftAppPackageJson(built.json),built);
  assert.equal(Object.hasOwn(original.package.manifest,'resource_content'),false);
  for(const proposed of [manifest,{...declared,resource_content:[{...policy,document:{max_characters:4096}}]},
    {...declared,resource_content:[{...policy,document:{...document,formats:['plain','html']}}]},
    {...declared,resource_content:[{...policy,source:{media_type:'message/rfc822',filename:'message.eml',max_bytes:8388608}}]},
    {...declared,resource_content:[{...policy,document:{...document,metadata_schema:{...scalar,properties:{title:{...scalar.properties.title,maxLength:201}}}}}]}]){
    const diff=await diffDeftAppRequestedAuthority({prior:declared,proposed});assert.deepEqual(diff.changed_atoms,['resource_content']);assert.equal(diff.carry_forward_eligible,false);
  }
});
