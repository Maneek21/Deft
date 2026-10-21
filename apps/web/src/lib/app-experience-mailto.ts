import {formatAddressList,parseAddressList} from '../../../../packages/app-kit/src/structured-address';

/** Inert RFC6068 suggestion. Account selection, record creation and any effects
 * require their normal current human review; no caller-supplied sender is used. */
export type ExperienceMailtoSuggestion={to:string;cc:string;bcc:string;subject:string;plain:string;ignored_fields:string[]};
export class ExperienceMailtoError extends Error {
 constructor(){super('This email link could not be opened. Check its addresses and try again.');this.name='ExperienceMailtoError';}
}
const fail=():never=>{throw new ExperienceMailtoError();};
export function parseExperienceMailto(raw:string):ExperienceMailtoSuggestion{
 if(typeof raw!=='string'||raw.length>65536||!/^mailto:/i.test(raw)||/[\u0000-\u0020\u007f-\u009f]/u.test(raw)||raw.includes('#'))return fail();
 const decode=(value:string)=>{try{return decodeURIComponent(value);}catch{return fail();}};
 const value=raw.slice(7),separator=value.indexOf('?'),path=separator<0?value:value.slice(0,separator),query=separator<0?'':value.slice(separator+1);
 const fields=new Map<string,string>(),ignored=new Set<string>();
 for(const part of query?query.split('&'):[]){
  const equals=part.indexOf('=');if(equals<1)return fail();
  const name=decode(part.slice(0,equals)).toLowerCase(),text=decode(part.slice(equals+1));
  if(!/^[a-z][a-z0-9-]{0,63}$/u.test(name)||fields.has(name))return fail();
  fields.set(name,text);if(!['to','cc','bcc','subject','body'].includes(name))ignored.add(name);
 }
 try{
  const result:ExperienceMailtoSuggestion={to:'',cc:'',bcc:'',subject:fields.get('subject')??'',plain:(fields.get('body')??'').replace(/\r\n/g,'\n'),ignored_fields:[...ignored]};
  for(const key of ['to','cc','bcc'] as const){
   const source=key==='to'?[decode(path),fields.get(key)??''].filter(Boolean).join(','):fields.get(key)??'';
   const parsed=parseAddressList(source,{maxItems:32,allowEmpty:true});if(parsed.some(entry=>entry.displayName))return fail();
   const seen=new Set<string>();result[key]=formatAddressList(parsed.filter(entry=>{const id=entry.address.toLowerCase();if(seen.has(id))return false;seen.add(id);return true;}));
  }
  if(['to','cc','bcc'].reduce((count,key)=>count+parseAddressList(result[key as 'to'|'cc'|'bcc'],{allowEmpty:true,maxItems:32}).length,0)>32)return fail();
  if(result.subject.length>998||!result.subject.isWellFormed()||/[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(result.subject)
   ||result.plain.length>262144||!result.plain.isWellFormed()||/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(result.plain))return fail();
  return result;
 }catch{return fail();}
}
/** Deliberately no query-string fallback. Decode transport once, fields once. */
export function parseExperienceMailtoFragment(hash:string):ExperienceMailtoSuggestion|null{
 if(!hash.startsWith('#compose='))return null;if(hash.length>196620)throw new ExperienceMailtoError();
 let raw:string;try{raw=decodeURIComponent(hash.slice(9));}catch{throw new ExperienceMailtoError();}return parseExperienceMailto(raw);
}
