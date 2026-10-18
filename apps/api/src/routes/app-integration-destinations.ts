import {appIntegrationJson,appIntegrationPrivateLimits} from '../lib/app-integration-http.js';
import {Hono} from 'hono';
import {z} from 'zod';
import {getAppIntegrationDestinationRuntime} from '../lib/app-integration-destination-runtime.js';
import type {AppIntegrationSourceCaller} from '../lib/app-integration-source.js';
import {getAppIntegrationCalendar} from '../lib/app-integration-calendar.js';
import {AppIntegrationSourcePendingError} from '../lib/app-integration-source-projection.js';
export function appIntegrationDestinationFailure(error:unknown){
 if(error instanceof AppIntegrationSourcePendingError)return {status:409 as const,body:{error:'This source is still syncing. Wait a moment, then check source availability again.',code:'APP_INTEGRATION_SOURCE_PENDING'}};
 return {status:error instanceof z.ZodError?400 as const:403 as const,body:{error:'Source or destination changed or is unavailable',code:error instanceof z.ZodError?'APP_INTEGRATION_DESTINATION_INVALID':'APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED'}};
}
/** Mounted by root behind ordinary authMiddleware. Public bodies never supply
 * principal IDs, access expiry, account custody or authorization versions. */
export function appIntegrationDestinationRoutes(caller:(c:import('hono').Context)=>Promise<AppIntegrationSourceCaller>){
 const routes=new Hono();appIntegrationPrivateLimits(routes);
 const run=(operation:(c:import('hono').Context,actor:AppIntegrationSourceCaller)=>Promise<unknown>)=>async(c:import('hono').Context)=>{try{const actor=await caller(c);if(actor.kind!=='human')throw Error('APP_INTEGRATION_DESTINATION_CHANGED_OR_DENIED');return c.json(await operation(c,actor));}catch(error){const failure=appIntegrationDestinationFailure(error);return c.json(failure.body,failure.status);}};
 routes.post('/review',run(async(c,actor)=>(await getAppIntegrationDestinationRuntime()).review(actor,await appIntegrationJson(c),c.req.raw.signal)));
 routes.post('/commit',run(async(c,actor)=>(await getAppIntegrationDestinationRuntime()).commit(actor,await appIntegrationJson(c),c.req.raw.signal)));
 routes.get('/status/:requestId',run(async(c,actor)=>(await getAppIntegrationDestinationRuntime()).status(actor,z.uuid().parse(c.req.param('requestId')),c.req.raw.signal)));
 routes.get('/attention/source/:attentionItemId',run(async(c,actor)=>({href:await (await getAppIntegrationDestinationRuntime()).openAttention(actor,z.uuid().parse(c.req.param('attentionItemId')))})));
 routes.get('/source/:requestId',run(async(c,actor)=>({href:await (await getAppIntegrationDestinationRuntime()).openSource(actor,z.uuid().parse(c.req.param('requestId')))})));
 routes.post('/calendar/review',run(async(c,actor)=>(await getAppIntegrationCalendar()).review(actor,await appIntegrationJson(c),c.req.raw.signal)));
 routes.post('/calendar/invitations',run(async(c,actor)=>(await getAppIntegrationCalendar()).inspect(actor,await appIntegrationJson(c),c.req.raw.signal)));
 routes.post('/calendar/commit',run(async(c,actor)=>(await getAppIntegrationCalendar()).commit(actor,await appIntegrationJson(c),c.req.raw.signal)));
 routes.get('/calendar/status/:requestId',run(async(c,actor)=>(await getAppIntegrationCalendar()).status(actor,z.uuid().parse(c.req.param('requestId')),c.req.raw.signal)));
 return routes;
}
