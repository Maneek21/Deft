import {createHash} from 'node:crypto';
import {AttachmentPolicySchema} from '@deft/app-kit';

export const EMAIL_MEDIA_TYPES=Object.freeze(['text/plain','text/csv','application/json','image/png','image/jpeg','image/gif','image/webp']);
const fixturePolicy={max_attachment_bytes:2097152,max_attachments_per_record:8,max_attachments_per_run:32,max_attachment_bytes_per_run:8388608,retention_days:1,allowed_media_types:['text/csv']};
export const attachmentPolicy=value=>AttachmentPolicySchema.parse(value??fixturePolicy);

// Match the existing generic host classifier. Classification is not malware
// certification; these bytes remain owner downloads, never inline HTML/images.
export function emailMediaAllowed(bytes,declared){
 const value=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),starts=prefix=>prefix.every((byte,index)=>value[index]===byte);
 if(declared==='image/png')return value.length>=33&&starts([137,80,78,71,13,10,26,10])&&value.subarray(12,16).toString('ascii')==='IHDR';
 if(declared==='image/jpeg')return value.length>=4&&starts([255,216,255])&&value[value.length-2]===255&&value[value.length-1]===217;
 if(declared==='image/gif')return value.length>=14&&['GIF87a','GIF89a'].includes(value.subarray(0,6).toString('ascii'))&&value[value.length-1]===59;
 if(declared==='image/webp')return value.length>=20&&value.subarray(0,4).toString('ascii')==='RIFF'&&value.subarray(8,12).toString('ascii')==='WEBP'&&value.readUInt32LE(4)===value.length-8;
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(value);}catch{return false;}
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)||/^\s*(?:<!doctype\s+html|<html(?:\s|>)|<svg(?:\s|>))/iu.test(text))return false;
 if(declared==='application/json'){try{JSON.parse(text);return true;}catch{return false;}}
 return declared==='text/plain'||declared==='text/csv';
}
export function inlineBody(text=''){
 const chunks=[];let offset=0;
 for(let index=0;index<4;index++){
  let low=offset,high=Math.min(offset+4096,text.length);
  while(low<high){const mid=Math.ceil((low+high)/2);if(Buffer.byteLength(JSON.stringify(text.slice(offset,mid)))<=10240)low=mid;else high=mid-1;}
  let end=low;
  if(end<text.length&&end>offset&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
  chunks.push(text.slice(offset,end));offset=end;
 }
 return {body:chunks[0],body_2:chunks[1],body_3:chunks[2],body_4:chunks[3],body_text_length:text.length,body_truncated:offset<text.length};
}
export function collectEmailAttachments(parsed,policy,budget){
 const attachments=[];let skipped=0;
 const fits=bytes=>bytes.byteLength<=policy.max_attachment_bytes&&attachments.length<policy.max_attachments_per_record&&budget.count<policy.max_attachments_per_run&&budget.bytes+bytes.byteLength<=policy.max_attachment_bytes_per_run;
 for(const [index,part] of (parsed?.attachments??[]).entries()){
  if(!policy.allowed_media_types.includes(part.contentType)||!emailMediaAllowed(part.content,part.contentType)||!fits(part.content)){skipped++;continue;}
  attachments.push({key:'part-'+index+'-'+createHash('sha256').update(String(part.contentId??'')).update(String(part.filename??'')).digest('hex').slice(0,16),filename:part.filename??'attachment',media_type:part.contentType,bytes:part.content});budget.count++;budget.bytes+=part.content.byteLength;
 }
 const chunks=inlineBody(parsed?.text??'');let full_body_attachment_key='',full_body_status='not_needed';
 if(parsed===undefined){full_body_status='unavailable';chunks.body_text_length=-1;}
 else if(chunks.body_truncated){
  const bytes=Buffer.from(parsed.text??'','utf8');
  if(!policy.allowed_media_types.includes('text/plain'))full_body_status='policy_denied';
  else if(bytes.byteLength>policy.max_attachment_bytes)full_body_status='too_large';
  else if(!emailMediaAllowed(bytes,'text/plain'))full_body_status='invalid_text';
  else if(!fits(bytes))full_body_status='budget_exceeded';
  else{full_body_attachment_key='body-text-'+createHash('sha256').update(bytes).digest('hex');attachments.push({key:full_body_attachment_key,filename:'Complete message text.txt',media_type:'text/plain',bytes,generated:true});budget.count++;budget.bytes+=bytes.byteLength;full_body_status='available';}
 }
 return {attachments,skipped,original_downloadable_count:attachments.filter(part=>!part.generated).length,...chunks,full_body_attachment_key,full_body_status};
}
