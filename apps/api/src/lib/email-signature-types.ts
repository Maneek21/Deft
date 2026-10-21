import {createHash} from 'node:crypto';
import {z} from 'zod';
import {EmailTemplateContentSchema} from './email-template-store.js';

const Text=z.string().max(2048).refine(v=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v));
const Html=z.string().max(16_384);
export const SignatureEntrySchema=z.strictObject({address:z.string().email().max(320),plain:Text,html:Html,placement:z.enum(['new','reply','both','none'])});
export const SignaturePreferencesSchema=z.strictObject({identities:z.array(SignatureEntrySchema).max(32)}).superRefine((v,ctx)=>{
 const seen=new Set<string>();for(const item of v.identities){const key=normalize(item.address);if(seen.has(key))ctx.addIssue({code:'custom',message:'Duplicate sender identity'});seen.add(key);
  if(item.html){try{const {parseBasicRichtextHtml}=requireSafeCompose();const parsed=parseBasicRichtextHtml(item.html,{maxCharacters:16_384,maxBytes:65_536});
   if(!item.plain||parsed.plainText!==item.plain)ctx.addIssue({code:'custom',message:'Signature rich and plain text must match'});
  }catch{ctx.addIssue({code:'custom',message:'Signature HTML is invalid'});}}
 }
 if(Buffer.byteLength(JSON.stringify(v),'utf8')>64*1024)ctx.addIssue({code:'custom',message:'Signature preferences exceed size limit'});
});
// Kept synchronous to match the existing safe compose parser.
import {parseTrustedRichtextHtml as parseBasicRichtextHtml} from '@deft/app-kit/experience/core';
function requireSafeCompose(){return {parseBasicRichtextHtml};}
export type SignaturePreferences=Readonly<z.infer<typeof SignaturePreferencesSchema>>;
export const normalize=(address:string)=>address.trim().toLocaleLowerCase('en-US');
export const signatureIdentityKey=(address:string)=>createHash('sha256').update(normalize(address),'utf8').digest('hex');
export type SignatureAvailability=Readonly<{address:string;identity_key:string;current:boolean}>;
export type SignatureIdentityAvailability=Readonly<{account_id:string;org_id:string;owner_user_id:string;verified_sender_identities:readonly string[]}>;
export function signatureAvailability(identity:SignatureIdentityAvailability|undefined,preferences:SignaturePreferences){
 const current=new Set(identity?.verified_sender_identities.map(normalize)??[]);
 const saved=preferences.identities.map(entry=>({address:entry.address,identity_key:signatureIdentityKey(entry.address),current:current.has(normalize(entry.address))}));
 return Object.freeze({available:identity?Object.freeze(identity.verified_sender_identities.map(address=>({address,identity_key:signatureIdentityKey(address)}))):null,
  saved:Object.freeze(saved)});
}
