import {createAppIntegrationCaptureRoutes} from './app-integration-capture.js';
import {getAppIntegrationCaptureRuntime} from '../lib/app-integration-capture-service.js';
import {resourceSyncWebAuthority} from '../lib/app-resource-sync-web-authority.js';
/** Actual web session/current membership admission, never actor fields from JSON. */
export function createMountedAppIntegrationCaptureRoutes(){return createAppIntegrationCaptureRoutes({
 authenticate:async request=>{const auth=await resourceSyncWebAuthority(request.headers.get('authorization')??undefined);return {org_id:auth.actor.org_id,user_id:auth.actor.actor_id,kind:'human',principal_id:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};},
 settings:async(c,t)=>(await getAppIntegrationCaptureRuntime()).settings(c,t),
 write:async(c,t,p)=>(await getAppIntegrationCaptureRuntime()).write(c,t,p),
 related:async(c,t)=>(await getAppIntegrationCaptureRuntime()).related(c,t),
 open:async(c,id)=>(await getAppIntegrationCaptureRuntime()).open(c,id),
});}
