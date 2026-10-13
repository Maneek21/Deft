import {formatMailboxList,parseMailboxList} from '../../../../packages/app-kit/src/mailbox-list';
import {emptyNativeDraft,parseNativeDraftContent,type NativeDraftContent} from './email-native-drafts';

export class NativeMailtoError extends Error {
 constructor(){super('This email link could not be opened. Check its addresses and try again.');this.name='NativeMailtoError';}
}
/** RFC6068 input is an editable compose suggestion, never a send instruction.
 * Decode once, preserve literal +, and ignore headers outside the visible draft.
 * Callers must choose a current account and never replace an existing draft. */
export function parseNativeMailto(raw:string):{content:NativeDraftContent;ignoredFields:string[]} {
 const invalid=():never=>{throw new NativeMailtoError();};
 if(typeof raw!=='string'||raw.length>65536||!/^mailto:/i.test(raw)||/[\u0000-\u0020\u007f-\u009f]/u.test(raw)||raw.includes('#'))return invalid();
 const decode=(value:string)=>{try{return decodeURIComponent(value);}catch{return invalid();}};
 const value=raw.slice(7),separator=value.indexOf('?'),path=separator<0?value:value.slice(0,separator),query=separator<0?'':value.slice(separator+1);
 const fields=new Map<string,string>(),ignored=new Set<string>();
 for(const part of query?query.split('&'):[]){
  const equals=part.indexOf('=');if(equals<1)return invalid();
  const name=decode(part.slice(0,equals)).toLowerCase(),text=decode(part.slice(equals+1));
  if(!/^[a-z][a-z0-9-]{0,63}$/u.test(name)||fields.has(name))return invalid();
  fields.set(name,text);if(!['to','cc','bcc','subject','body'].includes(name))ignored.add(name);
 }
 try{
  const content=emptyNativeDraft();
  for(const key of ['to','cc','bcc'] as const){
   const source=key==='to'?[decode(path),fields.get(key)??''].filter(Boolean).join(','):fields.get(key)??'';
   const parsed=parseMailboxList(source,{maxItems:32,allowEmpty:true});
   if(parsed.some(mailbox=>mailbox.displayName))return invalid();
   const seen=new Set<string>();content[key]=formatMailboxList(parsed.filter(mailbox=>{const id=mailbox.address.toLowerCase();if(seen.has(id))return false;seen.add(id);return true;}));
  }
  content.subject=fields.get('subject')??'';content.body=(fields.get('body')??'').replace(/\r\n/g,'\n');
  return {content:parseNativeDraftContent(content),ignoredFields:[...ignored]};
 }catch{return invalid();}
}

/** Fragment transport keeps the message suggestion out of HTTP access logs. */
export function nativeMailtoHandlerPath(){return '/email#compose=%s';}

/** Read only our exact fragment shape; no query-string fallback or double decoding. */
export function parseNativeMailtoFragment(hash:string):ReturnType<typeof parseNativeMailto>|null{
 if(!hash.startsWith('#compose='))return null;
 if(hash.length>196620)throw new NativeMailtoError();
 let raw:string;try{raw=decodeURIComponent(hash.slice(9));}catch{throw new NativeMailtoError();}
 return parseNativeMailto(raw);
}
