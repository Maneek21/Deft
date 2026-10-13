import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { readEmailKnowledgeSettings,writeEmailKnowledgeSettings,readEmailRelatedKnowledge,suppressEmailKnowledge } from '../lib/email-knowledge-runtime.js';
export function createEmailKnowledgeRoutes(ports:{verify(token:string):Promise<{id:string;org_id:string;sid:string;exp:number}>}){
 const app=new Hono();
 app.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
 const settings='/accounts/:accountId/knowledge-settings',related='/accounts/:accountId/messages/:messageId/knowledge';
 for(const path of [settings,related])app.use(path,bodyLimit({maxSize:16384,onError:c=>c.json({error:'Request too large',code:'EMAIL_KNOWLEDGE_INVALID'},413)}));
 for(const [method,path] of [['get',settings],['put',settings],['get',related],['put',related]] as const){
  app[method](path,async c=>{
   const token=/^Bearer ([^\s]+)$/u.exec(c.req.header('Authorization')??'')?.[1];if(!token)return c.json({error:'Sign in required',code:'EMAIL_AUTH_REQUIRED'},401);
   let session;try{session=await ports.verify(token);if(!session.id||!session.org_id||!session.sid||!Number.isFinite(session.exp)||session.exp*1000<=Date.now())throw Error();}catch{return c.json({error:'Sign in required',code:'EMAIL_AUTH_REQUIRED'},401);}
   const actor={user_id:session.id,web_session_id:session.sid,access_expires_at:session.exp*1000},scope={org_id:session.org_id,owner_user_id:session.id,account_id:c.req.param('accountId')!};
   try{
    if(new URL(c.req.url).search)throw new z.ZodError([]);
    if(method==='put'&&!/^application\/json(?:\s*;|$)/iu.test(c.req.header('Content-Type')??''))throw new z.ZodError([]);
    if(path===settings)return c.json(method==='get'?await readEmailKnowledgeSettings(actor,scope):await writeEmailKnowledgeSettings(actor,scope,await c.req.json()));
    const id=z.string().regex(/^mail_[a-f0-9]{64}$/u).parse(c.req.param('messageId'));
    return c.json(method==='get'?await readEmailRelatedKnowledge(actor,scope,id):await suppressEmailKnowledge(actor,scope,id,z.strictObject({suppressed:z.boolean()}).parse(await c.req.json()).suppressed));
   }catch(error){const message=error instanceof Error?error.message:'';
    const invalid=error instanceof z.ZodError||error instanceof SyntaxError,stale=message==='EMAIL_KNOWLEDGE_STALE',denied=/ACCESS_DENIED/u.test(message);
    return c.json({error:invalid?'Invalid knowledge settings':stale?'Settings changed. Refresh and retry.':denied?'Account or destination access changed.':'Knowledge capture is unavailable.',code:invalid?'EMAIL_KNOWLEDGE_INVALID':stale?'EMAIL_KNOWLEDGE_STALE':denied?'EMAIL_ACCESS_DENIED':'EMAIL_KNOWLEDGE_UNAVAILABLE'},invalid?400:stale?409:denied?403:503);
   }
  });
 }
 return app;
}
