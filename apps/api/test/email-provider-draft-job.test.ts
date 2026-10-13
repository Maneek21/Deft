import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmailProviderDraftJobHandler} from '../src/lib/email-provider-draft-job.js';
const data={org_id:'org',owner_user_id:'owner',account_id:'account',draft_id:'00000000-0000-4000-8000-000000000001',revision:3,authority_revision:2};
const job={id:'job',name:'native-email-draft-sync',data,attempts:1,lockToken:'current-job-token'};
test('draft job passes only exact scoped revision and actual lease, with no human principal or automatic retry',async()=>{
 const calls:unknown[][]=[];const handler=createEmailProviderDraftJobHandler({enabled:()=>true,defer:()=>Error('defer'),run:async(...args)=>{calls.push(args);return {state:'unknown'};}});
 await handler(job);assert.equal(calls.length,1);assert.deepEqual(calls[0]?.slice(0,4),[{org_id:'org',owner_user_id:'owner',account_id:'account'},data.draft_id,3,
  {job_id:'job',lock_token:'current-job-token',job_name:'native-email-draft-sync',draft_id:data.draft_id,revision:3}]);
});
test('disabled, unleased and injected payloads cannot reach draft processing; failures are redacted',async()=>{
 let calls=0;const ports={enabled:()=>false,defer:()=>Error('defer'),run:async()=>{calls++;throw Error('Private credential detail');}};
 await assert.rejects(createEmailProviderDraftJobHandler(ports)(job),/defer/);assert.equal(calls,0);
 ports.enabled=()=>true;const handler=createEmailProviderDraftJobHandler(ports);
 for(const input of [{...job,lockToken:undefined},{...job,name:'native-email-sync'},{...job,data:{...data,bearer:'secret'}}])await assert.rejects(handler(input));
 assert.equal(calls,0);await assert.rejects(handler(job),/^Error: EMAIL_DRAFT_SYNC_UNAVAILABLE$/);assert.equal(calls,1);
});
test('reconciliation worker forwards exact mode and generation and refuses incomplete recovery payloads',async()=>{
 const calls:unknown[][]=[];const handler=createEmailProviderDraftJobHandler({enabled:()=>true,defer:()=>Error(),run:async(...args)=>{calls.push(args);}});
 await handler({...job,data:{...data,mode:'reconcile',generation:3}});
 assert.deepEqual(calls[0]?.[3],{job_id:'job',lock_token:'current-job-token',job_name:'native-email-draft-sync',draft_id:data.draft_id,revision:3,mode:'reconcile',generation:3});
 for(const extra of [{mode:'reconcile'},{generation:3},{mode:'sync',generation:3},{mode:'reconcile',generation:0}])await assert.rejects(handler({...job,data:{...data,...extra}}));
 assert.equal(calls.length,1);
});
