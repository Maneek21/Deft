import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';

Object.assign(process.env,{DATABASE_URL:'postgresql://synthetic@127.0.0.1:1/deft_test',DEFT_APPS_ENABLED:'true',
 DEFT_APP_RUNS_ENABLED:'true',DEFT_APP_RUN_APP_ORIGIN_ENABLED:'true',DEFT_APP_RUNTIME_CHANNEL_ENABLED:'true',
 DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED:'true',DEFT_APP_ATTACHMENT_BROKER_ENABLED:'true',DEFT_APP_OWNER_CONNECTIONS_ENABLED:'true'});
const ring=(id:string)=>({current:id,keys:{[id]:createHash('sha256').update(`synthetic-structured-${id}`).digest('base64')}});
process.env.DEFT_APP_RUN_KEYRINGS=JSON.stringify({schema_version:'deft.app_run_keyring.v1',run_encryption:ring('enc'),receipt_signing:ring('sign'),fingerprint:ring('fp')});

test('actual App data request returns the safe structured Runtime reason and original bounded code',async t=>{
 const auth=await import('../src/lib/app-resource-sync-web-authority.js');
 const org=randomUUID(),user=randomUUID(),sid=randomUUID();
 mock.module(new URL('../src/lib/app-resource-sync-web-authority.ts',import.meta.url).href,{namedExports:{...auth,
  resourceSyncWebAuthority:async()=>({actor:{org_id:org,actor_id:user},web_session:{sid,expires_at:Date.now()+60000},guard:async()=>{}})}});
 const [{AppDataService},{createAppDataRoutes},{appRuntimeResponseError}]=await Promise.all([
  import('../src/lib/app-data-service.js'),import('../src/routes/app-data.js'),import('../src/lib/app-runtime-response-error.js')]);
 t.mock.method(AppDataService.prototype,'invoke',async()=>{throw await appRuntimeResponseError(
  Response.json({error:'EMAIL_DATA_SOURCE_CHANGED',stack:'private provider secret'},{status:403}),new AbortController().signal);});
 const response=await createAppDataRoutes().request(`/connections/${randomUUID()}/requests`,{method:'POST',
  headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify({})});
 assert.equal(response.status,409);assert.deepEqual(await response.json(),{
  error:'The selected source changed while the app was reading it. Try the read again.',code:'APP_RUNTIME_SOURCE_CHANGED',
  details:{runtime_code:'EMAIL_DATA_SOURCE_CHANGED',retryable:true}});
});
