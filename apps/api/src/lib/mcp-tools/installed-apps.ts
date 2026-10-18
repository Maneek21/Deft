import {textResult,errorResult} from './types.js';
import type {HumanToolContext} from './human.js';
import type {InstalledToolSchema} from '../app-installed-tool-discovery.js';
type Principal={principal_kind?:string;org_id:string;user_id:string;token_id?:string};
type Discover=(caller:{kind:'personal_mcp';org_id:string;user_id:string;token_id:string},reserved:Iterable<string>)=>Promise<InstalledToolSchema[]>;
export async function discoverPersonalInstalledTools(principal:Principal,reserved:Iterable<string>=[],discover:Discover=async(caller,names)=>{
 const {installedToolSchemas}=await import('../app-installed-tool-discovery.js');return installedToolSchemas(caller,names);
}){
 if(principal.principal_kind!=='human'||!principal.token_id)return [];
 return discover({kind:'personal_mcp',org_id:principal.org_id,user_id:principal.user_id,token_id:principal.token_id},reserved);
}
export async function executePersonalInstalledTool(name:string,input:unknown,ctx:HumanToolContext){
 if(ctx.principal_kind!=='human'||!ctx.token_id)return errorResult('Installed App tools require an independently granted personal MCP credential');
 try{const {executeInstalledTool}=await import('../app-installed-tool-discovery.js');return textResult(await executeInstalledTool(name,input,{kind:'personal_mcp',org_id:ctx.org_id,user_id:ctx.user_id,token_id:ctx.token_id}));}
 catch{return errorResult('APP_INSTALLED_TOOL_UNAVAILABLE');}
}
