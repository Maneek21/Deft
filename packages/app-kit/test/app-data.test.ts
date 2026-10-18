import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AppDataRequestSchema,AppDataRecordSchema,DeftExperienceRecordFormProfileSchema,APP_DATA_LIMITS,
 frameAppData,parseAppDataFrame,canonicalAppDataJson,RecordStoreDeclarationSchema,AppDataResultSchema} from '../src/app-data.js';
const id='11111111-1111-4111-8111-111111111111',digest=`sha256:${'a'.repeat(64)}`;

test('unsupported search preserves a bounded explanation without claiming refreshed results',()=>{
 const result={schema_version:'deft.app_data_result.v1',request_id:id,operation:'resource_list',input_digest:digest,
  outcome:'completed',items:[],next_cursor:null,search:{status:'unsupported',original_query:'custom:value',
   unsupported:[{index:0,field:'custom',reason:'This filter is not supported.'}],limitations:[],query_complete:false}};
 assert.equal(AppDataResultSchema.safeParse(result).success,true);
 for(const search of [{...result.search,query_complete:true},{...result.search,unsupported:[]},
  {...result.search,unsupported:[{index:0,field:'x',reason:'x'.repeat(257)}]},
  {...result.search,limitations:Array.from({length:32},()=>'語'.repeat(256))},
  {...result.search,unexpected:true}])assert.equal(AppDataResultSchema.safeParse({...result,search}).success,false);
 assert.equal(AppDataResultSchema.safeParse({...result,operation:'record_list'}).success,false);
 assert.equal(AppDataResultSchema.safeParse({...result,next_cursor:'next'}).success,false);
 assert.equal(AppDataResultSchema.safeParse({...result,freshness:{state:'fresh',observed_at:null,checkpoint_generation:1,coverage_generation:1,provider_observed:true}}).success,false);
 assert.equal(AppDataResultSchema.safeParse({...result,search:{status:'supported',original_query:'text',unsupported:[],limitations:['Provider result cap applies.'],query_complete:false}}).success,true);
 assert.equal(AppDataResultSchema.safeParse({...result,search:undefined}).success,true,'older results remain valid');
});
test('full native records stay outside the small Worker payload and enforce the record byte budget',()=>{
 const value={mode:'compose',to:'owner@example.test',cc:'',bcc:'',subject:'Full record',body:'x'.repeat(300000),body_html:'',reply_record_id:null,attachments:[]};
 const request={schema_version:'deft.app_data_request.v1',request_id:id,operation:'record_save',input:{store_key:'drafts',record_id:id,expected_revision:1,expected_content_digest:digest,value}};
 assert.equal(AppDataRequestSchema.safeParse(request).success,true);
 assert.equal(AppDataRequestSchema.safeParse({...request,input:{...request.input,value:{body:'x'.repeat(APP_DATA_LIMITS.record_bytes)}}}).success,false);
 assert.equal(AppDataRequestSchema.safeParse({...request,input:{...request.input,owner_user_id:id}}).success,false);
});
test('file catalog preserves upload revisions and rejects aggregate or duplicate file authority',()=>{
 const row={schema_version:'deft.app_record.v1',store_key:'drafts',record_id:id,revision:2,content_revision:1,content_digest:digest,status:'draft',value:{},created_at:'2026-10-09T00:00:00.000Z',updated_at:'2026-10-09T00:00:01.000Z'};
 const file={file_id:id,upload_revision:1,filename:'a'.repeat(255),media_type:'application/octet-stream',size_bytes:APP_DATA_LIMITS.file_bytes,sha256:digest};
 assert.equal(AppDataRecordSchema.safeParse({...row,files:[file]}).success,true);
 assert.equal(AppDataRecordSchema.safeParse({...row,files:[file,{...file,file_id:'22222222-2222-4222-8222-222222222222',size_bytes:1}]}).success,false);
 assert.equal(AppDataRecordSchema.safeParse({...row,files:[{...file,size_bytes:1},{...file,size_bytes:1}]}).success,false);
});
test('binary framing keeps metadata separate and rejects oversized or truncated headers',()=>{
 const header={schema_version:'fixture',filename:'untrusted.txt'},bytes=new Uint8Array([1,2,3]);
 const framed=frameAppData(header,bytes),parsed=parseAppDataFrame(framed);assert.deepEqual(parsed.header,header);assert.deepEqual(parsed.bytes,bytes);
 assert.throws(()=>parseAppDataFrame(framed.subarray(0,5)));assert.throws(()=>frameAppData({value:'x'.repeat(16384)},bytes));
 assert.equal(canonicalAppDataJson({input:{b:2,a:1},operation:'record_read'}),canonicalAppDataJson({operation:'record_read',input:{a:1,b:2}}));
 assert.throws(()=>canonicalAppDataJson(JSON.parse('{"__proto__":{}}')));
});
test('separately admitted form rejects aliasing html/plain or conflicting file budgets',()=>{
 const profile={schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],
  subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},
  files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}};
 assert.equal(DeftExperienceRecordFormProfileSchema.safeParse(profile).success,true);
 assert.equal(DeftExperienceRecordFormProfileSchema.safeParse({...profile,richtext:{...profile.richtext,plain_field:'body_html'}}).success,false);
 assert.equal(DeftExperienceRecordFormProfileSchema.safeParse({...profile,files:{...profile.files,max_total_bytes:1}}).success,false);
 assert.equal(RecordStoreDeclarationSchema.safeParse({schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'mailbox',runtime_requirement_key:'email',max_record_bytes:491520,max_files:32,max_file_bytes:26214400,max_total_file_bytes:26214400,resource_content:{max_presentation_bytes:262144,max_source_bytes:36700160,max_file_bytes:26214400,max_image_bytes:2097152}}).success,true);
});
