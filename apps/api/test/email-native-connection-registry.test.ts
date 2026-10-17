import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadNativeEmailProfileRegistry} from '../src/lib/email-native-connection-registry.js';
import {nativeEmailCredentialPolicyDigest} from '../src/lib/email-native-connection-implementation.js';
const implementation='export async function createNativeEmailProviderProfile(){return {connection:{begin(){},complete(){}},mailbox(){return {}}}}';
test('private profile registry loads exact retained versions and one explicitly enabled provider',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'email-profile-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const module_path=join(dir,'profile.mjs'),file=join(dir,'private.json');await writeFile(module_path,implementation);
 const module_sha256=createHash('sha256').update(implementation).digest('hex');
 const entry={profile_id:'gmail',profile_revision:1,provider:'gmail' as const,capabilities:['read'],connect_enabled:false,module_path,module_sha256,options:{provider:'gmail'}};
 const save=async(profiles:unknown[])=>writeFile(file,JSON.stringify({schema_version:'deft.email_native_provider_profiles.v1',profiles}),{mode:0o600});
 await save([entry,{...entry,profile_revision:2,connect_enabled:true}]);const registry=await loadNativeEmailProfileRegistry(file);
 assert.deepEqual(registry.providers(),[{provider:'gmail',capabilities:['read']}]);assert.equal(registry.forConnect('gmail').profile_revision,2);
 assert.equal(registry.selected(entry).profile_revision,1);assert.throws(()=>registry.selected({...entry,module_sha256:'a'.repeat(64)}),/PROFILE_UNAVAILABLE/);
 await save([{...entry,module_sha256:'b'.repeat(64)}]);await assert.rejects(loadNativeEmailProfileRegistry(file),/PROFILE_UNAVAILABLE/);
 await save([{...entry,options:{provider:'microsoft'}}]);await assert.rejects(loadNativeEmailProfileRegistry(file),/PROFILE_UNAVAILABLE/);
 await save([{...entry,connect_enabled:true},{...entry,profile_revision:2,connect_enabled:true}]);await assert.rejects(loadNativeEmailProfileRegistry(file),/PROFILE_UNAVAILABLE/);
 await assert.rejects(loadNativeEmailProfileRegistry('relative-private.json'),/PROFILE_UNAVAILABLE/);
});
test('missing private profile configuration exposes no implicit provider or fallback',async()=>{
 const registry=await loadNativeEmailProfileRegistry(undefined);assert.deepEqual(registry.providers(),[]);assert.throws(()=>registry.forConnect('gmail'),/PROFILE_UNAVAILABLE/);
});
test('explicit compatible implementation retains original profile identity and refuses altered credential policy or code',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'email-implementation-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const module_path=join(dir,'new.mjs'),file=join(dir,'private.json');await writeFile(module_path,implementation);
 const options={provider:'gmail',clients:{gmail:{client_id:'synthetic',client_secret:'synthetic',redirect_uri:'https://deft.example.test/apps/connections/callback'}},custody_root:'/private/synthetic-custody',key_id:'key',encryption_key_hex:'f'.repeat(64)};
 const mapped={module_path,module_sha256:createHash('sha256').update(implementation).digest('hex'),revision:2,credential_policy_sha256:nativeEmailCredentialPolicyDigest(options,['read'])};
 const original={profile_id:'old-profile',profile_revision:1,provider:'gmail' as const,module_path:join(dir,'absent-old.mjs'),module_sha256:'a'.repeat(64),capabilities:['read'],connect_enabled:true,options,implementation:mapped};
 const save=async(entry:unknown)=>writeFile(file,JSON.stringify({schema_version:'deft.email_native_provider_profiles.v1',profiles:[entry]}),{mode:0o600});await save(original);const registry=await loadNativeEmailProfileRegistry(file),selected=registry.selected(original);assert.equal(selected.module_sha256,original.module_sha256);assert.match(selected.implementation_digest!,/^[a-f0-9]{64}$/u);
 for(const changed of [{...original,capabilities:['read','send']},{...original,options:{...options,custody_root:'/different'}},{...original,options:{...options,clients:{gmail:{...options.clients.gmail,client_id:'different'}}}},{...original,implementation:{...mapped,module_sha256:'e'.repeat(64)}}]){await save(changed);await assert.rejects(loadNativeEmailProfileRegistry(file),/PROFILE_UNAVAILABLE/);}
});
