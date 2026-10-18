import {createHash,randomUUID} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {canonicalAppDataJson} from '@deft/app-kit';
import {AppIntegrationToolsDeclarationSchema,parseAppIntegrationToolDeclaredInput,type AppIntegrationToolDeclaration} from '../../../../packages/app-kit/src/app-integration-tools.js';
import type {AppIntegrationToolCaller} from './app-integration-tool-authority.js';

export type InstalledToolCaller={kind:'personal_mcp'|'defty';org_id:string;user_id:string;token_id?:string;employee_id?:string;conversation_id?:string};
export type InstalledToolSchema={name:string;description:string;inputSchema:Record<string,unknown>;annotations:{readOnlyHint:boolean}};
type Candidate={installation_id:string;account_ref:string;declaration:AppIntegrationToolDeclaration};
const unavailable=()=>Error('APP_INSTALLED_TOOL_UNAVAILABLE');
const writeOperations=new Set(['record_create','record_save','prepare_action','prepare_resource_action']);
export function installedToolIsWrite(declaration:AppIntegrationToolDeclaration){return declaration.data_operations.some(operation=>writeOperations.has(operation));}

/** The name is usable only for one current installation and one signed schema.
 * Multiple account rows inside that installation are selected by the declaration;
 * the existing execution gateway refuses ambiguous or missing account selectors. */
export function uniqueInstalledTools(candidates:readonly Candidate[],reserved:Iterable<string>=[]){
 const blocked=new Set(reserved),byName=new Map<string,Candidate[]>();
 for(const candidate of candidates){const name=candidate.declaration.key;if(blocked.has(name))continue;const group=byName.get(name)??[];group.push(candidate);byName.set(name,group);}
 return [...byName.values()].filter(group=>new Set(group.map(row=>row.installation_id)).size===1&&group.every(row=>canonicalAppDataJson(row.declaration)===canonicalAppDataJson(group[0]!.declaration)))
  .map(group=>group[0]!).sort((a,b)=>a.declaration.key.localeCompare(b.declaration.key));
}

/** Preserve the previous deterministic input identity for lost-ACK retries.
 * Installation/account are additionally immutable journal target pins; a hash
 * collision with another target is refused by executeIntegrationTool, not rebound. */
export function installedToolRequestId(actor:AppIntegrationToolCaller,declaration:AppIntegrationToolDeclaration,input:Record<string,unknown>){
 if(!installedToolIsWrite(declaration))return randomUUID();
 const identity={org_id:actor.org_id,user_id:actor.user_id,principal_kind:actor.kind,principal_id:actor.principal_id};
 const bytes=createHash('sha256').update(canonicalAppDataJson({identity,name:declaration.key,input})).digest();bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;const h=bytes.subarray(0,16).toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

async function actorFor(caller:InstalledToolCaller):Promise<AppIntegrationToolCaller>{
 if(caller.kind==='personal_mcp'){
  if(!caller.token_id)throw unavailable();
  const [{db},{mcpTokens}]=await Promise.all([import('./db.js'),import('@deft/db/schema')]);
  const [token]=await db.select().from(mcpTokens).where(and(eq(mcpTokens.org_id,caller.org_id),eq(mcpTokens.user_id,caller.user_id),eq(mcpTokens.id,caller.token_id),eq(mcpTokens.principal_kind,'human'),isNull(mcpTokens.revoked_at)));
  if(!token||token.agent_employee_id)throw unavailable();
  return {kind:'personal_mcp',org_id:caller.org_id,user_id:caller.user_id,principal_id:token.id,authorization_version:token.app_run_authorization_version,access_expires_at:Date.now()+300000};
 }
 if(caller.kind!=='defty')throw unavailable();
 return {kind:'defty',org_id:caller.org_id,user_id:caller.user_id,principal_id:caller.user_id,employee_id:caller.employee_id,conversation_id:caller.conversation_id,access_expires_at:Date.now()+300000};
}

async function candidatesFor(actor:AppIntegrationToolCaller){
 const [{db},{currentToolDeclaration},{getAppIntegrationDataGateway}]=await Promise.all([import('./db.js'),import('./app-integration-tool-runtime.js'),import('./app-integration-runtime-gateway.js')]);
 const rows=await db.execute(sql`SELECT g.installation_id,g.account_ref,g.store_key,g.operations,v.manifest FROM app_integration_principal_grants g JOIN app_installations i ON i.org_id=g.org_id AND i.id=g.installation_id JOIN app_versions v ON v.org_id=i.org_id AND v.id=i.active_version_id
  WHERE g.org_id=${actor.org_id} AND g.owner_user_id=${actor.user_id} AND g.principal_kind=${actor.kind} AND g.principal_id=${actor.principal_id} AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND i.state='active'`);
 const candidates:Candidate[]=[];
 for(const row of rows.rows){const parsed=AppIntegrationToolsDeclarationSchema.safeParse((row.manifest as Record<string,unknown>)?.integration_tools);if(!parsed.success)continue;
  for(const declaration of parsed.data){if(declaration.visibility!=='delegated_tools'||declaration.store_key!==row.store_key||!(row.operations as string[]).includes(declaration.operation))continue;
   try{const account=await getAppIntegrationDataGateway().toolAccount(actor,{installation_id:String(row.installation_id),account_ref:String(row.account_ref),store_key:declaration.store_key},declaration.operation);
    const current=await currentToolDeclaration(account.scope,declaration.key);if(canonicalAppDataJson(current)!==canonicalAppDataJson(declaration))continue;
    candidates.push({installation_id:String(row.installation_id),account_ref:String(row.account_ref),declaration});
   }catch{/* Unavailable or revoked accounts never enter discovery. */}
  }
 }
 return candidates;
}

export async function installedToolSchemas(caller:InstalledToolCaller,reserved:Iterable<string>=[]):Promise<InstalledToolSchema[]>{
 const actor=await actorFor(caller);
 return uniqueInstalledTools(await candidatesFor(actor),reserved).map(({declaration})=>({name:declaration.key,description:declaration.description,inputSchema:declaration.input_schema,annotations:{readOnlyHint:!installedToolIsWrite(declaration)}}));
}

export async function executeInstalledTool(name:string,raw:unknown,caller:InstalledToolCaller){
 const actor=await actorFor(caller),matches=uniqueInstalledTools(await candidatesFor(actor)).filter(row=>row.declaration.key===name);if(matches.length!==1)throw unavailable();
 const {installation_id,declaration}=matches[0]!,input=parseAppIntegrationToolDeclaredInput(declaration,raw);
 const {executeIntegrationTool}=await import('./app-integration-tool-runtime.js');
 return executeIntegrationTool(actor,{schema_version:'deft.app_integration_tool.v1',installation_id,request_id:installedToolRequestId(actor,declaration,input),tool_key:name,input});
}
