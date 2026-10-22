import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {drizzle} from 'drizzle-orm/node-postgres';

const org=randomUUID(),owner=randomUUID(),sessionId=randomUUID();
const profile={schema_version:'deft.app_connection_profile.v1',key:'provider',provider_id:'provider',operator_user_id:owner,
 runtime_requirement_key:'provider',resource_key:'messages',action_keys:[],authorization_origin:'https://provider.example.test',credential_custody:'runtime',executable:false};
const digest='sha256:'+'a'.repeat(64),now=new Date().toISOString();
const stored={session_id:sessionId,revision:3,scope:{org_id:org,owner_user_id:owner,installation_id:randomUUID(),app_version_id:randomUUID(),
 grant_snapshot_id:randomUUID(),package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:2,target_key:'primary',
 resource_key:'messages',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:owner,runtime_epoch:4,
 profile_digest:digest,consent_expires_at:new Date(Date.now()+60_000).toISOString()},profile,state:'connected',callback_state_hash:'a'.repeat(64),
 callback_consumed:true,callback_expires_at:now,runtime_session_ref:'runtime_ref',account:{account_ref:'synthetic_account',label:'Synthetic account'},created_at:now,updated_at:now};
const locator={org_id:org,owner_user_id:owner,session_id:sessionId};
let record=structuredClone(stored),form:string|null=null,formValid=true,transactions=0,formChecks=0;
const queries:{text:string;params:unknown[]}[]=[];
const database=drizzle({client:{query:async(config:{text:string},params:unknown[])=>{
 queries.push({text:config.text,params});
 assert.ok(config.text.includes('left join "app_connection_forms"'));
 assert.ok(config.text.includes('"app_connection_forms"."org_id" = "app_connection_sessions"."org_id"'));
 assert.ok(config.text.includes('"app_connection_forms"."owner_user_id" = "app_connection_sessions"."owner_user_id"'));
 const found=params.length===4&&params[0]===org&&params[1]===owner&&params[2]===sessionId&&params[3]===1;
 return {rows:found?[[record,form]]:[]};
}} as never});
const tx={};
mock.module(new URL('../src/lib/db.ts',import.meta.url).href,{namedExports:{db:{select:database.select.bind(database),transaction:async(work:(value:unknown)=>Promise<unknown>)=>{transactions++;return work(tx);}}}});
mock.module(new URL('../src/lib/app-connection-form-fence.ts',import.meta.url).href,{namedExports:{validateStoredFormConnection:async(actualTx:unknown,actualLocator:unknown,actualRecord:unknown)=>{
 formChecks++;assert.strictEqual(actualTx,tx);assert.deepEqual(actualLocator,locator);assert.deepEqual(actualRecord,record);
 if(!formValid)throw Error('APP_CONNECTION_FORM_SPLIT_STATE');return {};
}}});
const {readSavedAppDataConnection}=await import('../src/lib/app-data-connection-read.js');
function reset(){record=structuredClone(stored);form=null;formValid=true;transactions=0;formChecks=0;queries.length=0;}

test('cold and warm saved data reads each execute one scoped statement and no empty transaction',async()=>{
 reset();
 for(let i=0;i<4;i++)assert.deepEqual(await readSavedAppDataConnection(locator),stored);
 assert.equal(queries.length,4);assert.equal(transactions,0);assert.equal(formChecks,0);
 assert.ok(queries.every(query=>!query.text.includes('"package"')&&!query.text.includes('"manifest"')));
});

test('owner and org are mandatory on both the session lookup and form journal join',async()=>{
 reset();
 assert.equal(await readSavedAppDataConnection({...locator,org_id:randomUUID()}),null);
 assert.equal(await readSavedAppDataConnection({...locator,owner_user_id:randomUUID()}),null);
 assert.equal(await readSavedAppDataConnection({...locator,session_id:randomUUID()}),null);
 assert.equal(transactions,0);assert.equal(queries.length,3);
});

test('a form inserted between admission and final read cannot reuse cached absence',async()=>{
 reset();await readSavedAppDataConnection(locator);
 form=sessionId;formValid=false;
 await assert.rejects(readSavedAppDataConnection(locator),/APP_CONNECTION_FORM_SPLIT_STATE/);
 assert.equal(queries.length,2);assert.equal(transactions,1);assert.equal(formChecks,1);
 formValid=true;
 assert.deepEqual(await readSavedAppDataConnection(locator),stored);
 assert.equal(formChecks,2,'each present-journal read repeats the existing locked carrier validation');
});

test('saved data session bytes and revision are reread rather than retained across phases',async()=>{
 reset();const before=await readSavedAppDataConnection(locator);
 record.revision++;record.scope.runtime_epoch++;
 const after=await readSavedAppDataConnection(locator);
 assert.notEqual(before!.revision,after!.revision);assert.notEqual(before!.scope.runtime_epoch,after!.scope.runtime_epoch);
 record={...record,unknown:true} as typeof record;
 await assert.rejects(readSavedAppDataConnection(locator));
 assert.equal(queries.length,3);
});
