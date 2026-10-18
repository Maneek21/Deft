import assert from 'node:assert/strict';
import test from 'node:test';
import {DeftExperienceReferenceSchema,prepareDeftExperienceArtifact,verifyDeftExperienceArtifact} from '../src/experience.js';
import {InstalledExperienceSchema} from '../src/installed-authoring.js';
import {DeftExperienceCapabilitySchema,DeftImplementedExperienceCapabilitySchema,negotiateDeftExperienceCapabilities} from '../src/experience-capabilities.js';

test('every implemented capability can be installed and negotiated together, including seed and mirror',async()=>{
 const capabilities=[...DeftImplementedExperienceCapabilitySchema.options];
 assert.ok(capabilities.length>12);
 assert.ok(capabilities.includes('record_form_seed.v1')&&capabilities.includes('record_mirror.v1'));
 const bundle={schema_version:'deft.experience_bundle.v1',worker_source:'self.onmessage=()=>{};',entry_view:'main',resource_keys:[],action_keys:[]};
 const artifact=await prepareDeftExperienceArtifact('experiences/main.json',bundle);
 const reference={artifact_path:artifact.path,artifact_digest:artifact.digest,bridge_version:'deft.experience_bridge.v1',renderer_version:'deft.trusted_renderer.v2',capabilities};
 assert.deepEqual(await verifyDeftExperienceArtifact(reference,artifact),bundle);
 assert.ok(InstalledExperienceSchema.safeParse({...reference,key:'main',label:'Workspace'}).success);
 const versions={schema_version:'deft.experience_capabilities.v1',view_version:'deft.experience_view.v2'};
 assert.deepEqual(negotiateDeftExperienceCapabilities({...versions,required:capabilities,optional:[]},{...versions,capabilities:[...DeftExperienceCapabilitySchema.options]}).capabilities,capabilities);
 for(const denied of [[...capabilities,capabilities[0]],['unknown.v1'],['resource_refresh.v1']]){
  assert.equal(DeftExperienceReferenceSchema.safeParse({...reference,capabilities:denied}).success,false);
 }
 assert.equal(DeftExperienceReferenceSchema.safeParse({...reference,renderer_version:'deft.trusted_renderer.v1'}).success,false);
 for(const denied of [[...capabilities,capabilities[0]],['unknown.v1']]){
  assert.throws(()=>negotiateDeftExperienceCapabilities({...versions,required:denied,optional:[]},{...versions,capabilities}));
 }
});
