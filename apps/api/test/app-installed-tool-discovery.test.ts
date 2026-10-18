import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalAppDataJson} from '@deft/app-kit';
import {uniqueInstalledTools,installedToolRequestId,installedToolIsWrite} from '../src/lib/app-installed-tool-discovery.js';
import {discoverPersonalInstalledTools} from '../src/lib/mcp-tools/installed-apps.js';
import type {AppIntegrationToolDeclaration} from '../../../packages/app-kit/src/app-integration-tools.js';
const declaration:AppIntegrationToolDeclaration={key:'customer_read',description:'Read a granted customer record',operation:'read',mode:'data',store_key:'records',resource_key:'customers',runtime_requirement_key:'provider',input_schema:{type:'object',additionalProperties:false,properties:{account:{type:'string'}}},account_input_key:'account',data_operations:['record_read'],input_pins:[],visibility:'delegated_tools'};
const candidate={installation_id:'one',account_ref:'account',declaration};
const actor={kind:'personal_mcp' as const,org_id:'org',user_id:'owner',principal_id:'token',access_expires_at:123,authorization_version:1};
test('one signed tool can cover multiple accounts, never multiple installations or conflicting schemas',()=>{
 assert.equal(uniqueInstalledTools([candidate,{...candidate,account_ref:'second'}]).length,1);
 assert.deepEqual(uniqueInstalledTools([candidate,{...candidate,installation_id:'other'}]),[]);
 assert.deepEqual(uniqueInstalledTools([candidate,{...candidate,declaration:{...declaration,input_schema:{type:'object',properties:{secret:{type:'string'}}}}}]),[]);
 assert.deepEqual(uniqueInstalledTools([candidate],['customer_read']),[]);
 assert.equal(uniqueInstalledTools([{...candidate,declaration:{...declaration,key:'other_app_tool'}}])[0]!.declaration.key,'other_app_tool');
});
test('writes and review are identified from signed data operations, not a product name',()=>{
 assert.equal(installedToolIsWrite(declaration),false);
 for(const operation of ['record_create','record_save','prepare_action','prepare_resource_action'] as const)assert.equal(installedToolIsWrite({...declaration,key:'arbitrary_app_tool',data_operations:[operation]}),true);
 assert.equal(installedToolIsWrite({...declaration,key:'email_send',data_operations:['record_read']}),false);
});
test('lost-ACK writes keep the exact previous request UUID; caller and input changes never reuse it',()=>{
 const write={...declaration,key:'arbitrary_app_tool',data_operations:['record_save'] as const},input={account:'account',value:'saved'};
 const legacy=createHash('sha256').update(canonicalAppDataJson({identity:{org_id:actor.org_id,user_id:actor.user_id,principal_kind:actor.kind,principal_id:actor.principal_id},name:write.key,input})).digest();legacy[6]=(legacy[6]!&15)|64;legacy[8]=(legacy[8]!&63)|128;const h=legacy.subarray(0,16).toString('hex'),expected=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
 assert.equal(installedToolRequestId(actor,{...write,data_operations:[...write.data_operations]},input),expected);
 assert.notEqual(installedToolRequestId({...actor,principal_id:'other'}, {...write,data_operations:[...write.data_operations]},input),expected);
 assert.notEqual(installedToolRequestId(actor,{...write,data_operations:[...write.data_operations]},{...input,account:'other'}),expected);
});
test('OAuth, nonhuman and missing personal credentials are denied before loading any grants',async()=>{
 let calls=0;const discover=async()=>{calls++;return [];};
 for(const principal_kind of ['oauth','agent',undefined])assert.deepEqual(await discoverPersonalInstalledTools({principal_kind,org_id:'org',user_id:'owner',token_id:'token'},[],discover),[]);
 assert.deepEqual(await discoverPersonalInstalledTools({principal_kind:'human',org_id:'org',user_id:'owner'},[],discover),[]);assert.equal(calls,0);
});
test('personal discovery carries exact identity/reserved names and reloads revocation each time',async()=>{
 let granted=true;const principal={principal_kind:'human',org_id:'org',user_id:'owner',token_id:'token'},reserved=['task_create'];
 const discover=async(caller:unknown,names:Iterable<string>)=>{assert.deepEqual(caller,{kind:'personal_mcp',org_id:'org',user_id:'owner',token_id:'token'});assert.deepEqual([...names],reserved);return granted?[{name:'customer_read',description:'Read',inputSchema:{},annotations:{readOnlyHint:true}}]:[];};
 assert.equal((await discoverPersonalInstalledTools(principal,reserved,discover)).length,1);granted=false;assert.deepEqual(await discoverPersonalInstalledTools(principal,reserved,discover),[]);
});
