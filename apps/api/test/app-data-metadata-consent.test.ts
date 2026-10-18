import test from 'node:test';
import assert from 'node:assert/strict';

const principal={org_id:'11111111-1111-4111-8111-111111111111',user_id:'22222222-2222-4222-8222-222222222222',sid:'33333333-3333-4333-8333-333333333333',access_expires_at:Date.now()+60000};
const session='44444444-4444-4444-8444-444444444444';
async function production(){
 // Initialize the same authority import cycle as existing service tests; no server.
 await import('../src/lib/app-runtime-authority.js');
 return (await import('../src/lib/app-data-service.js')).AppDataService;
}

test('plain metadata asks for optional exact store consent before storage or dispatch',async()=>{
 const AppDataService=await production(),seen:unknown[][]=[];
 type Service=InstanceType<typeof AppDataService>;
 class Probe extends AppDataService{
  override async current(...args:Parameters<Service['current']>):ReturnType<Service['current']>{seen.push(args);throw Error('METADATA_PROBE');}
 }
 const service=new Probe(principal,async()=>{});
 await assert.rejects(service.invoke(session,{schema_version:'deft.app_data_request.v1',request_id:'55555555-5555-4555-8555-555555555555',operation:'connection_metadata',input:{store_key:'generic_store'}}),/METADATA_PROBE/);
 assert.deepEqual(seen,[[session,'generic_store','optional','connection_metadata']]);
});

test('metadata rechecks preserve null and pin the original grant; replacement and revocation deny',async()=>{
 const AppDataService=await production(),seen:unknown[][]=[];
 type Service=InstanceType<typeof AppDataService>;
 type Authority=Awaited<ReturnType<InstanceType<typeof AppDataService>['current']>>;
 const base={scope:{},connection:{},data_policy_digest:'policy',consent:null} as unknown as Authority;
 let response=base;
 class Probe extends AppDataService{
  override async current(...args:Parameters<Service['current']>):ReturnType<Service['current']>{seen.push(args);return response;}
 }
 const service=new Probe(principal,async()=>{});
 // The private production recheck has no IO when its current port is substituted.
 const recheck=(service as unknown as {assertCurrent(previous:Authority,session:string,store:string,operation:string):Promise<void>}).assertCurrent.bind(service);
 await recheck(base,session,'generic_store','connection_metadata');
 assert.deepEqual(seen.pop(),[session,'generic_store',false,'connection_metadata',undefined]);
 const granted={...base,consent:{consent_id:'original',consent_digest:'digest',expires_at:new Date(Date.now()+60000)}} as Authority;
 response=granted;await recheck(granted,session,'generic_store','connection_metadata');
 assert.deepEqual(seen.pop(),[session,'generic_store',true,'connection_metadata','original']);
 response=base;await assert.rejects(recheck(granted,session,'generic_store','connection_metadata'));
 response={...granted,consent:{...granted.consent!,consent_id:'replacement'}};await assert.rejects(recheck(granted,session,'generic_store','connection_metadata'));
 response=granted;await assert.rejects(recheck(base,session,'generic_store','connection_metadata'),'a late grant cannot upgrade retained null');
});
