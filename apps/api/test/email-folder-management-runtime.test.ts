import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {ConnectedEmailMailboxAuthority} from '../src/lib/email-mailbox-connected-authority.js';
import {EmailNativeFolderService,RegisteredEmailNativeFolderProvider} from '../src/lib/email-native-folders.js';
import {EmailMailboxCrypto} from '../src/lib/email-mailbox-crypto.js';
import {EmailMailboxError} from '../src/lib/email-mailbox-service.js';
import type {EmailFolderManageJournal,EmailFolderManageValue} from '../src/lib/email-folder-management-contract.js';
const ts=createRequire(import.meta.url)('typescript');
const scope={org_id:'org-runtime',owner_user_id:'owner-runtime',account_id:'account-runtime'},actor={user_id:scope.owner_user_id,web_session_id:'session-runtime',access_expires_at:Date.now()+600000};
function fixture(){
 let sqlVersion='raw-sql-version',effect=0,lateSql=false,latePrincipal=false,writes=0;
 const account={account_id:scope.account_id,provider:'gmail',resource_binding_id:'binding-runtime',principal_digest:'a'.repeat(64),connection_revision:1,authority_epoch:1,health:'connected',capabilities:['read','modify']};
 const cap=()=>({...scope,scope,resource_binding_id:account.resource_binding_id,authority_version:sqlVersion,expires_at:Date.now()+300000});
 const values=new Map<string,EmailFolderManageValue>();
 class Journal implements EmailFolderManageJournal{
  constructor(_db:unknown,_cipher:unknown,_scope:unknown,private guard:(tx:unknown)=>Promise<void>){}
  async load(id:string){await this.guard({transaction:true});return values.get(id)??null;}
  async recent(){await this.guard({transaction:true});return [];}
  async change<T>(id:string,work:(value:EmailFolderManageValue|null,write:(value:EmailFolderManageValue)=>Promise<void>)=>Promise<T>){if(lateSql)sqlVersion='changed-sql-version';await this.guard({transaction:true});return work(values.get(id)??null,async value=>{await this.guard({transaction:true});values.set(id,structuredClone(value));writes++;await this.guard({transaction:true});});}
 }
 const adapter={nativeEmailAccount:async()=>structuredClone(account),nativeEmailFolderManage:async(input:{name:string})=>{effect++;if(latePrincipal)account.principal_digest='b'.repeat(64);return {id:'private-provider-id',folder_id:'label:'+'c'.repeat(64),label:input.name,kind:'label'};}};
 const components={provider:{assertConnected:async()=>structuredClone(account)},resolve:async(_scope:unknown,capability:ReturnType<typeof cap>,recheck:()=>Promise<void>,signal?:AbortSignal)=>({adapter,context:{...scope,installation_id:'runtime',resource_binding_id:capability.resource_binding_id,authority_version:capability.authority_version,expires_at:capability.expires_at,recheck,signal}})};
 const raw=readFileSync(process.env.DEFT_FOLDER_RUNTIME_SOURCE??new URL('../src/lib/email-mailbox-runtime.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('runtime.ts',raw,ts.ScriptTarget.Latest,true),declaration=ast.statements.find((row:{name?:{text:string}})=>row.name?.text==='getEmailNativeFolderService');assert.ok(declaration);
 const code=ts.transpileModule(declaration.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,exports={};
 runInNewContext(code,{exports,getEmailMailboxAuthority:async()=>({current:async()=>cap()}),getAppRunRuntime:async()=>({keys:{current:()=>({key_id:'runtime',key:Buffer.alloc(32,31)}),read:()=>({key_id:'runtime',key:Buffer.alloc(32,31)}),keyIds:()=>['runtime']}}),getEmailMailboxComponents:async()=>components,db:{},ConnectedEmailMailboxAuthority,RegisteredEmailNativeFolderProvider,EmailNativeFolderService,EmailMailboxCrypto,PostgresEmailFolderManagementJournal:Journal,EmailMailboxError,Date});
 return {build:()=> (exports as {getEmailNativeFolderService:(value:typeof actor)=>Promise<EmailNativeFolderService>}).getEmailNativeFolderService(actor),lateSql(){lateSql=true;},latePrincipal(){latePrincipal=true;},get effect(){return effect;},get writes(){return writes;},values};
}
test('actual runtime composition accepts distinct raw SQL and custody-derived versions without relaxing either fence',async()=>{const f=fixture(),service=await f.build(),result=await service.manage(actor,scope,{operation_id:randomUUID(),kind:'create',name:'Business'});assert.equal(result.state,'succeeded');assert.equal(f.effect,1);assert.equal(f.writes,3);assert.notEqual([...f.values.values()][0].plan.binding.authority_version,'raw-sql-version');});
test('actual runtime transaction guard rejects changed raw SQL snapshot before a provider effect',async()=>{const f=fixture(),service=await f.build();f.lateSql();await assert.rejects(service.manage(actor,scope,{operation_id:randomUUID(),kind:'create',name:'Business'}),/DENIED/);assert.equal(f.effect,0);assert.equal(f.writes,0);});
test('actual runtime keeps independent fresh custody principal fence after provider IO',async()=>{const f=fixture(),service=await f.build();f.latePrincipal();await assert.rejects(service.manage(actor,scope,{operation_id:randomUUID(),kind:'create',name:'Business'}),/DENIED/);assert.equal(f.effect,1);assert.equal(f.writes,2);assert.equal([...f.values.values()][0].state,'started');});
