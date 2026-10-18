import test from 'node:test';
import assert from 'node:assert/strict';
import {workerTriageInput} from './triage-ui.mjs';
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
const mailFor=()=>({account_id:'exact-account'});
test('exact sorted nominations produce a stable immutable review summary',async()=>{
 const a=await workerTriageInput('archive',ids,mailFor),b=await workerTriageInput('archive',[...ids].reverse(),mailFor);
 assert.deepEqual(a,b);assert.equal(a.action_key,'triage_message');assert.ok(Object.isFrozen(a.input));
 assert.equal((await workerTriageInput('permanent_delete',ids,mailFor)).action_key,'permanent_delete_message');
});
test('selection refuses foreign accounts, duplicate and provider identities',async()=>{
 for(const selection of [[...ids,ids[0]],['native-provider-id'],[]])await assert.rejects(workerTriageInput('archive',selection,mailFor),/SELECTION_INVALID/);
 await assert.rejects(workerTriageInput('archive',ids,id=>({account_id:id})),/SELECTION_INVALID/);
});
test('move labels and fresh undo are closed nominations without caller authority',async()=>{
 assert.equal((await workerTriageInput('move',ids,mailFor,{destination:'folder-id'})).input.destination,'folder-id');
 assert.equal((await workerTriageInput('labels',ids,mailFor,{add_labels:['Label_1']})).input.add_labels,'Label_1');
 assert.equal((await workerTriageInput('undo',ids,mailFor,{undo_of:ids[0]})).input.destination,ids[0]);
 for(const [kind,options]of [['move',{}],['archive',{destination:'folder'}],['labels',{add_labels:['x'],remove_labels:['x']}],['undo',{undo_of:'caller-digest'}]])await assert.rejects(workerTriageInput(kind,ids,mailFor,options),/SELECTION_INVALID/);
});
