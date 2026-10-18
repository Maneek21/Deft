import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EmailMessageRecord, EmailScope } from './email-mailbox-service.js';
const identifier=z.string().min(1).max(256).refine(v=>!/[\r\n\0]/u.test(v));
export const EmailKnowledgePolicySchema=z.strictObject({enabled:z.boolean(),destination:z.strictObject({scope:z.enum(['user','space']),space_id:identifier.nullable()}),
 history_days:z.number().int().min(1).max(365),include_bulk:z.boolean(),excluded_senders:z.array(z.string().min(1).max(320)).max(50),excluded_folders:z.array(identifier).max(50),expected_revision:z.number().int().nonnegative().optional()})
 .refine(v=>(v.destination.scope==='user')===(v.destination.space_id===null));
export type EmailKnowledgePolicy=z.infer<typeof EmailKnowledgePolicySchema>;
export const defaultEmailKnowledgePolicy={enabled:false,destination:{scope:'user' as const,space_id:null},history_days:30,include_bulk:false,excluded_senders:[],excluded_folders:[]};
export const EmailKnowledgeExtractionSchema=z.strictObject({capture:z.boolean(),title:z.string().max(160),type:z.enum(['decision','procedure','resource','concept','fact']),content:z.string().max(10000),excerpt:z.string().max(1200)});
export type EmailKnowledgeExtraction=z.infer<typeof EmailKnowledgeExtractionSchema>;
export const emailKnowledgeHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Quoted history and signatures do not become fresh observation evidence. */
export function normalizeEmailKnowledgeBody(text:string):string {
 const lines=text.replace(/\r\n?/gu,'\n').split('\n'),kept:string[]=[];
 for(const line of lines){if(/^\s*(?:On .+wrote:|From:|-----Original Message-----|--\s*$)/iu.test(line))break;if(/^\s*>/u.test(line))continue;kept.push(line);}
 return kept.join('\n').replace(/\n{3,}/gu,'\n\n').trim();
}
export function emailKnowledgeEligibility(record:EmailMessageRecord,policy:EmailKnowledgePolicy,body?:string):string|null{
 const folders=record.folders.map(v=>v.toLowerCase());
 if(folders.some(v=>['spam','junk','trash','deleted','drafts'].includes(v)||policy.excluded_folders.map(x=>x.toLowerCase()).includes(v)))return 'EXCLUDED_FOLDER';
 const sender=String(record.data.from_address??record.data.from??record.data.sender??'').toLowerCase();
 if(policy.excluded_senders.some(v=>sender.includes(v.toLowerCase())))return 'EXCLUDED_SENDER';
 const text=String(record.data.subject??'')+'\n'+(body??String(record.data.preview??record.data.snippet??''));
 if(/\b(?:one[- ]time (?:password|code)|verification code|password reset|reset your password|security code|api[_ -]?key|private key|access token|secret key|recovery codes)\b/iu.test(text)||/\b(?:sk-[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/u.test(text))return 'SENSITIVE';
 if(!policy.include_bulk&&(/\b(?:unsubscribe|view in browser|limited time offer|sale ends|newsletter)\b/iu.test(text)||record.data.is_bulk===true))return 'BULK';
 if(body!==undefined&&(body.length<40||/^(?:thanks?|thank you|got it|noted|okay|ok|sounds good)[.!\s]*$/iu.test(body)))return 'LOW_SIGNAL';
 return null;
}
export function emailKnowledgeThreadKey(scope:EmailScope,record:EmailMessageRecord,conversationId?:string):string{
 // Provider identity, never subject, establishes thread lineage. Fall back to
 // one message rather than merging unrelated same-subject conversations.
 return emailKnowledgeHash([scope,record.provider_source.provider,conversationId||record.data.conversation_id||record.data.thread_id||record.provider_source.thread_id||record.logical_message_id]);
}
export function validateEmailKnowledgeExtraction(raw:unknown,body:string){
 const result=EmailKnowledgeExtractionSchema.parse(raw);
 if(result.capture&&(!result.title.trim()||!result.content.trim()||result.excerpt.length<20||!body.includes(result.excerpt)))throw new Error('EMAIL_KNOWLEDGE_EVIDENCE_INVALID');
 return result;
}
