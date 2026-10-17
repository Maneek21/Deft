import test from 'node:test';import assert from 'node:assert/strict';import {readTriageReceipt} from './triage-receipt-ui.mjs';
test('receipt output must match retained run identity and actual per-item counts before offering undo',()=>{
 const id='00000000-0000-4000-8000-000000000001',record='00000000-0000-4000-8000-000000000002';
 const run={id,state:'succeeded',output:{operation_id:id,succeeded_count:1,failed_count:0,unknown_count:0,undo_available:true,automatic_retry:false,items:record+': succeeded'}};
 assert.equal(readTriageReceipt(run).undoAvailable,true);
 assert.equal(readTriageReceipt({...run,state:'unknown_outcome'}),null);
 assert.equal(readTriageReceipt({...run,output:{...run.output,succeeded_count:2}}),null);
 assert.equal(readTriageReceipt({...run,output:{...run.output,items:run.output.items+'\n'+run.output.items}}),null);
 assert.equal(readTriageReceipt({...run,output:{...run.output,operation_id:record}}),null);
});


test('per-item receipt preserves exact states/codes while unknown withholds undo',()=>{
 const id='00000000-0000-4000-8000-000000000001',a='00000000-0000-4000-8000-000000000002',b='00000000-0000-4000-8000-000000000003';
 const run={id,state:'failed',output:{operation_id:id,succeeded_count:1,failed_count:0,unknown_count:1,undo_available:true,automatic_retry:false,items:a+': succeeded\n'+b+': prepared (EMAIL_TRIAGE_OUTCOME_UNKNOWN)'}};
 const receipt=readTriageReceipt(run);assert.equal(receipt.undoAvailable,false);assert.deepEqual(receipt.items,[{recordId:a,state:'succeeded',code:''},{recordId:b,state:'unknown',code:'EMAIL_TRIAGE_OUTCOME_UNKNOWN'}]);
});
