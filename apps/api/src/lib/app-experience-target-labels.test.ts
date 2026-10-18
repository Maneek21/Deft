import test from 'node:test';
import assert from 'node:assert/strict';
import {experienceTargetAccountLabels} from './app-experience-target-labels.js';
const now=Date.parse('2026-10-13T00:00:00Z'),pins={org_id:'org',owner_user_id:'owner',installation_id:'app',app_version_id:'version',grant_snapshot_id:'grant',lifecycle_epoch:2,grant_epoch:3};
const targets=[{key:'sender',label:'sender'},{key:'recipient',label:'recipient'}],bindings=[{id:'binding-sender',key:'inbox',target:'sender'},{id:'binding-recipient',key:'inbox',target:'recipient'}];
const record=(target='sender',label='sender@example.test')=>({state:'connected',runtime_session_ref:'runtime',scope:{...pins,target_key:target,resource_key:'inbox',resource_binding_id:'binding-'+target,consent_expires_at:'2026-10-14T00:00:00Z'},account:{account_ref:'account-'+target,label}});
test('connected current owner account labels replace target labels without changing admission or keys',()=>{
  const result=experienceTargetAccountLabels(targets,[record(),record('recipient','recipient@example.test')],bindings,pins,now);
  assert.deepEqual(result,[{key:'sender',label:'sender@example.test'},{key:'recipient',label:'recipient@example.test'}]);
  assert.deepEqual(targets,[{key:'sender',label:'sender'},{key:'recipient',label:'recipient'}]);
});
test('foreign owner, stale scope, unbound resource, expired and disconnected records disclose no label',()=>{
  for(const change of [{org_id:'foreign'},{owner_user_id:'foreign'},{installation_id:'foreign'},{app_version_id:'old'},{grant_snapshot_id:'old'},{lifecycle_epoch:1},{grant_epoch:2},{resource_binding_id:'other'},{resource_key:'other'},{target_key:'other'},{consent_expires_at:'2026-10-12T00:00:00Z'}]){
    const row=record();Object.assign(row.scope,change);assert.deepEqual(experienceTargetAccountLabels(targets,[row],bindings,pins,now),targets);
  }
  for(const change of [{state:'disconnected'},{runtime_session_ref:''},{account:{account_ref:'foreign',label:'unsafe\nlabel'}}])assert.deepEqual(experienceTargetAccountLabels(targets,[{...record(),...change}],bindings,pins,now),targets);
});
test('ambiguous accounts retain the generic target label and unknown targets are never added',()=>{
  assert.deepEqual(experienceTargetAccountLabels(targets,[record(),record('sender','other@example.test'),record('foreign')],bindings,pins,now),targets);
});
