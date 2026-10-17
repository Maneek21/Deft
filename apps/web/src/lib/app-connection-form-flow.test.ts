import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AppConnectionFormContextSchema} from '../../../../packages/app-kit/src/connection-form';
import {checkedFormSetupUrl,createConnectionFormFlow} from './app-connection-form-flow';
const owner=randomUUID(),org=randomUUID(),installation=randomUUID(),session=randomUUID(),expiry=new Date(Date.now()+600_000).toISOString();
const scope={org_id:org,owner_user_id:owner,installation_id:installation,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),package_digest:'sha256:'+'a'.repeat(64),grant_snapshot_digest:'sha256:'+'b'.repeat(64),lifecycle_epoch:1,grant_epoch:1,target_key:'server',resource_key:'inbox',resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),runtime_epoch:1,profile_digest:'sha256:'+'c'.repeat(64),consent_expires_at:expiry};
const at=new Date().toISOString(),view={schema_version:'deft.app_connection_form_session.v1',session_id:session,revision:1,scope,state:'awaiting_input',begin_consumed:true,input_consumed:false,input_expires_at:new Date(Date.now()+290_000).toISOString(),account:null,receipt:null,created_at:at,updated_at:at};
const raw={schema_version:'deft.app_connection_form_context.v1',installation_id:installation,org_id:org,owner_user_id:owner,targets:[{target_key:'server',profile:{key:'imap_smtp',label:'Mail server',authorization_origin:'https://operator.example.test'},scope,runtime_ready:true,action_keys:[],session:null,candidate:null}]};
const context=AppConnectionFormContextSchema.parse(raw),target=context.targets[0],setup={session:view,setup_url:'https://operator.example.test/setup#'+'t'.repeat(43)};
const options={installationId:installation,ownerId:owner,orgId:org,current:()=>true};
test('setup navigation accepts only current one-use ticket on the reviewed operator origin',()=>{
 assert.equal(checkedFormSetupUrl(setup,target,session).url,setup.setup_url);
 for(const setup_url of ['https://other.example.test/setup#'+'t'.repeat(43),'http://operator.example.test/setup#'+'t'.repeat(43),'https://operator.example.test/setup?password=bad#'+'t'.repeat(43),'https://operator.example.test/elsewhere#'+'t'.repeat(43)])assert.throws(()=>checkedFormSetupUrl({...setup,setup_url},target,session));
 assert.throws(()=>checkedFormSetupUrl({...setup,session:{...view,input_consumed:true}},target,session));
 assert.throws(()=>checkedFormSetupUrl(setup,{...target,scope:{...scope,lifecycle_epoch:2}},session));
 assert.throws(()=>checkedFormSetupUrl(setup,target,randomUUID()));
 assert.throws(()=>checkedFormSetupUrl(setup,target,session,Date.now()+600_000));
});
test('public Begin uses metadata only and uncertain response never repeats the mutation',async()=>{
 const calls:{path:string;body?:string}[]=[],flow=createConnectionFormFlow({...options,fetch:async(path,init)=>{calls.push({path,body:init?.body as string|undefined});if(path.endsWith('/context'))return Response.json(raw);throw Error('Lost response');}});
 await assert.rejects(flow.begin(target,session));assert.equal(calls.filter(row=>row.path.endsWith('/begin')).length,1);
 assert.deepEqual(JSON.parse(calls[1].body!),{schema_version:'deft.app_connection_form_begin.v1',installation_id:installation,target_key:'server',request_id:session,source_session_id:null});
});
test('changed owner, target scope, current session and oversized context stop before credential navigation',async()=>{
 for(const value of [{...raw,owner_user_id:randomUUID()},{...raw,targets:[...raw.targets,...raw.targets]},{...raw,targets:[{...raw.targets[0],scope:{...scope,owner_user_id:randomUUID()}}]}])await assert.rejects(createConnectionFormFlow({...options,fetch:async()=>Response.json(value)}).load());
 let live=true;await assert.rejects(createConnectionFormFlow({...options,current:()=>live,fetch:async()=>{live=false;return Response.json(raw);}}).load());
 await assert.rejects(createConnectionFormFlow({...options,fetch:async()=>new Response(JSON.stringify(raw)+' '.repeat(262_144))}).load());
});
test('status cannot redirect to a form or change the account session',async()=>{
 await assert.rejects(createConnectionFormFlow({...options,fetch:async()=>Response.json(setup)}).manage(target,'status',session));
 const flow=createConnectionFormFlow({...options,fetch:async()=>Response.json({session:view})});assert.equal((await flow.manage(target,'status',session)).session_id,session);
});
