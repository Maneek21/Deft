import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import { appOwnerConnectionAdmissions, capabilityProviderSnapshots } from '@deft/db/schema';
import { randomUUID, createHash } from 'node:crypto';
import { parseAttachmentAppManifest, digestResourceSyncDescriptorV2, canonicalAppConnectionProfileJson } from '@deft/app-kit/core';
import { digestAppGrantValue } from '../src/lib/app-grant-service.js';

let registryReads = 0, profileChanged = false, transportChanged = false;
let afterRegistry = () => {};
const phases: string[] = [];
const org_id = randomUUID(), installation_id = randomUUID(), operator_user_id = randomUUID();
const policy = { key: 'personal_mailbox', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400,
  provider_profile_key: 'example_provider', runtime_requirement_key: 'sync_provider' };
const profile = { schema_version: 'deft.app_connection_profile.v1' as const, key: 'example_provider', provider_id: 'example_provider',
  operator_user_id, runtime_requirement_key: 'sync_provider', resource_key: 'inbox', action_keys: ['send_message'],
  authorization_origin: 'https://provider.example.test', credential_custody: 'runtime' as const, executable: false as const };
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const registry = { profile: () => profileChanged ? { ...profile, provider_id: 'changed' } : profile,
  transportDigest: () => digest(transportChanged ? 'd' : 'c') };
const connectionProfileDigest = (value: any) => `sha256:${createHash('sha256').update(canonicalAppConnectionProfileJson(value)).digest('hex')}`;
const actions = [{ action_key: 'send_message', contract_digest: digest('e') }];
mock.module(new URL('../src/lib/env.ts', import.meta.url).href, { namedExports: { isAppOwnerConnectionsEnabled: () => true } });
mock.module(new URL('../src/lib/app-attachment-authority.ts', import.meta.url).href, { namedExports: {
  loadReviewedAttachmentApp: async () => { throw new Error('the already locked review must be used'); },
} });
mock.module(new URL('../src/lib/app-runtime-review.ts', import.meta.url).href, { namedExports: { runtimeActionDescriptors: () => actions } });
mock.module(new URL('../src/lib/app-connection-session-registry.ts', import.meta.url).href, { namedExports: {
  connectionProfileDigest, getAppConnectionSessionRegistry: async () => { registryReads++; phases.push('registry'); await Promise.resolve(); afterRegistry(); return registry; },
} });
const { assertOwnerConnectionRegistration, loadOwnerConnectionAdmission } = await import('../src/lib/app-owner-connection-authority.js');

const manifest = JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json', import.meta.url), 'utf8'));
manifest.owner_connections = [policy];
const parsed = parseAttachmentAppManifest(manifest);
const installation = { id: installation_id, org_id, state: 'active', active_version_id: randomUUID(), active_grant_snapshot_id: randomUUID(), lifecycle_epoch: 1, grant_epoch: 2 };
const version = { id: installation.active_version_id, org_id, installation_id, state: 'active', protocol_version: '7', manifest, package_digest: digest('a') };
const grant = { id: installation.active_grant_snapshot_id, org_id, app_installation_id: installation_id, app_version_id: version.id, snapshot_kind: 'effective', snapshot_digest: digest('b') };
const snapshot = { schema_version: 'deft.owner_connection_admission.v1', org_id, installation_id, app_version_id: version.id,
  grant_snapshot_id: grant.id, package_digest: version.package_digest, grant_snapshot_digest: grant.snapshot_digest,
  lifecycle_epoch: 1, grant_epoch: 2, operator_user_id, policy, policy_digest: digestAppGrantValue(policy),
  resource_descriptor_digest: await digestResourceSyncDescriptorV2(parsed.sync_descriptors[0]!),
  actions,
  limits: { max_records_per_page: 50, max_page_bytes: 100000, max_retained_records: 1000, max_retained_bytes: 1000000, min_interval_seconds: 300 },
  connection_profile: profile, connection_profile_digest: connectionProfileDigest(profile), connection_transport_digest: digest('c') };
const row = { id: randomUUID(), org_id, app_installation_id: installation_id, app_version_id: version.id,
  grant_snapshot_id: grant.id, review_digest: digestAppGrantValue(snapshot), policy_key: policy.key, operator_user_id, state: 'active', revoked_at: null, snapshot };

const owner_user_id=randomUUID(),providerId=randomUUID(),bindingId=randomUUID(),registrationId=randomUUID();
const registration={id:registrationId,org_id,app_installation_id:installation_id,app_version_id:version.id,grant_snapshot_id:grant.id,
 state:'active',owner_connection_admission_id:row.id,owner_connection_admission_digest:row.review_digest,
 reviewed_by_user_id:owner_user_id,operator_user_id};
const binding={id:bindingId,org_id,owner_user_id,runtime_registration_id:registrationId,state:'active',
 app_installation_id:installation_id,app_version_id:version.id,grant_snapshot_id:grant.id,provider_snapshot_id:providerId,resource_key:'inbox'};
const provider={id:providerId,org_id,provider_kind:'app_runtime',provider_instance_id:registrationId,adapter_contract_version:'deft.app_runtime_channel.v3',
 safe_snapshot:{exact:'current bytes'},snapshot_digest:digest('f'),captured_at:new Date('2026-10-22T12:00:00Z')};
let pending=false,providerPresent=true,ownerPresent=true,operatorPresent=true,memberActive=true,human=true,duplicate=false;
let factOrg=org_id,factProviderId=providerId;
const statements:{text:string;params:unknown[]}[]=[];
const raw=(table:any,value:any)=>Object.keys(getTableColumns(table)).map(key=>value[key]??null);
const member=(id:string,present:boolean)=>present?[id,memberActive,'member',human?'human':'agent',!human]:[null,null,null,null,null];
const database=drizzle({client:{query:async(config:{text:string},params:unknown[])=>{
 const text=config.text;statements.push({text,params});
 if(text.includes('connection_fact_owner_member')){
  phases.push('facts');const value=[...raw(capabilityProviderSnapshots,providerPresent?{...provider,org_id:factOrg,id:factProviderId}:{}),
   ...member(owner_user_id,ownerPresent),...member(operator_user_id,operatorPresent),pending];
  return {rows:duplicate?[value,value]:[value]};
 }
 if(text.includes('from "app_owner_connection_admissions"')){phases.push('admission');return {rows:[raw(appOwnerConnectionAdmissions,row)]};}
 if(text.includes('from "org_members"')){phases.push('members');return {rows:[member(owner_user_id,ownerPresent),member(operator_user_id,operatorPresent)]};}
 throw Error('Unexpected query '+text);
}} as never});
const reviewed={installation,version,grant,manifest:parsed};
let published:any;
const read=(batch=true)=>assertOwnerConnectionRegistration(database as never,registration as never,{owner_user_id,resource_key:'inbox',lockedReviewed:reviewed as never,
 ...(batch?{currentBindingRead:{binding:binding as never,onFacts:(facts:any)=>{published=facts;}}}:{})});
function reset(){pending=false;providerPresent=true;ownerPresent=true;operatorPresent=true;memberActive=true;human=true;duplicate=false;
 factOrg=org_id;factProviderId=providerId;profileChanged=false;transportChanged=false;row.revoked_at=null;installation.grant_epoch=2;
 afterRegistry=()=>{};statements.length=0;phases.length=0;published=undefined;}

test('operational owner checks batch current absence, both scoped humans and typed provider facts after the locked admission and registry wait',async()=>{
 reset();await read();assert.deepEqual(phases,['admission','registry','facts']);assert.equal(statements.length,2);
 assert.ok(statements[0]!.text.endsWith('for share'));
 const batch=statements[1]!;assert.equal((batch.text.match(/left join/g)??[]).length,5);
 for(const fragment of ['exists (select','"app_connection_consent_continuations"',"->'activation_started'='true'::jsonb", "->>'state'<>'connected'",'"review_digest"','"connection_fact_owner_member"."org_id"','"connection_fact_operator_member"."org_id"'])assert.ok(batch.text.includes(fragment),fragment);
 assert.ok(batch.params.filter(value=>value===org_id).length>=5);assert.ok(batch.params.includes(owner_user_id));assert.ok(batch.params.includes(operator_user_id));
 assert.ok(batch.params.includes(bindingId));assert.ok(batch.params.includes(providerId));assert.ok(batch.params.includes(row.review_digest));
 assert.equal(published.provider_snapshot.id,providerId);assert.equal(published.provider_snapshot.captured_at.getTime(),provider.captured_at.getTime());
 assert.equal(published.owner_user_id,owner_user_id);assert.equal(published.runtime_registration_id,registrationId);
 await read();assert.equal(statements.length,4,'a later boundary reads the entire mutable fact batch again');
});

test('pending insertion and participant/provider changes during a registry wait fail closed without publishing facts',async()=>{
 for(const mutate of [()=>{pending=true;},()=>{ownerPresent=false;},()=>{operatorPresent=false;},()=>{memberActive=false;},()=>{human=false;},
  ()=>{providerPresent=false;},()=>{factOrg=randomUUID();},()=>{factProviderId=randomUUID();},()=>{duplicate=true;}]){
  reset();afterRegistry=mutate;await assert.rejects(read());assert.equal(published,undefined);assert.equal(phases.at(-1),'facts');
 }
});

test('the private batch cannot cross binding owner/version/grant/registration scope and cannot bypass current revocation or epochs',async()=>{
 for(const key of ['org_id','owner_user_id','runtime_registration_id','app_installation_id','app_version_id','grant_snapshot_id','resource_key'] as const){
  reset();const before=binding[key];binding[key]=randomUUID();await assert.rejects(read());assert.equal(published,undefined);binding[key]=before;
 }
 for(const mutate of [()=>{row.revoked_at=new Date() as never;},()=>{installation.grant_epoch++;},()=>{transportChanged=true;},()=>{registration.reviewed_by_user_id=randomUUID();}]){
  reset();const before=registration.reviewed_by_user_id;mutate();await assert.rejects(read());assert.equal(published,undefined);registration.reviewed_by_user_id=before;
 }
});

test('standalone and issuance callers keep their existing fresh member query and do not load pending/provider facts',async()=>{
 reset();await read(false);assert.deepEqual(phases,['admission','registry','members']);assert.equal(published,undefined);
 assert.equal(statements.some(item=>item.text.includes('connection_fact_owner_member')),false);
});


test('even the internal direct admission seam validates owner, organization and version/grant/resource pins before publishing facts',async()=>{
 for(const key of ['org_id','owner_user_id','app_installation_id','app_version_id','grant_snapshot_id','resource_key'] as const){
  reset();let disclosed=false;
  await assert.rejects(loadOwnerConnectionAdmission(database as never,org_id,{admission_id:row.id,admission_digest:row.review_digest},reviewed as never,owner_user_id,undefined,
   {binding:{...binding,[key]:randomUUID()} as never,onFacts:()=>{disclosed=true;}}));
  assert.equal(disclosed,false);assert.equal(phases.includes('facts'),false,'invalid private nominations cannot load or publish current facts');
 }
});
