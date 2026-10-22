import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appVersions, appGrantSnapshots } from '@deft/db/schema';

const id = randomUUID, org_id = id(), user_id = id(), expires_at = Date.now() + 60000;
const scope = { org_id, owner_user_id: user_id, installation_id: id(), app_version_id: id(), grant_snapshot_id: id(),
  resource_key: 'inbox', target_key: 'personal', consent_expires_at: new Date(expires_at).toISOString() };
const profile = { key: 'example_provider', runtime_requirement_key: 'sync_provider' };
const session = { session_id: id(), revision: 1, state: 'connected', runtime_session_ref: 'runtime-session',
  account: { account_ref: id() }, scope, profile };
const declaration = { schema_version: 'deft.app_record_store.v1', key: 'drafts', resource_key: 'inbox', runtime_requirement_key: 'sync_provider',
  max_record_bytes: 4096, max_files: 0, max_file_bytes: 1, max_total_file_bytes: 1 };
const manifest = JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json', import.meta.url), 'utf8'));
manifest.owner_connections = [{ key: 'personal', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400,
  provider_profile_key: profile.key, runtime_requirement_key: profile.runtime_requirement_key }];
manifest.record_stores = [declaration];
let registryReads = 0, authorityReads = 0, reads = 0, formChecks = 0, carrierChecks = 0, declarationReads = 0;
let carryReviewed = false, foreignReviewed = false;
let deniedSavedReadAfter=Infinity,currentScopePatch:Record<string,unknown>|undefined;
let beforeConsents=()=>{};
let protocol: 'v1' | 'credential_form.v1' | undefined = 'v1', available = true, formValid = true, connectionChanged = false, declarationChanged = false, sessionProfileChanged = false;
function query() { let table: unknown, joined = false; declarationReads++; const chain: any = { from: (value: unknown) => { table = value; return chain; },
  innerJoin: () => { joined = true; return chain; },
  where: () => chain, then: (resolve: any) => Promise.resolve(joined ? [{ manifest, canonical_snapshot: { record_stores: declarationChanged ? [] : [declaration] } }]
    : table === appVersions ? [{ manifest }]
    : table === appGrantSnapshots ? [{ canonical_snapshot: { record_stores: declarationChanged ? [] : [declaration] } }] : []).then(resolve) }; return chain; }
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db: { select: query, transaction: async (work: any) => work({}) } } });
mock.module(new URL('../src/lib/env.ts', import.meta.url).href, { namedExports: { isAppOwnerConnectionsEnabled: () => true } });
mock.module(new URL('../src/lib/app-data-connection-read.ts', import.meta.url).href, { namedExports: {
  readSavedAppDataConnection: async () => { reads++;if(reads>deniedSavedReadAfter)return null;return { ...session, profile: sessionProfileChanged ? { ...profile, key: 'foreign' } : profile,
    revision: connectionChanged && reads > 1 ? 2 : 1 }; },
} });
mock.module(new URL('../src/lib/app-connection-session-authority.ts', import.meta.url).href, { namedExports: {
  currentAppConnectionReadAuthority: async (...args: any[]) => { authorityReads++;if(carryReviewed)args[5]?.({scope:foreignReviewed?{...scope,app_version_id:id()}:scope,manifest,grant_record_stores:declarationChanged?[]:[declaration]}); if (!available) throw Error('CURRENT_AUTHORITY_DENIED'); return { scope:currentScopePatch?{...scope,...currentScopePatch}:scope, profile, expires_at, connection_protocol: protocol }; },
} });
mock.module(new URL('../src/lib/app-connection-session-registry.ts', import.meta.url).href, { namedExports: {
  getAppConnectionSessionRegistry: async () => { registryReads++; return { protocol: () => protocol }; },
} });
mock.module(new URL('../src/lib/app-connection-upgrade-fence.ts', import.meta.url).href, { namedExports: { appConnectionUpgradeSourceIsAvailable: async () => true } });
mock.module(new URL('../src/lib/app-connection-form-fence.ts', import.meta.url).href, { namedExports: {
  validateStoredFormConnection: async () => { formChecks++; return formValid; },
} });
mock.module(new URL('../src/lib/app-connection-consent-continuation-fence.ts', import.meta.url).href, { namedExports: {
  validateContinuationCarrier: async () => { carrierChecks++; throw Error('CURRENT_CARRIER_DENIED'); },
} });
mock.module(new URL('../src/lib/app-data-consent-repair.ts', import.meta.url).href, { namedExports: { appDataConsentConnections: async () => [session] } });
mock.module(new URL('../src/lib/app-data-store.ts', import.meta.url).href, { namedExports: { PostgresAppDataStore: class {async activeConsents(){beforeConsents();return [];}} } });
mock.module(new URL('../src/lib/app-data-prepared-effect.ts', import.meta.url).href, { namedExports: { verifiedRetainedPreparedRecordAction: () => {} } });
mock.module(new URL('../src/lib/app-data-record-change-guards.ts', import.meta.url).href, { namedExports: { sameRecordChangeAuthority: () => true } });
process.env.DEFT_APPS_ENABLED = 'true';
const { currentAppDataAuthority, currentAppDataContext } = await import('../src/lib/app-data-authority.js');
const guard = Object.assign(async () => {}, { current_web_session_expires_at: () => new Date(expires_at) });
const read = () => currentAppDataAuthority({ org_id, user_id, access_expires_at: expires_at }, session.session_id, 'drafts', guard, false, undefined, 'none');
function reset() { registryReads = authorityReads = reads = formChecks = carrierChecks = declarationReads = 0; carryReviewed = foreignReviewed = false;deniedSavedReadAfter=Infinity;currentScopePatch=undefined;beforeConsents=()=>{}; protocol = 'v1'; available = formValid = true; connectionChanged = declarationChanged = sessionProfileChanged = false; }

test('data admission uses the protocol proved by its fresh current reader without rebuilding its registry', async () => {
  reset(); await read(); assert.equal(registryReads, 0); assert.equal(authorityReads, 1); assert.equal(formChecks, 0);
  assert.equal(declarationReads, 1, 'independent current version and grant predicates should share one scoped read');
  await read(); assert.equal(authorityReads, 2, 'later phases still acquire current authority');
  protocol = 'credential_form.v1'; await read(); assert.equal(formChecks, 1, 'a newly current form protocol still validates current custody');
  formValid = false; await assert.rejects(read(), /CURRENT_CARRIER_DENIED/); assert.equal(carrierChecks, 1);
});

test('current revocation, changed session profile/revision, absent protocol and changed store grant remain denied', async () => {
  for (const change of [() => { available = false; }, () => { connectionChanged = true; }, () => { declarationChanged = true; },
    () => { sessionProfileChanged = true; }, () => { protocol = undefined; }]) {
    reset(); change(); await assert.rejects(read());
  }
});

test('data admission consumes only same-phase reviewed declarations and captures them afresh later', async () => {
 reset();carryReviewed=true;await read();assert.equal(declarationReads,0,'the reviewed reader already captured these exact immutable bytes');
 await read();assert.equal(authorityReads,2,'later phases always acquire their own reviewed declaration carrier');
 foreignReviewed=true;await assert.rejects(read());foreignReviewed=false;declarationChanged=true;await assert.rejects(read());
});

const caller={org_id,user_id,access_expires_at:expires_at};

test('real no-identity context path retains one final current capture; identity I/O retains two captures',async()=>{
 reset();carryReviewed=true;let metadataCalls=0;
 const without=await currentAppDataContext(caller,session.session_id,guard,{storeKey:'drafts',includeIdentities:false},async()=>{metadataCalls++;throw Error('metadata must be omitted');});
 assert.equal(authorityReads,1);assert.equal(reads,2);assert.equal(without.authorities.length,1);assert.deepEqual(without.identities,[]);assert.equal(metadataCalls,0);
 await currentAppDataContext(caller,session.session_id,guard,{storeKey:'drafts',includeIdentities:false},async()=>[]);
 assert.equal(authorityReads,2,'a later resolution captures fresh authority again');
 reset();carryReviewed=true;
 await currentAppDataContext(caller,session.session_id,guard,{storeKey:'drafts'},async()=>{metadataCalls++;return [];});
 assert.equal(authorityReads,2);assert.equal(reads,3);assert.equal(metadataCalls,1);
});

test('the retained context capture denies current revoke, owner, epoch and grant changes',async()=>{
 for(const mutate of [()=>{available=false;},()=>{currentScopePatch={owner_user_id:id()};},()=>{currentScopePatch={grant_epoch:2};},
  ()=>{foreignReviewed=true;}]){
  reset();carryReviewed=true;mutate();await assert.rejects(currentAppDataContext(caller,session.session_id,guard,{includeIdentities:false},async()=>[]));
  assert.equal(authorityReads,1);
 }
 reset();carryReviewed=true;
 await assert.rejects(currentAppDataContext(caller,session.session_id,guard,{},async()=>{available=false;return [];}),/CURRENT_AUTHORITY_DENIED/);
 assert.equal(authorityReads,2,'revocation during identity I/O still reaches the mandatory second current capture');
});

test('the terminal saved-session/form and expiry fences reject changes after current store reads',async()=>{
 for(const mutate of [()=>{connectionChanged=true;},()=>{deniedSavedReadAfter=1;}]){
  reset();carryReviewed=true;beforeConsents=mutate;
  await assert.rejects(currentAppDataContext(caller,session.session_id,guard,{includeIdentities:false},async()=>[]));
  assert.equal(authorityReads,1);assert.equal(reads,2,'a pending form insertion or replaced saved revision is reread at the terminal fence');
 }
 reset();carryReviewed=true;const originalNow=Date.now;
 try{beforeConsents=()=>{Date.now=()=>expires_at+1;};await assert.rejects(currentAppDataContext(caller,session.session_id,guard,{includeIdentities:false},async()=>[]));}
 finally{Date.now=originalNow;}
});
