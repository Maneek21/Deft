import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {AppIntegrationCapturePolicyInputSchema,AppIntegrationSourceIdentitySchema,type AppIntegrationSourceIdentity} from '../../../../packages/app-kit/src/app-integration-source.js';
import type {AppIntegrationSourceCaller} from '../lib/app-integration-source.js';
/** Root mounts under existing authenticated App routes. Host caller factories,
 * current source grants and destination checks remain required service ports. */
export function createAppIntegrationCaptureRoutes(ports:{
 authenticate(request:Request):Promise<AppIntegrationSourceCaller>;
 settings(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceIdentity):Promise<unknown>;
 write(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceIdentity,policy:unknown):Promise<unknown>;
 related(caller:AppIntegrationSourceCaller,target:AppIntegrationSourceIdentity):Promise<unknown>;
 open(caller:AppIntegrationSourceCaller,source_id:string):Promise<string>;
}){
 const app=new Hono();app.use('*',bodyLimit({maxSize:16384,onError:c=>c.json({code:'APP_INTEGRATION_INVALID'},413)}));
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 for(const name of ['settings','write','related'] as const)app.post('/'+name,async c=>{
  try{
   const caller=await ports.authenticate(c.req.raw);if(caller.kind!=='human')return c.json({code:'APP_ACCESS_DENIED'},403);
   if(new URL(c.req.url).search||!/^application\/json(?:\s*;|$)/iu.test(c.req.header('Content-Type')??''))return c.json({code:'APP_INTEGRATION_INVALID'},400);
   const raw=await c.req.json();
   if(name==='write'){const value=z.strictObject({source:AppIntegrationSourceIdentitySchema,policy:AppIntegrationCapturePolicyInputSchema}).parse(raw);return c.json(await ports.write(caller,value.source,value.policy));}
   const value=z.strictObject({source:AppIntegrationSourceIdentitySchema}).parse(raw);return c.json(await ports[name](caller,value.source));
  }catch(error){const code=error instanceof Error?error.message:'';return c.json({code:error instanceof z.ZodError||error instanceof SyntaxError?'APP_INTEGRATION_INVALID':code==='APP_INTEGRATION_CAPTURE_STALE'?code:'APP_ACCESS_DENIED'},error instanceof z.ZodError||error instanceof SyntaxError?400:code==='APP_INTEGRATION_CAPTURE_STALE'?409:403);}
 });
 app.get('/source/:sourceId',async c=>{try{const caller=await ports.authenticate(c.req.raw);if(caller.kind!=='human'||new URL(c.req.url).search)throw Error();
  const href=await ports.open(caller,z.uuid().parse(c.req.param('sourceId')));if(!href.startsWith('/')||href.startsWith('//')||/[\\\u0000-\u001f\u007f]/u.test(href))throw Error();return c.json({href});
 }catch{return c.json({code:'APP_ACCESS_DENIED'},403);}});
 return app;
}
