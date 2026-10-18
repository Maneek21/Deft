import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createEmailSentCopyJobHandler} from '../src/lib/email-sent-copy-job.js';
test('copy handler accepts only actual copy lease, defers bounded inspection and never treats unknown as resend',async()=>{
 const scope={org_id:'org',owner_user_id:'owner',account_id:'account'},id=randomUUID(),token=randomUUID(),data={...scope,outbox_id:randomUUID(),operation_id:randomUUID(),mime_digest:'a'.repeat(64),authority_revision:7};let enabled=true,outcome='unknown',calls=0;
 const handler=createEmailSentCopyJobHandler({enabled:()=>enabled,defer:(message,delay)=>Object.assign(Error(message),{delay}),dispatch:async(s,lease)=>{assert.deepEqual(s,scope);assert.equal(lease.job_id,id);assert.equal(lease.lock_token,token);assert.equal(lease.outbox_id,data.outbox_id);calls++;return {outcome};}});
 const job={id,name:'native-email-sent-copy',lockToken:token,data} as any;await handler(job);assert.equal(calls,1);outcome='pending';await assert.rejects(handler(job),(error:any)=>error.delay===5000);enabled=false;await assert.rejects(handler(job),(error:any)=>error.delay===60000);assert.equal(calls,2);
 await assert.rejects(handler({...job,name:'native-email-outbox'}),/DENIED/);await assert.rejects(handler({...job,lockToken:null}),/DENIED/);await assert.rejects(handler({...job,data:{...data,password:'not-accepted'}}));assert.equal(calls,2);
});
