import {AppDataRuntimeRequestSchema,AppDataResultSchema,canonicalAppDataJson} from '../../../../packages/app-kit/src/app-data.js';
import type {AppDataRuntimeRequest} from '../../../../packages/app-kit/src/app-data.js';
import type {AppIntegrationSourceTarget,AppIntegrationSourcePurpose} from '../../../../packages/app-kit/src/app-integration-source.js';
import {appIntegrationSourceDigest,type AppIntegrationSourceCaller} from './app-integration-source.js';

/** Uses the existing public data protocol. The authority lane owns journal +
 * callback minting for the exact principal/policy; no fabricated browser SID. */
export function createAppIntegrationSourceDispatcher(ports:{
 mint(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:AppIntegrationSourcePurpose,
  operation:'resource_read_presentation'|'resource_read_metadata',input:Record<string,string>,max_ms:30000):Promise<AppDataRuntimeRequest>;
 dispatch(request:AppDataRuntimeRequest,signal:AbortSignal):Promise<{result?:unknown}>;
},content:'presentation'|'metadata'='presentation'){
 return async(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceTarget,purpose:AppIntegrationSourcePurpose,signal?:AbortSignal)=>{
  const input={store_key:target.store_key,resource_key:target.ref.resource_key,record_id:target.ref.record_id,content_digest:target.ref.content_digest};
  const operation=content==='metadata'||purpose==='notification_projection'?'resource_read_metadata':'resource_read_presentation';
  const request=AppDataRuntimeRequestSchema.parse(await ports.mint(caller,target,purpose,operation,input,30000));
  const expiry=Date.parse(request.expires_at);
  if(request.operation!==operation||canonicalAppDataJson(request.input)!==canonicalAppDataJson(input)
   ||request.scope.installation_id!==target.installation_id||request.scope.org_id!==caller.org_id||request.scope.owner_user_id!==caller.user_id
   ||request.scope.resource_binding_id!==target.resource_binding_id||request.scope.resource_key!==target.ref.resource_key
   ||request.connection.account_ref!==target.account_ref||expiry<=Date.now()||expiry>Date.now()+30000)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),Math.max(1,expiry-Date.now()));
  try{
   signal?.throwIfAborted();const reply=await ports.dispatch(request,controller.signal);controller.signal.throwIfAborted();
   const result=AppDataResultSchema.parse(reply.result);
   if(result.request_id!==request.request_id||result.operation!==request.operation||result.input_digest!==appIntegrationSourceDigest({operation:request.operation,input})
    ||result.outcome!=='completed'||!result.resource||operation==='resource_read_presentation'&&!result.presentation)throw new Error('APP_INTEGRATION_SOURCE_CHANGED_OR_DENIED');
   return {resource:result.resource,presentation:operation==='resource_read_metadata'?{}:result.presentation!};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 };
}
