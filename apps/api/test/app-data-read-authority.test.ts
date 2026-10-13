import test from 'node:test';
import assert from 'node:assert/strict';

test('reads, local saves and immutable resource plans select data authority; action lifecycle retains capture',async()=>{
 const {appDataConnectionActionSelection}=await import('../src/lib/app-data-read-authority.js');
 for(const operation of ['prepare_resource_action','read_prepared_resource_action','record_list','record_read','record_create','record_save','file_read','connection_metadata',
  'record_prepare_change','record_apply_change','resource_list','resource_refresh','resource_read_presentation','resource_list_files','resource_read_source','resource_read_file','resource_read_image'])
  assert.equal(appDataConnectionActionSelection(operation),'none',operation);
 for(const operation of [undefined,'','resource_new_operation','request_status','record_archive','file_upload','file_copy','file_detach',
  'prepare_action','read_prepared',
  'prepared_action_commit','prepared_action_restore','run_inspect','run_inspection_status'])
  assert.equal(appDataConnectionActionSelection(operation),undefined,String(operation));
});

test('local create/save cannot inject direct or recovered future lifecycle receipts through the host result schema',async()=>{
 const {AppDataResultSchema}=await import('@deft/app-kit');
 const id='55555555-5555-4555-8555-555555555555',other='66666666-6666-4666-8666-666666666666',digest='sha256:'+'a'.repeat(64);
 const receipt={schema_version:'deft.app_prepared_action_lifecycle_receipt.v1',request_id:id,release_id:id,run_id:id,original_request_id:id,
  snapshot_id:id,snapshot_digest:digest,phase:'commit',outcome:'completed',record:{record_id:id,revision:1,content_digest:digest,status:'submitted'}};
 const base={schema_version:'deft.app_data_result.v1',request_id:id,input_digest:digest,outcome:'completed'};
 assert.equal(AppDataResultSchema.safeParse({...base,operation:'prepared_action_commit',prepared_action_receipt:receipt}).success,true);
 const recovered={request_id:id,operation:'prepared_action_commit',input_digest:digest,state:'completed',prepared_action_receipt:receipt};
 assert.equal(AppDataResultSchema.safeParse({...base,operation:'request_status',request_status:recovered}).success,true);
 for(const operation of ['record_create','record_save','record_read','record_list','connection_metadata']){
  assert.equal(AppDataResultSchema.safeParse({...base,operation,prepared_action_receipt:receipt}).success,false,operation+' direct receipt');
  assert.equal(AppDataResultSchema.safeParse({...base,operation,request_status:recovered}).success,false,operation+' recovered receipt');
 }
 for(const altered of [{...receipt,request_id:other},{...receipt,phase:'restore'},{...receipt,unknown:true}])
  assert.equal(AppDataResultSchema.safeParse({...base,operation:'prepared_action_commit',prepared_action_receipt:altered}).success,false);
 assert.equal(AppDataResultSchema.safeParse({...base,operation:'request_status',request_status:{...recovered,request_id:other}}).success,false);
});

test('public invoke carries the exact operation into its current authority check before any dispatch',async()=>{
 // Match the production import graph's cycle initialization, with no server start.
 await import('../src/lib/app-runtime-authority.js');
 const {AppDataService}=await import('../src/lib/app-data-service.js');
 const seen:unknown[][]=[];
 class Probe extends AppDataService {
  override async current(...args:Parameters<AppDataService['current']>):ReturnType<AppDataService['current']>{seen.push(args);throw Error('READ_AUTHORITY_PROBE');}
 }
 const service=new Probe({org_id:'11111111-1111-4111-8111-111111111111',user_id:'22222222-2222-4222-8222-222222222222',sid:'33333333-3333-4333-8333-333333333333',access_expires_at:Date.now()+60000},async()=>{});
 const session='44444444-4444-4444-8444-444444444444';
 const request={schema_version:'deft.app_data_request.v1',request_id:'55555555-5555-4555-8555-555555555555',operation:'record_list',input:{store_key:'preferences',cursor:null,limit:25}};
 await assert.rejects(service.invoke(session,request),/READ_AUTHORITY_PROBE/);
 assert.deepEqual(seen,[[session,'preferences',true,'record_list']]);
});
