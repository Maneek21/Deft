import {Hono} from 'hono';
import {resourceSyncWebAuthority} from '../lib/app-resource-sync-web-authority.js';
import {openNativeAdoptionCitation} from '../lib/email-native-adoption-citations.js';
import {z} from 'zod';
import {nativeAdoptionRecoveryReader} from '../lib/email-native-adoption-recovery.js';
/** Mount at /api/email-adoption. This route only resolves current read access. */
export function createNativeAdoptionSourceRoutes(){const app=new Hono();
 app.get('/source/:sourceId',async c=>{c.header('Cache-Control','no-store');try{
  if(new URL(c.req.url).search)throw Error();const auth=await resourceSyncWebAuthority(c.req.header('authorization'));
  const caller={org_id:auth.actor.org_id,user_id:auth.actor.actor_id,kind:'human' as const,principal_id:auth.web_session.sid,access_expires_at:auth.web_session.expires_at};
  return c.json({href:await openNativeAdoptionCitation(caller,c.req.param('sourceId'),auth.guard)});
 }catch{return c.json({code:'APP_ACCESS_DENIED'},403);}});
 const Query=z.strictObject({cursor:z.string().min(1).max(8192).optional(),folder:z.string().min(1).max(256).optional()});
 app.get('/recovery/:accountId/:kind',async c=>{c.header('Cache-Control','no-store');try{
  const query=Query.parse(c.req.query()),kind=z.enum(['drafts','mailbox','history','send-history']).parse(c.req.param('kind'));
  if(kind!=='mailbox'&&query.folder)throw Error();const auth=await resourceSyncWebAuthority(c.req.header('authorization'));
  const reader=await nativeAdoptionRecoveryReader({org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at},c.req.param('accountId'),auth.guard);
  const result=kind==='drafts'?await reader.drafts(query.cursor??null):kind==='history'?await reader.history(query.cursor??null):kind==='send-history'?await reader.sendHistory(query.cursor?z.string().uuid().parse(query.cursor):null):await reader.mailbox(query.folder??'all',query.cursor??null);
  await reader.check();return c.json(result);
 }catch{return c.json({code:'APP_ACCESS_DENIED'},403);}});
 app.get('/recovery/:accountId/:kind/:recordId',async c=>{c.header('Cache-Control','no-store');try{
  if(new URL(c.req.url).search)throw Error();const kind=z.enum(['drafts','messages']).parse(c.req.param('kind'));
  const id=(kind==='drafts'?z.string().uuid():z.string().regex(/^mail_[a-f0-9]{64}$/u)).parse(c.req.param('recordId'));
  const auth=await resourceSyncWebAuthority(c.req.header('authorization'));
  const reader=await nativeAdoptionRecoveryReader({org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at},c.req.param('accountId'),auth.guard);
  const result=kind==='drafts'?await reader.draft(id):await reader.message(id);await reader.check();return c.json(result);
 }catch{return c.json({code:'APP_ACCESS_DENIED'},403);}});
 app.get('/recovery/:accountId/files/:draftId/:fileId',async c=>{c.header('Cache-Control','no-store');let bytes:Buffer|undefined;try{
  if(new URL(c.req.url).search)throw Error();const draftId=z.string().uuid().parse(c.req.param('draftId')),fileId=z.string().uuid().parse(c.req.param('fileId'));
  const auth=await resourceSyncWebAuthority(c.req.header('authorization'));
  const reader=await nativeAdoptionRecoveryReader({org_id:auth.actor.org_id,user_id:auth.actor.actor_id,sid:auth.web_session.sid,access_expires_at:auth.web_session.expires_at},c.req.param('accountId'),auth.guard);
  const file=await reader.file(draftId,fileId);bytes=file.bytes;await reader.check();
  return new Response(new Uint8Array(bytes),{headers:{'Cache-Control':'no-store','Content-Type':file.media_type,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'X-Content-Type-Options':'nosniff'}});
 }catch{return c.json({code:'APP_ACCESS_DENIED'},403);}finally{bytes?.fill(0);}});
 return app;}
