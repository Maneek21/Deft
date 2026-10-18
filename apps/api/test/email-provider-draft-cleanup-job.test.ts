import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmailProviderDraftCleanupJobHandler} from '../src/lib/email-provider-draft-cleanup-job.js';
const data={org_id:'org',owner_user_id:'owner',account_id:'account',draft_id:'00000000-0000-4000-8000-000000000001',
 operation_id:'00000000-0000-4000-8000-000000000002',revision:3,authority_revision:2,generation:4,mode:'delete'};
const job={id:'job',name:'native-email-draft-cleanup',data,attempts:1,lockToken:'current-cleanup-job-token'};
test('cleanup recovery invokes inspect-only service and preserves exact accepted operation and lease',async()=>{
 const calls:unknown[][]=[];let deletes=0;
 const handler=createEmailProviderDraftCleanupJobHandler({enabled:()=>true,defer:()=>Error('defer'),run:async()=>{deletes++;},reconcile:async(...args)=>{calls.push(args);}});
 await handler({...job,data:{...data,mode:'reconcile'}});
 assert.equal(deletes,0);assert.equal(calls.length,1);
 assert.deepEqual(calls[0]?.slice(0,5),[{org_id:'org',owner_user_id:'owner',account_id:'account'},data.draft_id,3,data.operation_id,
  {job_id:job.id,lock_token:job.lockToken,job_name:job.name,draft_id:data.draft_id,revision:3,operation_id:data.operation_id,mode:'reconcile',generation:4}]);
});
test('disabled, unleased and forged cleanup jobs cannot delete and provider failures are redacted',async()=>{
 let calls=0;const ports={enabled:()=>false,defer:()=>Error('defer'),run:async()=>{calls++;throw Error('Private provider detail');},reconcile:async()=>{calls++;}};
 await assert.rejects(createEmailProviderDraftCleanupJobHandler(ports)(job),/defer/);
 ports.enabled=()=>true;const handler=createEmailProviderDraftCleanupJobHandler(ports);
 for(const bad of [{...job,lockToken:undefined},{...job,name:'native-email-sync'},
  {...job,data:{...data,operation_id:'bad'}},{...job,data:{...data,generation:0}},
  {...job,data:{...data,provider_draft_ref:'forged'}}])await assert.rejects(handler(bad));
 assert.equal(calls,0);await assert.rejects(handler(job),/^Error: EMAIL_DRAFT_CLEANUP_UNAVAILABLE$/);assert.equal(calls,1);
});
