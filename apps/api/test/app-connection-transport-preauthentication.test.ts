import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

let proofReads=0,aliasesCurrent=true;
const aliasId=randomUUID();
mock.module(new URL('../src/lib/app-upgrade-trust-registry.ts',import.meta.url).href,{namedExports:{trustedUpgradeRegistryEntries:async(entries:any[])=>{
 proofReads++;if(!aliasesCurrent)return [];return entries.map(entry=>({...entry,runtime_registration_id:aliasId,runtime_epoch:2}));
}}});
const {loadAppConnectionSessionRegistry,preauthenticateAppConnectionTransport,connectionProfileDigest}=await import('../src/lib/app-connection-session-registry.js');
async function fixture(t:any){
 const directory=await mkdtemp(join(tmpdir(),'deft-transport-preauth-')),path=join(directory,'connections.json');
 const prior=process.env.DEFT_APP_CONNECTION_HTTP_CONFIG;process.env.DEFT_APP_CONNECTION_HTTP_CONFIG=path;
 t.after(async()=>{if(prior===undefined)delete process.env.DEFT_APP_CONNECTION_HTTP_CONFIG;else process.env.DEFT_APP_CONNECTION_HTTP_CONFIG=prior;
  await unlink(path).catch(()=>{});await rmdir(directory);});
 const token='a'.repeat(43),org=randomUUID(),installation=randomUUID(),operator=randomUUID(),registration=randomUUID();
 const profile={schema_version:'deft.app_connection_profile.v1',key:'mail',provider_id:'mail',operator_user_id:operator,
  runtime_requirement_key:'mail',resource_key:'messages',action_keys:[],authorization_origin:'https://provider.example.test',credential_custody:'runtime',executable:false};
 const entry={org_id:org,installation_id:installation,runtime_registration_id:registration,runtime_epoch:1,profile,
  endpoint:'https://runtime.example.test/v1/connections',runtime_auth_token:'b'.repeat(43),authority_token_sha256:'sha256:'+createHash('sha256').update(token).digest('hex')};
 const config={schema_version:'deft.app_connection_http_registrations.v1',entries:[entry]};
 const scope={org_id:org,installation_id:installation,operator_user_id:operator,profile_digest:connectionProfileDigest(profile as never),
  runtime_registration_id:aliasId,runtime_epoch:2};
 await writeFile(path,JSON.stringify(config),{mode:0o600});proofReads=0;aliasesCurrent=true;
 return {path,config,scope,token,authorization:'Bearer '+token};
}

test('fresh credential entry loading skips database alias proofs while default/final loading still reconstructs them',async t=>{
 const f=await fixture(t);
 await preauthenticateAppConnectionTransport(f.scope,f.authorization);assert.equal(proofReads,0);
 const roots=await loadAppConnectionSessionRegistry(f.path,undefined,{trustedSuccessors:false});
 roots.preauthenticateTransport(f.scope,f.authorization);assert.equal(proofReads,0);
 assert.throws(()=>roots.authenticate(f.scope as never,f.authorization),'credential admission never makes an alias exact authority');
 const full=await loadAppConnectionSessionRegistry(f.path);assert.equal(proofReads,1);
 full.authenticate(f.scope as never,f.authorization);
 aliasesCurrent=false;
 await preauthenticateAppConnectionTransport(f.scope,f.authorization);
 const revoked=await loadAppConnectionSessionRegistry(f.path);assert.equal(proofReads,2);
 assert.throws(()=>revoked.authenticate(f.scope as never,f.authorization),'revoked aliases cannot reuse credential-only entry admission');
});

test('deployment replacement, token rotation and removal are observed afresh after entry admission',async t=>{
 const f=await fixture(t);await preauthenticateAppConnectionTransport(f.scope,f.authorization);
 const rotated={...f.config,entries:[{...f.config.entries[0],authority_token_sha256:'sha256:'+createHash('sha256').update('z'.repeat(43)).digest('hex')}]};
 await writeFile(f.path,JSON.stringify(rotated),{mode:0o600});
 await assert.rejects(preauthenticateAppConnectionTransport(f.scope,f.authorization));
 const final=await loadAppConnectionSessionRegistry(f.path);assert.throws(()=>final.authenticate(f.scope as never,f.authorization));
 await writeFile(f.path,JSON.stringify(f.config),{mode:0o600});await preauthenticateAppConnectionTransport(f.scope,f.authorization);
 const changed={...f.config,entries:[{...f.config.entries[0],profile:{...f.config.entries[0]!.profile,authorization_origin:'https://replacement.example.test'}}]};
 await writeFile(f.path,JSON.stringify(changed),{mode:0o600});await assert.rejects(preauthenticateAppConnectionTransport(f.scope,f.authorization));
 await unlink(f.path);await assert.rejects(preauthenticateAppConnectionTransport(f.scope,f.authorization));
});
