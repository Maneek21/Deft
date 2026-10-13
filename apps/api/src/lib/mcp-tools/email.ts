import {EMAIL_INTEGRATION_TOOL_NAMES,executeEmailIntegrationTool} from '../email-integration-agent-tools.js';
import {textResult,errorResult} from './types.js';
import type {HumanToolContext} from './human.js';
export const HUMAN_EMAIL_TOOLS=Object.fromEntries(EMAIL_INTEGRATION_TOOL_NAMES.map(name=>[name,async(args:unknown,ctx:HumanToolContext)=>{
 if(ctx.principal_kind!=='human'||!ctx.token_id)return errorResult('Email requires an independently granted personal MCP credential');
 try{return textResult(await executeEmailIntegrationTool(name,args,{kind:'personal_mcp',org_id:ctx.org_id,user_id:ctx.user_id,token_id:ctx.token_id}));}
 catch{return errorResult('EMAIL_TOOL_UNAVAILABLE');}
}]));
