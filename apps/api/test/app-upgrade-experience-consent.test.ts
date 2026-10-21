import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {ExperienceConsentScopeSchema} from '../src/lib/app-experience-consent-contract.js';
import {sameUpgradeExperiencePermission} from '../src/lib/app-upgrade-experience-consent.js';
import type {UpgradeContinuityProof} from '../src/lib/app-upgrade-trust-continuity.js';

const hash=(c:string)=>'sha256:'+c.repeat(64);
function fixture(){
 const source={id:randomUUID(),runtime_registration_id:randomUUID(),descriptor_digest:hash('a')};
 const target={id:randomUUID(),runtime_registration_id:randomUUID(),descriptor_digest:hash('b'),runtime_epoch:1};
 const before=ExperienceConsentScopeSchema.parse({schema_version:'deft.experience_consent.v1',exposure_schema_version:'deft.experience_resource_exposure.v1',
  payload_policy_version:'deft.experience_resource_payload.v1',visibility:'user_private',destination:'verified_installed_experience_worker',
  org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),app_name:'Synthetic App',app_version:'1.0.0',
  package_digest:hash('c'),manifest_digest:hash('d'),grant_snapshot_id:randomUUID(),grant_snapshot_digest:hash('e'),lifecycle_epoch:1,grant_epoch:1,
  experience_key:'main',experience_label:'Private workspace',artifact_digest:hash('f'),bridge_version:'deft.experience_bridge.v1',renderer_version:'deft.trusted_renderer.v1',
  resources:[{resource_key:'records',binding_id:source.id,registration_id:source.runtime_registration_id,runtime_epoch:1,descriptor_digest:source.descriptor_digest,
   resource_type:'synthetic.records',label:'Private records',allowed_operations:['list_summary','read_one'],allowed_fields:['title'],consent_expires_at:null,consent_lifetime:'until_revoked'}],
  limits:{items:10,fields:32,string_chars:4096,envelope_bytes:61440}});
 const after=ExperienceConsentScopeSchema.parse({...before,app_version_id:randomUUID(),app_name:'Updated label',app_version:'1.0.1',package_digest:hash('1'),
  manifest_digest:hash('2'),grant_snapshot_id:randomUUID(),grant_snapshot_digest:hash('3'),lifecycle_epoch:2,grant_epoch:2,artifact_digest:hash('4'),
  resources:[{...before.resources[0],binding_id:target.id,registration_id:target.runtime_registration_id,descriptor_digest:target.descriptor_digest}]});
 const proof={org_id:before.org_id,owner_id:before.owner_user_id,installation_id:before.installation_id,prior_version_id:before.app_version_id,
  version_id:after.app_version_id,grant_id:after.grant_snapshot_id,lifecycle_epoch:2,grant_epoch:2,
  source_scope:{grant_snapshot_id:before.grant_snapshot_id,lifecycle_epoch:1,grant_epoch:1,runtime_epoch:1}} as UpgradeContinuityProof;
 return {before,after,proof,source,target};
}
test('a validated completed upgrade may replace release and proven resource identities only',()=>{
 const f=fixture();assert.equal(sameUpgradeExperiencePermission(f.before,f.after,f.proof,f.source,f.target),true);
});
for(const [name,mutate] of Object.entries({
 owner:(v:any)=>v.owner_user_id=randomUUID(),installation:(v:any)=>v.installation_id=randomUUID(),experience:(v:any)=>v.experience_key='other',
 destination:(v:any)=>v.destination='different_worker',renderer:(v:any)=>v.renderer_version='future_renderer',
 operations:(v:any)=>v.resources[0].allowed_operations.push('search'),fields:(v:any)=>v.resources[0].allowed_fields.push('body'),
 deadline:(v:any)=>{delete v.resources[0].consent_lifetime;v.resources[0].consent_expires_at='2099-01-01T00:00:00.000Z';},
 resource:(v:any)=>v.resources[0].binding_id=randomUUID(),registration:(v:any)=>v.resources[0].registration_id=randomUUID(),epoch:(v:any)=>v.resources[0].runtime_epoch=2,
 stores:(v:any)=>v.record_stores=[{key:'extra_destination'}],limits:(v:any)=>v.limits.items=100,unknown:(v:any)=>v.future_authority=true,
}))test('a trusted upgrade cannot silently change private '+name,()=>{
 const f=fixture(),after=structuredClone(f.after);mutate(after);
 assert.equal(sameUpgradeExperiencePermission(f.before,after,f.proof,f.source,f.target),false);
});
test('wrong source identity and locator pins fail closed; finite deadlines stay exact',()=>{
 const f=fixture();assert.equal(sameUpgradeExperiencePermission({...f.before,grant_snapshot_id:randomUUID()},f.after,f.proof,f.source,f.target),false);
 assert.equal(sameUpgradeExperiencePermission(f.before,f.after,f.proof,{...f.source,descriptor_digest:hash('9')},f.target),false);
 for(const scope of [f.before,f.after]){delete scope.resources[0]!.consent_lifetime;scope.resources[0]!.consent_expires_at='2099-01-01T00:00:00.000Z';}
 assert.equal(sameUpgradeExperiencePermission(f.before,f.after,f.proof,f.source,f.target),true);
 f.after.resources[0]!.consent_expires_at='2100-01-01T00:00:00.000Z';
 assert.equal(sameUpgradeExperiencePermission(f.before,f.after,f.proof,f.source,f.target),false);
});
