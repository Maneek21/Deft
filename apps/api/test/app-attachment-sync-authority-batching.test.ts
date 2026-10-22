import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {getTableName} from 'drizzle-orm';
import {parseAttachmentAppManifest,digestResourceSyncDescriptorV2} from '@deft/app-kit/core';
import {digestAppGrantValue} from '../src/lib/app-grant-service.js';
import {createAttachmentSyncDiscoverySnapshot} from '../src/lib/app-attachment-sync-discovery.js';
import {attachmentSyncConsentReview} from '../src/lib/app-attachment-sync-consent.js';
import {APP_RESOURCE_SYNC_HOST_POLICY} from '../src/lib/app-resource-sync-policy.js';

const org=randomUUID(),owner=randomUUID(),operator=randomUUID(),installationId=randomUUID(),versionId=randomUUID(),grantId=randomUUID();
const descriptor=parseAttachmentAppManifest(JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json',import.meta.url),'utf8'))).sync_descriptors[0]!;
const descriptorDigest=await digestResourceSyncDescriptorV2(descriptor),digest='sha256:'+'a'.repeat(64);
const reviewed={installation:{id:installationId,lifecycle_epoch:2,grant_epoch:3},version:{id:versionId,package_digest:digest},
 grant:{id:grantId,snapshot_digest:digest},descriptor,descriptor_digest:descriptorDigest,descriptors:[descriptor]};
const checkedAt=new Date(),expiry=new Date(Date.now()+60_000),registrationId=randomUUID(),bindingId=randomUUID(),providerId=randomUUID();
const registration={id:registrationId,org_id:org,app_installation_id:installationId,app_version_id:versionId,grant_snapshot_id:grantId,
 operator_user_id:operator,reviewed_by_user_id:owner,state:'active',runtime_epoch:1,contract_version:'deft.app_runtime_channel.v3',owner_connection_admission_id:null};
const binding={id:bindingId,org_id:org,runtime_registration_id:registrationId,registration_contract_version:registration.contract_version,
 app_installation_id:installationId,app_version_id:versionId,grant_snapshot_id:grantId,owner_user_id:owner,reviewed_by_user_id:owner,
 owner_scope:'private_user',resource_key:descriptor.key,resource_family:descriptor.resource_type,descriptor_digest:descriptorDigest,
 provider_kind:'app_runtime',provider_instance_id:registrationId,provider_snapshot_id:providerId,operation_name:'sync_'+descriptor.key,
 interface_identity:`deft.resource_sync.v3:${org}:${installationId}:${descriptor.key}`,target_key:'primary',state:'active',
 ...APP_RESOURCE_SYNC_HOST_POLICY,reviewed_at:new Date(Date.now()-60_000),consent_expires_at:expiry,consent_lifetime:null,
 reviewed_descriptor:descriptor,attachment_policy:descriptor.attachments,max_records_per_page:25,max_page_bytes:65536,max_retained_records:1000,
 max_retained_bytes:1048576,min_interval_seconds:300,attachment_consent_digest:''};
binding.attachment_consent_digest=digestAppGrantValue(attachmentSyncConsentReview({org_id:org,owner_user_id:owner,operator_user_id:operator,
 reviewed:reviewed as never,consent_expires_at:expiry,limits:binding,attachment_policy:binding.attachment_policy}));
const safeSnapshot=await createAttachmentSyncDiscoverySnapshot({org_id:org,registration_id:registrationId,descriptor,captured_at:checkedAt});
const provider={id:providerId,org_id:org,provider_kind:'app_runtime',provider_instance_id:registrationId,adapter_contract_version:registration.contract_version,
 safe_snapshot:safeSnapshot,snapshot_digest:safeSnapshot.snapshot_digest,captured_at:checkedAt};
let freshBinding=structuredClone(binding),freshRegistration=structuredClone(registration),memberActive=true,human=true,finalActive=true;
let beforeLockedRead:(table:string)=>void=()=>{},finalChecks=0;
const calls:{table:string;keys:string[];lock:string|undefined;ordered:boolean}[]=[];
mock.module(new URL('../src/lib/app-attachment-sync-reviewed.ts',import.meta.url).href,{namedExports:{loadReviewedAttachmentSyncDescriptor:async()=>reviewed}});
mock.module(new URL('../src/lib/app-owner-connection-authority.ts',import.meta.url).href,{namedExports:{assertOwnerConnectionRegistration:async()=>{throw Error('unexpected owner admission');}}});
mock.module(new URL('../src/lib/app-attachment-authority.ts',import.meta.url).href,{namedExports:{attachmentFinalAuthorityIsCurrent:async()=>{finalChecks++;return finalActive;}}});
const {loadLiveAttachmentSyncBindingAuthority}=await import('../src/lib/app-attachment-sync-authority.js');
function query(projection?:Record<string,unknown>){
 let table='',lock:string|undefined,ordered=false;
 const value:any={from:(actual:any)=>{table=getTableName(actual);return value;},innerJoin:()=>value,where:()=>value,limit:()=>value,
  orderBy:()=>{ordered=true;return value;},for:(mode:string)=>{lock=mode;return value;},then:(resolve:any,reject:any)=>Promise.resolve().then(()=>{
   const keys=Object.keys(projection??{});calls.push({table,keys,lock,ordered});if(lock)beforeLockedRead(table);
   if(table==='app_resource_bindings'&&keys.length)return [{owner_user_id:owner,registration_id:registrationId,installation_id:installationId,
    resource_key:descriptor.key,operator_user_id:operator,registration_installation_id:installationId}];
   if(table==='org_members')return keys.length===1?[{id:randomUUID()}]:[owner,operator].map(user_id=>({user_id,is_active:memberActive,role:'owner',kind:human?'human':'agent',is_agent:!human}));
   if(table==='app_runtime_registrations')return [structuredClone(freshRegistration)];
   if(table==='app_resource_bindings')return [structuredClone(freshBinding)];
   if(table==='capability_provider_snapshots')return [provider];
   if(table==='users')return [owner,operator].map(id=>({id,kind:human?'human':'agent',is_agent:!human}));
   throw Error('Unexpected table '+table);
  }).then(resolve,reject)};return value;
}
const tx={select:query,execute:async()=>({rows:[]})};
const read=(prelocked_participant_ids?:string[])=>loadLiveAttachmentSyncBindingAuthority(tx as never,{org_id:org,resource_binding_id:bindingId,
 clock:()=>new Date(),...(prelocked_participant_ids?{prelocked_participant_ids}:{})});
function reset(){provider.safe_snapshot=structuredClone(safeSnapshot);provider.snapshot_digest=safeSnapshot.snapshot_digest;freshBinding=structuredClone(binding);freshRegistration=structuredClone(registration);memberActive=true;human=true;finalActive=true;finalChecks=0;beforeLockedRead=()=>{};calls.length=0;reviewed.installation.grant_epoch=3;}

test('the public binding reader batches scoped locators and members while retaining sorted lock order and fresh final guard',async()=>{
 reset();assert.ok(await read());
 assert.equal(calls.filter(call=>call.table==='org_members').length,2);
 const locks=calls.filter(call=>call.lock);
 assert.deepEqual(locks.map(call=>[call.table,call.lock]),[['org_members','share'],['app_runtime_registrations','share'],['app_resource_bindings','share']]);
 assert.equal(locks[0]!.ordered,true);assert.equal(finalChecks,1);
 assert.equal(calls.filter(call=>call.table==='app_runtime_registrations').length,1);
 assert.equal(calls.filter(call=>call.table==='app_resource_bindings').length,2);
});

test('member removal and changed locked owner/version/grant/registration fail closed after locator capture',async()=>{
 for(const mutate of [()=>{memberActive=false;},()=>{human=false;},()=>{freshBinding.state='revoked';},
  ()=>{freshBinding.owner_user_id=randomUUID();},()=>{freshBinding.app_version_id=randomUUID();},()=>{freshBinding.grant_snapshot_id=randomUUID();},
  ()=>{freshRegistration.operator_user_id=randomUUID();},()=>{freshRegistration.state='revoked';},()=>{reviewed.installation.grant_epoch++;}]){
  reset();mutate();assert.equal(await read(),null);
 }
 reset();beforeLockedRead=table=>{if(table==='app_resource_bindings')freshBinding.state='revoked';};
 assert.equal(await read(),null,'a revoked binding returned after a lock wait is never admitted');
 reset();finalActive=false;assert.equal(await read(),null);assert.equal(finalChecks,1);
});

test('a composite reader cannot introduce participants after its prelocked set and final human checks remain fresh',async()=>{
 reset();assert.equal(await read([owner]),null);assert.equal(calls.filter(call=>call.table==='app_runtime_registrations').length,0);
 reset();assert.ok(await read([owner,operator]));assert.equal(calls.filter(call=>call.table==='org_members'&&call.lock).length,0);
 assert.equal(finalChecks,1);
});

test('issuance and management callers retain their stronger binding UPDATE lock',async()=>{
 reset();assert.ok(await loadLiveAttachmentSyncBindingAuthority(tx as never,{org_id:org,resource_binding_id:bindingId,clock:()=>new Date(),binding_lock:'update'}));
 assert.deepEqual(calls.filter(call=>call.lock).map(call=>[call.table,call.lock]),
  [['org_members','share'],['app_runtime_registrations','share'],['app_resource_bindings','update']]);
 freshBinding.state='revoked';
 assert.equal(await loadLiveAttachmentSyncBindingAuthority(tx as never,{org_id:org,resource_binding_id:bindingId,clock:()=>new Date(),binding_lock:'update'}),null,
  'a later management phase must reread revocation rather than reuse the earlier locked result');
});

test('fresh current discovery bytes and epoch pins cannot reuse a previously successful schema proof',async()=>{
 reset();assert.ok(await read());assert.ok(await read());
 provider.safe_snapshot={...safeSnapshot,adapter_contract_version:'changed'} as typeof safeSnapshot;
 assert.equal(await read(),null,'changed current bytes must fail even when their advertised digest is unchanged');
 reset();provider.snapshot_digest='sha256:'+'b'.repeat(64);assert.equal(await read(),null);
 reset();assert.ok(await read());freshRegistration.state='revoked';assert.equal(await read(),null);
 reset();assert.ok(await read());memberActive=false;assert.equal(await read(),null);
 reset();assert.ok(await read());reviewed.installation.grant_epoch++;assert.equal(await read(),null);
});
