import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalAppConnectionProfileJson} from '@deft/app-kit/core';

const org=randomUUID(),owner=randomUUID(),installationId=randomUUID(),versionId=randomUUID(),grantId=randomUUID(),bindingId=randomUUID();
const digest=(letter:string)=>'sha256:'+letter.repeat(64),deadline=new Date(Date.now()+60_000);
const policy={key:'mailbox',resource_key:'inbox',action_keys:[],max_consent_seconds:86400,
 provider_profile_key:'provider',runtime_requirement_key:'sync_provider'};
const profile={schema_version:'deft.app_connection_profile.v1',key:'provider',provider_id:'provider',operator_user_id:owner,
 runtime_requirement_key:'sync_provider',resource_key:'inbox',action_keys:[],authorization_origin:'https://provider.example.test',credential_custody:'runtime',executable:false};
const profileDigest=(value:any)=>'sha256:'+createHash('sha256').update(canonicalAppConnectionProfileJson(value)).digest('hex');
const manifest=JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json',import.meta.url),'utf8'));manifest.owner_connections=[policy];
const current={installation:{id:installationId,lifecycle_epoch:2,grant_epoch:3},version:{id:versionId,manifest,package_digest:digest('a')},
 grant:{id:grantId,snapshot_digest:digest('b'),canonical_snapshot:{record_stores:[]}},
 binding:{id:bindingId,owner_user_id:owner,target_key:'primary',resource_key:'inbox',consent_expires_at:deadline,consent_lifetime:null},
 registration:{id:randomUUID(),owner_connection_admission_id:randomUUID(),operator_user_id:owner,runtime_epoch:4},descriptor:{runtime_requirement_key:'sync_provider'},
 owner_connection_admission:{policy,snapshot:{connection_profile_digest:profileDigest(profile),connection_transport_digest:digest('c'),connection_profile:profile}}};
let active=true,transport=true,reads=0,guards=0;
const batchOptions: unknown[]=[];
const registry={profile:()=>profile,transportDigest:()=>digest(transport?'c':'d'),reviewedProtocol:()=> 'v2',protocol:()=> 'v2',assertReady:()=>{}};
const tx={select:()=>({from:()=>({where:()=>({limit:async()=>[]})})})};
mock.module(new URL('../src/lib/app-run-runtime.ts',import.meta.url).href,{namedExports:{getAppRunRuntime:async()=>({})}});
mock.module(new URL('../src/lib/app-connection-session-store.ts',import.meta.url).href,{namedExports:{PostgresAppConnectionSessionStore:class {}}});
mock.module(new URL('../src/lib/app-connection-upgrade-fence.ts',import.meta.url).href,{namedExports:{appConnectionUpgradeSourceIsAvailable:async()=>true}});
mock.module(new URL('../src/lib/db.ts',import.meta.url).href,{namedExports:{db:{transaction:async(work:any)=>work(tx)}}});
mock.module(new URL('../src/lib/app-connection-current-locators.ts',import.meta.url).href,{namedExports:{currentConnectionBindingLocators:()=>({limit:async()=>[{id:bindingId}]})}});
mock.module(new URL('../src/lib/app-connection-session-registry.ts',import.meta.url).href,{namedExports:{connectionProfileDigest:profileDigest,getAppConnectionSessionRegistry:async()=>registry}});
const live=async(actualTx:any,input:any)=>{reads++;batchOptions.push(input.batch_owner_connection_facts);assert.strictEqual(actualTx,tx);input.onConnectionRegistry?.(registry);return structuredClone(current);};
mock.module(new URL('../src/lib/app-attachment-sync-authority.ts',import.meta.url).href,{namedExports:{loadLiveAttachmentSyncBindingAuthority:live,loadConsentContinuationBindingIdentity:live}});
mock.module(new URL('../src/lib/app-attachment-authority.ts',import.meta.url).href,{namedExports:{attachmentFinalAuthorityIsCurrent:async(actualTx:any,_participants:any,options:any)=>{
 await options.guard(actualTx);return active;
}}});
const {currentAppConnectionReadAuthority}=await import('../src/lib/app-connection-session-authority.js');
const caller={org_id:org,user_id:owner,access_expires_at:deadline.getTime()};
const guard=Object.assign(async(actualTx:any)=>{assert.strictEqual(actualTx,tx);guards++;},{current_web_session_expires_at:()=>deadline});
const nomination={installation_id:installationId,target_key:'primary'};
function reset(){active=true;transport=true;reads=0;guards=0;batchOptions.length=0;current.installation.grant_epoch=3;}

test('a composite reader receives the already checked live binding only after its supplied transaction final guard',async()=>{
 reset();let handed:any;
 const result=await currentAppConnectionReadAuthority(caller,nomination,guard,'none',tx as never,undefined,live=>{
  assert.equal(guards,1);handed=live;
 });
 assert.equal(reads,1);assert.equal(result.scope.grant_epoch,3);assert.equal(handed.binding.id,bindingId);
 assert.equal(handed.registration.runtime_epoch,result.scope.runtime_epoch);
});

test('failed fresh admission or final revocation cannot publish the private live binding and later phases read again',async()=>{
 reset();let published=0;
 const read=()=>currentAppConnectionReadAuthority(caller,nomination,guard,'none',tx as never,undefined,()=>{published++;});
 await read();assert.equal(published,1);
 active=false;await assert.rejects(read());assert.equal(published,1);
 active=true;transport=false;await assert.rejects(read());assert.equal(published,1);
 transport=true;current.installation.grant_epoch++;
 const next=await read();assert.equal(next.scope.grant_epoch,4);assert.equal(published,2);assert.equal(reads,4);
});

test('private mutable-row handoff is unavailable without an enclosing transaction',async()=>{
 reset();await assert.rejects(currentAppConnectionReadAuthority(caller,nomination,guard,'none',undefined,undefined,()=>{}));
 assert.equal(reads,0);assert.equal(guards,0);
});


test('only explicit read-only data callbacks opt in to current owner point-fact batching',async()=>{
 reset();await currentAppConnectionReadAuthority(caller,nomination,guard,'none',tx as never);
 assert.deepEqual(batchOptions,[true]);
 reset();await currentAppConnectionReadAuthority(caller,nomination,guard,undefined,tx as never);
 assert.deepEqual(batchOptions,[undefined],'default capturing and setup paths keep their established checks');
});
