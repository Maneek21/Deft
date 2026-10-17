import {parseNativeSafeComposeHtml as parseSafeComposeHtml} from '@deft/app-kit/experience';
import {z} from 'zod';
import type {EmailActor,EmailAuthority,EmailCapability,EmailScope} from './email-mailbox-service.js';
import {EmailTemplateContentSchema,EmailTemplateStore,type EmailTemplate,type EmailTemplatePage} from './email-template-store.js';

const Id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
const Scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id}),Actor=z.strictObject({user_id:Id,web_session_id:Id,access_expires_at:z.number().finite()});
const Uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const Placeholders=z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  z.string().max(8192).refine(value=>!value.includes('{{')&&!value.includes('}}'))).refine(value=>Object.keys(value).length<=64);
export class EmailTemplateError extends Error{
  constructor(readonly code:'EMAIL_TEMPLATE_ACCESS_DENIED'|'EMAIL_TEMPLATE_INVALID'|'EMAIL_TEMPLATE_CONFLICT'|'EMAIL_TEMPLATE_NOT_FOUND'|'EMAIL_TEMPLATE_UNAVAILABLE'){
    super(code);this.name='EmailTemplateError';
  }
}
const denied=()=>new EmailTemplateError('EMAIL_TEMPLATE_ACCESS_DENIED');
const sameScope=(a:EmailScope,b:EmailScope)=>a.org_id===b.org_id&&a.owner_user_id===b.owner_user_id&&a.account_id===b.account_id;
const escapeHtml=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const names=(value:string)=>[...value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/gu)].map(match=>match[1]!);
function substitute(value:string,replacements:Readonly<Record<string,string>>,html=false){
  return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/gu,(marker,name:string)=>Object.hasOwn(replacements,name)?(html?escapeHtml(replacements[name]!):replacements[name]!):marker);
}
function substituteHtmlText(html:string,replacements:Readonly<Record<string,string>>){
  parseSafeComposeHtml(html);
  return html.split(/(<[^>]*>)/gu).map(part=>{
    if(part.startsWith('<')){
      if(/\{\{[A-Za-z][A-Za-z0-9_]{0,63}\}\}/u.test(part))throw new EmailTemplateError('EMAIL_TEMPLATE_INVALID');
      return part;
    }
    return substitute(part,replacements,true);
  }).join('');
}
export function renderEmailTemplate(contentRaw:unknown,replacementsRaw:unknown){
  const content=EmailTemplateContentSchema.parse(contentRaw),replacements=Placeholders.parse(replacementsRaw);
  const body_html=substituteHtmlText(content.body_html,replacements);
  const body=body_html?parseSafeComposeHtml(body_html).plainText:substitute(content.body,replacements);
  const rendered=EmailTemplateContentSchema.parse({...content,subject:substitute(content.subject,replacements),body,body_html});
  if(rendered.body_html&&parseSafeComposeHtml(rendered.body_html).plainText!==rendered.body)
    throw new EmailTemplateError('EMAIL_TEMPLATE_INVALID');
  const missing=[...new Set([rendered.subject,rendered.body,rendered.body_html].flatMap(names))].sort();
  return Object.freeze({subject:rendered.subject,body:rendered.body,body_html:rendered.body_html,unresolved_placeholders:Object.freeze(missing)});
}

/** Owner-bound template controls reuse native human draft authority. They do
 * not create drafts, resolve identities, preserve files, or send messages. */
export class EmailTemplateService{
  constructor(private readonly authority:EmailAuthority,private readonly store:EmailTemplateStore,private readonly now=Date.now){}
  private async authorize(actorRaw:EmailActor,scopeRaw:EmailScope,signal?:AbortSignal){
    let actor:EmailActor,scope:EmailScope;try{actor=Object.freeze(Actor.parse(actorRaw));scope=Object.freeze(Scope.parse(scopeRaw));}catch{throw denied();}
    if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw denied();
    let capability:EmailCapability;try{capability=structuredClone(await this.authority.current(actor,scope,'human_draft',undefined,signal));}
    catch(error){if(signal?.aborted)throw error;throw denied();}
    const check=(value:EmailCapability)=>{if(!sameScope(scope,value.scope)||!Number.isFinite(value.expires_at)||value.expires_at<=this.now()
      ||!value.resource_binding_id||!value.authority_version||value.resource_binding_id!==capability.resource_binding_id
      ||value.authority_version!==capability.authority_version)throw denied();};
    check(capability);const guard=async(tx:unknown)=>{signal?.throwIfAborted();check(await this.authority.current(actor,scope,'human_draft',tx,signal));};
    return {actor,scope,guard};
  }
  private map(error:unknown,signal?:AbortSignal):EmailTemplateError{
    if(signal?.aborted)throw error;if(error instanceof EmailTemplateError)return error;
    const message=error&&typeof error==='object'&&'message'in error?String(error.message):'';
    if(message==='EMAIL_TEMPLATE_CONFLICT'||message.includes('unique constraint'))return new EmailTemplateError('EMAIL_TEMPLATE_CONFLICT');
    if(message==='EMAIL_TEMPLATE_INVALID'||error instanceof z.ZodError)return new EmailTemplateError('EMAIL_TEMPLATE_INVALID');
    if(message==='EMAIL_TEMPLATE_NOT_FOUND')return new EmailTemplateError('EMAIL_TEMPLATE_NOT_FOUND');
    return new EmailTemplateError('EMAIL_TEMPLATE_UNAVAILABLE');
  }
  async create(actor:EmailActor,scope:EmailScope,id:string,content:unknown,signal?:AbortSignal){
    const {scope:bound,guard}=await this.authorize(actor,scope,signal);try{return await this.store.create(bound,Uuid.parse(id),content,guard,signal);}
    catch(error){throw this.map(error,signal);}
  }
  async read(actor:EmailActor,scope:EmailScope,id:string,signal?:AbortSignal):Promise<EmailTemplate>{
    const {scope:bound,guard}=await this.authorize(actor,scope,signal);try{const value=await this.store.read(bound,Uuid.parse(id),guard,signal);
      if(!value)throw new EmailTemplateError('EMAIL_TEMPLATE_NOT_FOUND');return value;}catch(error){throw this.map(error,signal);}
  }
  async list(actor:EmailActor,scope:EmailScope,cursor:string|null,limit:number,signal?:AbortSignal):Promise<EmailTemplatePage>{
    const {scope:bound,guard}=await this.authorize(actor,scope,signal);try{return await this.store.list(bound,cursor,limit,guard,signal);}catch(error){throw this.map(error,signal);}
  }
  async update(actor:EmailActor,scope:EmailScope,id:string,expectedRevision:number,content:unknown,signal?:AbortSignal){
    const {scope:bound,guard}=await this.authorize(actor,scope,signal);try{return await this.store.update(bound,Uuid.parse(id),expectedRevision,content,guard,signal);}catch(error){throw this.map(error,signal);}
  }
  async archive(actor:EmailActor,scope:EmailScope,id:string,expectedRevision:number,signal?:AbortSignal){
    const {scope:bound,guard}=await this.authorize(actor,scope,signal);try{return await this.store.archive(bound,Uuid.parse(id),expectedRevision,guard,signal);}catch(error){throw this.map(error,signal);}
  }
  async render(actor:EmailActor,scope:EmailScope,id:string,replacements:unknown,signal?:AbortSignal){
    const template=await this.read(actor,scope,id,signal);try{return renderEmailTemplate(template.content,replacements);}catch(error){throw this.map(error,signal);}
  }
}
