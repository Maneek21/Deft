import {and,asc,eq,gt,or} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {emailAccounts,emailTemplates} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {parseTrustedRichtextHtml as parseBasicRichtextHtml} from '@deft/app-kit/experience/core';
import {z} from 'zod';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import type {EmailScope} from './email-mailbox-service.js';

const schema={emailAccounts,emailTemplates};
export type EmailTemplateDatabase=Pick<NodePgDatabase<typeof schema>,'transaction'>;
export type EmailTemplateTransaction=Parameters<Parameters<EmailTemplateDatabase['transaction']>[0]>[0];
export type EmailTemplateGuard=(tx:unknown)=>Promise<void>;
const templateMarker=/\{\{[A-Za-z][A-Za-z0-9_]{0,63}\}\}/u;
function decodeHtmlEntities(value:string){
  return value.replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));|&(?:lbrace|lcub);/giu,(_match,hex:string|undefined,decimal:string|undefined)=>{
    if(hex)return String.fromCodePoint(Number.parseInt(hex,16));
    if(decimal)return String.fromCodePoint(Number.parseInt(decimal,10));
    return '{';
  });
}
function hasPlaceholderInHtmlTag(html:string){
  return [...html.matchAll(/<[^>]*>/gu)].some(match=>templateMarker.test(decodeHtmlEntities(match[0]!)));
}
export const EmailTemplateContentSchema=z.strictObject({
  title:z.string().trim().min(1).max(120).refine(value=>!/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
  subject:z.string().max(998).refine(value=>!/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)),
  body:z.string().max(256*1024).refine(value=>!/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)),
  body_html:z.string().max(256*1024),
}).superRefine((value,ctx)=>{
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>480*1024)ctx.addIssue({code:'custom',message:'Template exceeds size limit'});
  const markerStrings=[value.subject,value.body,value.body_html];
  const invalidPlaceholder=markerStrings.some(text=>{
    const tokens=[...text.matchAll(/\{\{[^{}]*\}\}/gu)].map(match=>match[0]);
    const remainder=text.replace(/\{\{[^{}]*\}\}/gu,'');
    return tokens.some(token=>!/^\{\{[A-Za-z][A-Za-z0-9_]{0,63}\}\}$/u.test(token))||remainder.includes('{{')||remainder.includes('}}');
  });
  if(invalidPlaceholder)ctx.addIssue({code:'custom',message:'Template placeholder syntax invalid'});
  if(hasPlaceholderInHtmlTag(value.body_html))ctx.addIssue({code:'custom',message:'Placeholders are allowed only in rich text nodes'});
  if(markerStrings.some(text=>/(?:https?:\/\/|mailto:|www\.)[^\s<>()]*\{\{[A-Za-z][A-Za-z0-9_]{0,63}\}\}[^\s<>()]*/iu.test(text)))
    ctx.addIssue({code:'custom',message:'Placeholders cannot occur in URL text'});
  if(value.body_html){
    try{const parsed=parseBasicRichtextHtml(value.body_html);if(parsed.plainText!==value.body)ctx.addIssue({code:'custom',message:'Rich and plain text must match'});}
    catch{ctx.addIssue({code:'custom',message:'Rich compose content is invalid'});}
  }
});
export type EmailTemplateContent=z.infer<typeof EmailTemplateContentSchema>;
export type EmailTemplate=Readonly<{template_id:string;account_id:string;revision:number;status:'active'|'archived';content:EmailTemplateContent;created_at:string;updated_at:string}>;
export type EmailTemplatePage=Readonly<{items:readonly EmailTemplate[];next_cursor:string|null;has_more:boolean}>;
const id=z.string().uuid(),revision=z.number().int().min(1).max(2147483647);
const ctx=(scope:EmailScope,templateId:string,rev:number)=>({...scope,kind:'template' as const,record_id:'template:'+templateId,revision:rev});
const cursorContext=(scope:EmailScope)=>({...scope,kind:'checkpoint' as const,record_id:'email-template-list',revision:0});
const Cursor=z.strictObject({schema_version:z.literal('deft.email_template_cursor.v1'),org_id:z.string().min(1).max(256),owner_user_id:z.string().min(1).max(256),
  account_id:z.string().min(1).max(256),updated_at:z.iso.datetime(),template_id:id,expires_at:z.number().finite()});
const scoped=(scope:EmailScope,templateId?:string)=>and(eq(emailTemplates.org_id,scope.org_id),eq(emailTemplates.owner_user_id,scope.owner_user_id),
  eq(emailTemplates.account_id,scope.account_id),templateId===undefined?undefined:eq(emailTemplates.template_id,templateId));
function materialize(crypto:EmailMailboxCrypto,scope:EmailScope,row:typeof emailTemplates.$inferSelect):EmailTemplate{
  const content=EmailTemplateContentSchema.parse(crypto.open(row.content_envelope,ctx(scope,row.template_id,row.revision)));
  return Object.freeze({template_id:row.template_id,account_id:scope.account_id,revision:row.revision,status:row.status,content,
    created_at:row.created_at.toISOString(),updated_at:row.updated_at.toISOString()});
}

/** Encrypted account-scoped template repository. Create replay is accepted only
 * for the exact same payload; all edits and archival use compare-and-swap. */
export class EmailTemplateStore{
  constructor(private readonly database:EmailTemplateDatabase,private readonly crypto:EmailMailboxCrypto,private readonly now=()=>new Date()){}
  async create(scope:EmailScope,templateId:string,raw:unknown,guard:EmailTemplateGuard,signal?:AbortSignal):Promise<EmailTemplate>{
    const content=EmailTemplateContentSchema.parse(raw);id.parse(templateId);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();
      const [existing]=await tx.select().from(emailTemplates).where(scoped(scope,templateId)).limit(1).for('update');
      if(existing){
        const result=materialize(this.crypto,scope,existing);
        if(existing.status!=='active'||existing.revision!==1||canonicalCapabilityJson(result.content)!==canonicalCapabilityJson(content))throw new Error('EMAIL_TEMPLATE_CONFLICT');
        await guard(tx);return result;
      }
      const now=this.now(),envelope=this.crypto.seal(content,ctx(scope,templateId,1));
      const [row]=await tx.insert(emailTemplates).values({...scope,template_id:templateId,revision:1,status:'active',content_envelope:envelope,created_at:now,updated_at:now})
        .onConflictDoNothing().returning();
      if(!row){
        const [raced]=await tx.select().from(emailTemplates).where(scoped(scope,templateId)).limit(1).for('update');
        if(!raced)throw new Error('EMAIL_TEMPLATE_CONFLICT');
        const replay=materialize(this.crypto,scope,raced);
        if(raced.status!=='active'||raced.revision!==1||canonicalCapabilityJson(replay.content)!==canonicalCapabilityJson(content))throw new Error('EMAIL_TEMPLATE_CONFLICT');
        await guard(tx);signal?.throwIfAborted();return replay;
      }
      await guard(tx);signal?.throwIfAborted();return materialize(this.crypto,scope,row);
    });
  }
  async read(scope:EmailScope,templateId:string,guard:EmailTemplateGuard,signal?:AbortSignal):Promise<EmailTemplate|null>{
    id.parse(templateId);signal?.throwIfAborted();return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailTemplates).where(and(scoped(scope,templateId),eq(emailTemplates.status,'active'))).limit(1);
      await guard(tx);signal?.throwIfAborted();return row?materialize(this.crypto,scope,row):null;
    },{isolationLevel:'repeatable read'});
  }
  async list(scope:EmailScope,cursor:string|null,limit:number,guard:EmailTemplateGuard,signal?:AbortSignal):Promise<EmailTemplatePage>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>50||cursor!==null&&(typeof cursor!=='string'||cursor.length>8192))throw new Error('EMAIL_TEMPLATE_INVALID');
    signal?.throwIfAborted();return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();let after:z.infer<typeof Cursor>|null=null;
      if(cursor!==null){try{if(!/^[A-Za-z0-9_-]+$/u.test(cursor))throw new Error();const bytes=Buffer.from(cursor,'base64url');
        if(bytes.toString('base64url')!==cursor)throw new Error();after=Cursor.parse(this.crypto.open(JSON.parse(bytes.toString('utf8')),cursorContext(scope)));
        if(after.org_id!==scope.org_id||after.owner_user_id!==scope.owner_user_id||after.account_id!==scope.account_id||after.expires_at<=this.now().getTime())throw new Error();
      }catch{throw new Error('EMAIL_TEMPLATE_INVALID');}}
      const afterFilter=after?or(gt(emailTemplates.updated_at,new Date(after.updated_at)),
        and(eq(emailTemplates.updated_at,new Date(after.updated_at)),gt(emailTemplates.template_id,after.template_id))):undefined;
      const rows=await tx.select().from(emailTemplates).where(and(scoped(scope),eq(emailTemplates.status,'active'),afterFilter))
        .orderBy(asc(emailTemplates.updated_at),asc(emailTemplates.template_id)).limit(limit+1);
      const selected=rows.slice(0,limit),hasMore=rows.length>limit,last=selected.at(-1);
      const next=hasMore&&last?Buffer.from(JSON.stringify(this.crypto.seal({schema_version:'deft.email_template_cursor.v1',...scope,
        updated_at:last.updated_at.toISOString(),template_id:last.template_id,expires_at:this.now().getTime()+15*60_000},cursorContext(scope)))).toString('base64url'):null;
      await guard(tx);signal?.throwIfAborted();return Object.freeze({items:Object.freeze(selected.map(row=>materialize(this.crypto,scope,row))),next_cursor:next,has_more:hasMore});
    },{isolationLevel:'repeatable read'});
  }
  async update(scope:EmailScope,templateId:string,expectedRevision:number,raw:unknown,guard:EmailTemplateGuard,signal?:AbortSignal):Promise<EmailTemplate>{
    const content=EmailTemplateContentSchema.parse(raw);id.parse(templateId);revision.parse(expectedRevision);signal?.throwIfAborted();
    return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailTemplates).where(scoped(scope,templateId)).limit(1).for('update');
      if(!row||row.status!=='active'||row.revision!==expectedRevision||row.revision>=2147483647)throw new Error('EMAIL_TEMPLATE_CONFLICT');
      const nextRevision=row.revision+1,now=this.now(),envelope=this.crypto.seal(content,ctx(scope,templateId,nextRevision));
      const [updated]=await tx.update(emailTemplates).set({revision:nextRevision,content_envelope:envelope,updated_at:now})
        .where(and(scoped(scope,templateId),eq(emailTemplates.revision,expectedRevision),eq(emailTemplates.status,'active'))).returning();
      if(!updated)throw new Error('EMAIL_TEMPLATE_CONFLICT');await guard(tx);signal?.throwIfAborted();return materialize(this.crypto,scope,updated);
    });
  }
  async archive(scope:EmailScope,templateId:string,expectedRevision:number,guard:EmailTemplateGuard,signal?:AbortSignal):Promise<EmailTemplate>{
    id.parse(templateId);revision.parse(expectedRevision);signal?.throwIfAborted();return this.database.transaction(async tx=>{
      await guard(tx);signal?.throwIfAborted();const [row]=await tx.select().from(emailTemplates).where(scoped(scope,templateId)).limit(1).for('update');
      if(!row||row.status!=='active'||row.revision!==expectedRevision||row.revision>=2147483647)throw new Error('EMAIL_TEMPLATE_CONFLICT');
      const nextRevision=row.revision+1,content=materialize(this.crypto,scope,row).content;
      const [updated]=await tx.update(emailTemplates).set({revision:nextRevision,status:'archived',
        content_envelope:this.crypto.seal(content,ctx(scope,templateId,nextRevision)),updated_at:this.now()})
        .where(and(scoped(scope,templateId),eq(emailTemplates.revision,expectedRevision),eq(emailTemplates.status,'active'))).returning();
      if(!updated)throw new Error('EMAIL_TEMPLATE_CONFLICT');await guard(tx);signal?.throwIfAborted();return materialize(this.crypto,scope,updated);
    });
  }
}
