import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {loadAppConnectionRegistry} from '../src/lib/app-connection-registry.js';
import {nativeEmailCredentialPolicyDigest} from '../src/lib/email-native-connection-implementation.js';
test('actual retained registry loads only explicit same-policy compatibility while preserving historical custody pins',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'email-retained-implementation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const code='export async function createAppConnectionAdapter(){return {async handle(){return new Response()},async nativeEmailAccount(){throw Error("fixture only")}}}',module_path=join(dir,'reviewed.mjs'),file=join(dir,'private.json');await writeFile(module_path,code);
 const pins={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),target_key:'email',resource_key:'inbox',resource_binding_id:randomUUID(),action_key:'send',action_binding_id:randomUUID()};
 const options={provider:'gmail',account_id:'retained-account',clients:{gmail:{client_id:'synthetic',client_secret:'synthetic',redirect_uri:'https://deft.example.test/apps/connections/callback'}},custody_root:'/private/custody',key_id:'key',encryption_key_hex:'a'.repeat(64),capabilities:['read','search','thread','send'],connection_target:'email',resource_binding_id:pins.resource_binding_id,action_binding_id:pins.action_binding_id,authority_epoch:2};
 const entry={pins,options,module_path,module_sha256:createHash('sha256').update(code).digest('hex'),compatible_from:{module_sha256:'b'.repeat(64),credential_policy_sha256:nativeEmailCredentialPolicyDigest(options,options.capabilities),revision:1}};
 const save=async(value:unknown)=>writeFile(file,JSON.stringify({schema_version:'deft.app_connection_adapters.v1',entries:[value]}),{mode:0o600});await save(entry);
 const registry=await loadAppConnectionRegistry(file),selected=registry.select({org_id:pins.org_id,owner_user_id:pins.owner_user_id,installation_id:pins.installation_id,target_key:'email'});assert.deepEqual(selected.pins,pins);assert.equal(selected.module_sha256,entry.compatible_from.module_sha256);assert.match(selected.implementation_digest!,/^[a-f0-9]{64}$/u);
 await save({...entry,compatible_from:{...entry.compatible_from,revision:2}});const next=(await loadAppConnectionRegistry(file)).select({org_id:pins.org_id,owner_user_id:pins.owner_user_id,installation_id:pins.installation_id,target_key:'email'});assert.notEqual(selected.implementation_digest,next.implementation_digest);
 for(const change of [{...entry,module_sha256:'c'.repeat(64)},{...entry,options:{...options,custody_owner_uid:1001}},{...entry,options:{...options,custody_root:'/other'}},{...entry,options:{...options,capabilities:[...options.capabilities,'modify']}},{...entry,options:{...options,clients:{gmail:{...options.clients.gmail,redirect_uri:'https://deft.example.test/email/connections/callback'}}}}]){await save(change);await assert.rejects(loadAppConnectionRegistry(file));}
 assert.equal(nativeEmailCredentialPolicyDigest(options,options.capabilities),nativeEmailCredentialPolicyDigest({...options,custody_owner_uid:null},options.capabilities));
});
