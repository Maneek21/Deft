import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
Object.assign(process.env,{DEFT_APPS_ENABLED:'true',DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true',DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',DEFT_APP_OWNER_CONNECTIONS_ENABLED:'true'});
const ring=(id:string)=>({current:id,keys:{[id]:createHash('sha256').update('synthetic-data-policy-'+id).digest('base64')}});
process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fingerprint')});

test('context target selector is strict and requests no provider identities',async()=>{
 const {appDataContextOptions}=await import('../src/routes/app-data.js');
 const url='https://host.test/api/app-data/installations/11111111-1111-4111-8111-111111111111/context';
 assert.deepEqual(appDataContextOptions(url),{});
 assert.deepEqual(appDataContextOptions(url+'?target_key=secondary'),{targetKey:'secondary',includeIdentities:false});
 for(const query of ['target_key=','target_key=secondary&target_key=sender','target_key=sender&unknown=1','target_key=constructor','target_key=../sender','session_id=private','includeIdentities=true'])assert.throws(()=>appDataContextOptions(url+'?'+query));
});
test('App data routes apply current kill switch before fullrecord/binary parsing',async()=>{
 const {createAppDataRoutes}=await import('../src/routes/app-data.js'),routes=createAppDataRoutes();
 for(const flag of ['DEFT_APPS_ENABLED','DEFT_APP_OWNER_CONNECTIONS_ENABLED']){process.env[flag]='false';try{
  for(const path of ['/connections/x/requests','/connections/x/binary','/connections/x/consent/review','/connections/x/consent/activate','/runtime/authority']){
   const response=await routes.request(path,{method:'POST',headers:{'content-type':'application/json'},body:'{'});assert.equal(response.status,503);assert.equal((await response.json()).code,'APP_FEATURE_DISABLED');assert.equal(response.headers.get('cache-control'),'no-store');}
 }finally{process.env[flag]='true';}}
});
test('App data owner and runtime audiences keep independent ordinary budgets and authenticate before content',async()=>{
 const {createAppDataRoutes}=await import('../src/routes/app-data.js'),routes=createAppDataRoutes();
 const post=(path:string,index:number)=>routes.request(path,{method:'POST',headers:{authorization:'Bearer synthetic-'+index,'content-type':'application/json','x-forwarded-for':'192.0.2.'+(index%250+1)},body:'{'});
 for(let index=0;index<600;index++)assert.equal((await post('/connections/x/requests',index)).status,401);
 assert.equal((await post('/connections/x/binary',600)).status,429);
 for(let index=0;index<120;index++)assert.equal((await post('/runtime/authority',index)).status,400,'authority burst has its own bounded audience');
 const over=await routes.request('/runtime/authority',{method:'POST',headers:{'content-type':'application/json','content-length':'17000'},body:'{}'});assert.equal(over.status,400);
});
