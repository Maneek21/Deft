import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const limit=(reason)=>({status:'unsupported',parts:[],reason});
/** Uses the already bounded/decoded mailparser result. No MIME/provider fetch,
 * Calendar effect, URL load or charset guessing happens in this helper. */
export function calendarPartsFromParsed(parsed,sourceDigest){
 const selected=[];
 for(const [index,part] of (parsed.attachments??[]).entries()){
  if(['text/calendar','application/ics','application/icalendar'].includes(String(part.contentType).toLowerCase())||/\.ics$/iu.test(String(part.filename??'')))selected.push({index,part});
 }
 const top=parsed.headers?.get('content-type');let body;
 if(!selected.length&&String(top?.value??'').toLowerCase()==='text/calendar'&&typeof parsed.text==='string'){
  // mailparser has decoded this text already. Retain the declared charset
  // eligibility, and clear our temporary UTF8 copy on every exit.
  body=Buffer.from(parsed.text,'utf8');selected.push({index:'body',part:{content:body,headers:new Map([['content-type',top]])}});
 }
 try{
 if(selected.length>8)return limit('CALENDAR_PART_LIMIT');
 let total=0;const parts=[];
 for(const {index,part} of selected){
  const bytes=part.content,header=part.headers?.get('content-type'),charset=String(header?.params?.charset??'utf-8').toLowerCase();
  if(!['utf-8','utf8','us-ascii'].includes(charset))return limit('CALENDAR_CHARSET_UNSUPPORTED');
  if(!(bytes instanceof Uint8Array))return limit('CALENDAR_TEXT_INVALID');
  if(charset==='us-ascii'&&bytes.some(byte=>byte>127))return limit('CALENDAR_TEXT_INVALID');
  total+=bytes.byteLength;if(bytes.byteLength>262144||total>262144)return limit('CALENDAR_TEXT_LIMIT');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return limit('CALENDAR_TEXT_INVALID');}
  if(text.includes('\0'))return limit('CALENDAR_TEXT_INVALID');
  const method=header?.params?.method;
  if(method!==undefined&&(typeof method!=='string'||!/^[A-Za-z-]{1,32}$/u.test(method)))return limit('CALENDAR_TEXT_INVALID');
  const normalized=method?.toUpperCase(),same=parts.find(part=>part.ics_text===text&&(normalized===undefined||part.media_type_method===undefined||part.media_type_method===normalized));
  // MailComposer/other mailers include identical calendar alternative and .ics
  // download parts. One exact content nomination avoids duplicate invitations;
  // conflicting explicit MIME methods remain distinct and fail in the parser.
  if(same){if(same.media_type_method===undefined&&normalized!==undefined)same.media_type_method=normalized;continue;}
  parts.push({part_ref:digest(`${sourceDigest}:calendar:${index}:${digest(bytes)}`),ics_text:text,...(normalized===undefined?{}:{media_type_method:normalized})});
 }
 return {status:'available',parts};
 }finally{body?.fill(0);}
}
