import assert from 'node:assert/strict';import test from 'node:test';
import {createExperienceRecordWriter,type RecordSaveAttempt,type ExperienceRecordRow} from './app-experience-record-writer';
import {recoveryIdentity} from './app-experience-draft-recovery';
const id='00000000-0000-4000-8000-000000000004',hash='sha256:'+'a'.repeat(64);
test('recovered uncertain save checks original UUID without replay and keeps edits newer than captured request',async()=>{
 let stored:ExperienceRecordRow={record_id:id,revision:1,content_digest:hash,status:'draft',value:{body:'saved'}},evidence:RecordSaveAttempt|undefined,release:(()=>void)|undefined,writes=0,checked='';
 const first=createExperienceRecordWriter({initial:stored,current:()=>true,signal:new AbortController().signal,validate:()=>{},read:async()=>stored,change:()=>{},beforeSave:async attempt=>{evidence=attempt;},save:async(revision,value)=>{writes++;stored={...stored,revision:revision+1,content_digest:'sha256:'+'b'.repeat(64),value};await new Promise<void>(resolve=>release=resolve);throw Error('lost response');}});
 first.edit({body:'captured'});const pending=first.save();while(!release)await new Promise(resolve=>setTimeout(resolve,0));first.edit({body:'latest pending text'});release();assert.equal(await pending,false);const latest=first.snapshot.value;first.dispose();
 const resumed=createExperienceRecordWriter({initial:stored,current:()=>true,signal:new AbortController().signal,validate:()=>{},read:async()=>stored,change:()=>{},save:async()=>{writes++;throw Error('must not replay');},recoverSave:async(revision,value,requestId,digest)=>{checked=requestId;assert.equal(revision,1);assert.equal(digest,hash);assert.deepEqual(value,{body:'captured'});return stored;}});
 assert.equal(resumed.restoreRecovery(latest,evidence),true);assert.equal(resumed.snapshot.state,'blocked');assert.equal(await resumed.save(),false);assert.equal(await resumed.reconcileSave(),true);assert.equal(checked,evidence!.requestId);assert.equal(writes,1);assert.deepEqual(resumed.snapshot.value,{body:'latest pending text'});assert.equal(resumed.snapshot.dirty,true);assert.equal(resumed.snapshot.state,'unsaved');
});
test('legacy primary identity remains compatible and explicit target remains isolated',()=>{
 const scope={orgId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002',installationId:'00000000-0000-4000-8000-000000000003',stateKey:'drafts',recordId:id};
 const primary=recoveryIdentity(scope);assert.deepEqual(primary,recoveryIdentity({...scope,resourceTargetKey:'primary'}));assert.equal(primary.owner,JSON.stringify([scope.orgId,scope.userId,scope.installationId,'drafts']));assert.equal(primary.id,JSON.stringify([scope.orgId,scope.userId,scope.installationId,'drafts',id]));assert.notEqual(recoveryIdentity({...scope,resourceTargetKey:'mail'}).id,primary.id);
});
