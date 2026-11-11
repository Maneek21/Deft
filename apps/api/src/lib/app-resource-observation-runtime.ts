import {ResourceObservationAuthorityRequestSchema} from '../../../../packages/app-kit/src/resource-observation.js';
import {getAppAttachmentRuntime} from './app-attachment-runtime.js';
import {observationDenied} from './app-resource-observation-authority.js';
/** Existing v3 credential and claim, separately versioned read-only projection.
 * It never mints a session, admits a Run or invokes a provider. The heartbeat,
 * every authority check and the projection share one runner transaction. */
export async function resourceObservationRuntimeAuthority(raw:unknown,authorization:string|undefined){
 const input=ResourceObservationAuthorityRequestSchema.parse(raw),token=/^AppRuntime ([A-Za-z0-9_-]{32,512})$/u.exec(authorization??'')?.[1];
 if(!token||Date.parse(input.expires_at)<=Date.now()||Date.parse(input.expires_at)>Date.now()+30000)throw observationDenied();
 const runtime=await getAppAttachmentRuntime();
 const result=await runtime.channel.resourceObservationAuthority(input,token);
 if(!result)throw observationDenied();
 return result;
}
