import {appIntegrationJson,appIntegrationPrivateLimits} from '../lib/app-integration-http.js';
import {Hono,type Context} from 'hono';import type {AppIntegrationSourceCaller} from '../lib/app-integration-source.js';import {getAppIntegrationNotificationSettings} from '../lib/app-integration-notification-service.js';
export function appIntegrationNotificationRoutes(caller:(c:Context)=>Promise<AppIntegrationSourceCaller>){const routes=new Hono();appIntegrationPrivateLimits(routes);
 const handle=(mode:'read'|'save')=>async(c:Context)=>{try{const actor=await caller(c);if(actor.kind!=='human')throw Error();return c.json(await getAppIntegrationNotificationSettings()[mode](actor,await appIntegrationJson(c)));}catch{return c.json({error:'Notification settings changed or are unavailable',code:'APP_INTEGRATION_NOTIFICATION_CHANGED_OR_DENIED'},403);}};
 routes.post('/settings/read',handle('read'));routes.post('/settings',handle('save'));return routes;
}
