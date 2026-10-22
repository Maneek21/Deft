import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import * as core from '@deft/app-kit/core';
import * as crypto from 'node:crypto';
const canonical=mock.fn(core.canonicalAppConnectionProfileJson);
mock.module('@deft/app-kit/core',{namedExports:{...core,canonicalAppConnectionProfileJson:canonical}});
const {connectionProfileDigest}=await import('../src/lib/app-connection-session-registry.js');
const fixture=()=>({schema_version:'deft.app_connection_profile.v1' as const,key:'provider',provider_id:'provider',operator_user_id:crypto.randomUUID(),runtime_requirement_key:'sync',resource_key:'messages',action_keys:['send_message'],authorization_origin:'https://provider.example.test',credential_custody:'runtime' as const,executable:false as const});
const expected=(value:unknown)=>'sha256:'+crypto.createHash('sha256').update(core.canonicalAppConnectionProfileJson(value)).digest('hex');
test('profile digest reuses only complete validated content and tracks changed fields',()=>{
 const profile=fixture(),before=canonical.mock.callCount();
 assert.equal(connectionProfileDigest(profile),expected(profile));assert.equal(connectionProfileDigest(structuredClone(profile)),expected(profile));
 assert.equal(canonical.mock.callCount()-before,1,'one pure parse/hash for identical complete profile bytes');
 for(const changed of [{...profile,provider_id:'changed'},{...profile,operator_user_id:crypto.randomUUID()},{...profile,authorization_origin:'https://changed.example.test'},{...profile,action_keys:['mirror_message','send_message']},{...profile,resource_key:'changed'}])assert.equal(connectionProfileDigest(changed),expected(changed));
 assert.equal(canonical.mock.callCount()-before,6);profile.action_keys.push('mirror_message');profile.action_keys.sort();assert.equal(connectionProfileDigest(profile),expected(profile));
});
test('invalid or unsafe profiles never bypass their ordinary validation',()=>{
 const profile=fixture();for(const invalid of [{...profile,executable:true},{...profile,unknown:true},{...profile,authorization_origin:'http://unsafe.example.test'},{...profile,action_keys:new Array(1)}]){
  const before=canonical.mock.callCount();assert.throws(()=>connectionProfileDigest(invalid as never));assert.throws(()=>connectionProfileDigest(invalid as never));assert.equal(canonical.mock.callCount()-before,2);
 }
 let reads=0;const accessor={...profile,get provider_id(){reads++;return 'provider';}};
 const before=canonical.mock.callCount();connectionProfileDigest(accessor);connectionProfileDigest(accessor);assert.equal(canonical.mock.callCount()-before,2);assert.equal(reads,2);
 for(let i=0;i<65;i++)connectionProfileDigest(fixture());const at=canonical.mock.callCount();connectionProfileDigest(profile);assert.equal(canonical.mock.callCount(),at+1,'bounded cache evicts oldest input');
});
