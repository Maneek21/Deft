import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {experienceTerminalOutput} from '../src/lib/app-experience-run-output.js';
import {AppRunSecretService} from '../src/lib/app-run-secrets.js';
import {parseEnvironmentAppRunKeyrings} from '../src/lib/app-run-keyrings.js';
import type {AppRunTransaction} from '../src/lib/app-run-repository.js';
process.env.DATABASE_URL??='postgres://postgres:postgres@localhost:5432/deft';
const {AppRunSecretRepository}=await import('../src/lib/app-run-secret-repository.js');
const schema={type:'object' as const,additionalProperties:false as const,properties:{operation_id:{type:'string' as const,maxLength:36},
 undo_available:{type:'boolean' as const},items:{type:'string' as const,maxLength:4096}},required:['operation_id','undo_available','items']};
const value={operation_id:randomUUID(),undo_available:true,items:randomUUID()+': succeeded'};
const retained={schema_version:'deft.app_run_provider_result.v1',provider_succeeded:true,output:value};
test('terminal owner output releases only reviewed scalar fields from an acknowledged result envelope',()=>{
 assert.deepEqual(experienceTerminalOutput(retained,schema,'succeeded'),value);
 assert.deepEqual(experienceTerminalOutput({...retained,provider_succeeded:false},schema,'failed'),value);
 for(const raw of [{...retained,provider_succeeded:false},{...retained,credential:'secret'},
  {...retained,output:{...value,provider_locator:'unreviewed'}},{...retained,output:{...value,items:'x'.repeat(4097)}},
  {...retained,output:{...value,items:[{credential:'secret'}]}}])assert.throws(()=>experienceTerminalOutput(raw,schema,'succeeded'));
});
function repositoryFixture(){
 const key=(byte:number)=>Buffer.alloc(32,byte).toString('base64');
 const keys=parseEnvironmentAppRunKeyrings(JSON.stringify({schema_version:'deft.app_run_keyring.v1',
  run_encryption:{current:'e',keys:{e:key(1)}},receipt_signing:{current:'s',keys:{s:key(2)}},fingerprint:{current:'f',keys:{f:key(3)}}}));
 const secrets=new AppRunSecretService(keys),repository=new AppRunSecretRepository(secrets);
 const org_id=randomUUID(),run_id=randomUUID(),attempt_id=randomUUID();
 const envelope=secrets.sealJson(retained,{org_id,run_id,attempt_id,payload_kind:'output'});
 const now=Date.now(),row={org_id,run_id,attempt_id,payload_kind:'output',envelope_version:envelope.schema_version,...envelope,
  expires_at:new Date(now+1000),payload_bytes:Buffer.from(envelope.ciphertext_b64,'base64').length};
 const tx={select:()=>{const query:any={from(){return query;},where(){return query;},limit(){return query;},
  then(resolve:any,reject:any){return Promise.resolve([row]).then(resolve,reject);}};return query;}} as unknown as AppRunTransaction;
 return{repository,tx,row,org_id,run_id,attempt_id,now};
}
test('encrypted owner output honors exact org/Run/attempt and retained TTL before and after decryption',async()=>{
 const f=repositoryFixture();
 assert.deepEqual((await f.repository.readRetainedOutput(f.org_id,f.run_id,f.attempt_id,()=>new Date(f.now),f.tx))?.value,retained);
 for(const pins of [[randomUUID(),f.run_id,f.attempt_id],[f.org_id,randomUUID(),f.attempt_id],[f.org_id,f.run_id,randomUUID()]])
  assert.equal(await f.repository.readRetainedOutput(pins[0]!,pins[1]!,pins[2]!,()=>new Date(f.now),f.tx),null);
 assert.equal(await f.repository.readRetainedOutput(f.org_id,f.run_id,f.attempt_id,()=>new Date(f.now+1000),f.tx),null);
 let checks=0;
 assert.equal(await f.repository.readRetainedOutput(f.org_id,f.run_id,f.attempt_id,()=>new Date(++checks===1?f.now:f.now+1000),f.tx),null);
 f.row.payload_bytes=65_537;assert.equal(await f.repository.readRetainedOutput(f.org_id,f.run_id,f.attempt_id,()=>new Date(f.now),f.tx),null);
});
