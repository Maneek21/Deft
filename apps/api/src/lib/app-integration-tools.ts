import {AppIntegrationToolRequestSchema,parseAppIntegrationToolDeclaredInput,type AppIntegrationToolDeclaration,type AppIntegrationToolOperation} from '../../../../packages/app-kit/src/app-integration-tools.js';
import type {AppIntegrationToolCaller,AppIntegrationToolTarget} from './app-integration-tool-authority.js';
export function parseAppIntegrationToolInput(declaration:AppIntegrationToolDeclaration,input:Record<string,unknown>){
 // Existing Zod JSON Schema interpreter applies signed App defaults. The
 // resulting exact value is what the original invocation pins and Runtime sees.
 return parseAppIntegrationToolDeclaredInput(declaration,input);
}
export interface AppIntegrationToolPorts {
 declarations(caller:AppIntegrationToolCaller,installationId:string):Promise<readonly AppIntegrationToolDeclaration[]>;
 validateInput(declaration:AppIntegrationToolDeclaration,input:Record<string,unknown>):void;
 /** Derives exact stable account from current declared input, never address. */
 target(caller:AppIntegrationToolCaller,declaration:AppIntegrationToolDeclaration,input:Record<string,unknown>,installationId:string):Promise<AppIntegrationToolTarget>;
 authorize(caller:AppIntegrationToolCaller,target:AppIntegrationToolTarget,operation:AppIntegrationToolOperation):Promise<{recheck():Promise<unknown>}>;
 catalog(caller:AppIntegrationToolCaller,declaration:AppIntegrationToolDeclaration):Promise<unknown>;
 data(caller:AppIntegrationToolCaller,target:AppIntegrationToolTarget,declaration:AppIntegrationToolDeclaration,input:Record<string,unknown>,requestId:string,signal?:AbortSignal):Promise<unknown>;
 /** Existing prepared record/resource + exact trusted human Run review only.
  * No reserve/claim/provider effect is exposed by tool invocation itself. */
 review(caller:AppIntegrationToolCaller,target:AppIntegrationToolTarget,declaration:AppIntegrationToolDeclaration,input:Record<string,unknown>,requestId:string):Promise<unknown>;
 status(caller:AppIntegrationToolCaller,target:AppIntegrationToolTarget,declaration:AppIntegrationToolDeclaration,input:Record<string,unknown>,requestId:string):Promise<unknown>;
}
export function createAppIntegrationTools(ports:AppIntegrationToolPorts){return Object.freeze({
 async execute(caller:AppIntegrationToolCaller,raw:unknown,signal?:AbortSignal){
  let request=AppIntegrationToolRequestSchema.parse(raw);signal?.throwIfAborted();
  const rows=(await ports.declarations(caller,request.installation_id)).filter(row=>row.key===request.tool_key);
  if(rows.length!==1)throw Error('APP_INTEGRATION_TOOL_UNAVAILABLE');const declaration=rows[0]!;
  request={...request,input:parseAppIntegrationToolInput(declaration,request.input)};
  ports.validateInput(declaration,request.input);
  if(declaration.mode==='catalog')return ports.catalog(caller,declaration);
  const target=await ports.target(caller,declaration,request.input,request.installation_id);
  if(target.installation_id!==request.installation_id||target.store_key!==declaration.store_key)throw Error('APP_INTEGRATION_TOOL_ACCESS_DENIED');
  const authority=await ports.authorize(caller,target,declaration.operation);await authority.recheck();signal?.throwIfAborted();
  const result=declaration.mode==='data'?await ports.data(caller,target,declaration,request.input,request.request_id,signal):
   declaration.mode==='review'?await ports.review(caller,target,declaration,request.input,request.request_id):
   await ports.status(caller,target,declaration,request.input,request.request_id);
  signal?.throwIfAborted();await authority.recheck();return result;
 }
});}
