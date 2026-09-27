import type { ResourceRefV2 } from '@deft/shared/resources-v2';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const invalid=()=>new Error('This saved private resource is unavailable.');
export function attachmentObject(value:unknown,keys?:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();const object=value as Record<string,unknown>;
  if(keys&&Object.keys(object).some(k=>!keys.includes(k)))throw invalid();return object;
}
export function attachmentId(value:unknown):string{if(typeof value!=='string'||!uuid.test(value))throw invalid();return value;}
const text=(value:unknown,max:number)=>{if(typeof value!=='string'||!value.length||new TextEncoder().encode(value).byteLength>max)throw invalid();return value;};
const expiry=(value:unknown)=>{const s=text(value,64);if(!Number.isFinite(Date.parse(s)))throw invalid();return s;};
export function attachmentRef(value:unknown):ResourceRefV2{
  const r=attachmentObject(value,['schema_version','provider','resource_type','resource_id']),p=attachmentObject(r.provider,['kind','provider_instance_id']);
  if(r.schema_version!=='deft.resource_ref.v2'||p.kind!=='app_runtime'||typeof r.resource_type!=='string'||!/^[a-z][a-z0-9_]{0,63}$/u.test(r.resource_type))throw invalid();
  return {schema_version:'deft.resource_ref.v2',provider:{kind:'app_runtime',provider_instance_id:attachmentId(p.provider_instance_id)},resource_type:r.resource_type,resource_id:attachmentId(r.resource_id)};
}
export type AttachmentParentPage={items:{projection_id:string;ref:ResourceRefV2;label:string}[];next_cursor:string|null;consent_expires_at:string};
export function attachmentParentPage(value:unknown):AttachmentParentPage{
  const p=attachmentObject(value,['schema_version','items','next_cursor','freshness','consent_expires_at']);
  if(p.schema_version!=='deft.app_attachment_parent_page.v1'||p.freshness!=='unknown'||!Array.isArray(p.items)||p.items.length>25
    ||new TextEncoder().encode(JSON.stringify(p)).byteLength>65536)throw invalid();
  const items=p.items.map(v=>{const i=attachmentObject(v,['projection_id','ref','label']),ref=attachmentRef(i.ref),projection_id=attachmentId(i.projection_id);
    if(ref.resource_id!==projection_id)throw invalid();return {projection_id,ref,label:text(i.label,800)};});
  if(new Set(items.map(i=>i.projection_id)).size!==items.length)throw invalid();
  return {items,next_cursor:p.next_cursor===null?null:text(p.next_cursor,2048),consent_expires_at:expiry(p.consent_expires_at)};
}
export type AttachmentParent={ref:ResourceRefV2;label:string;data:Record<string,string|number|boolean>;consent_expires_at:string;
  attachments:{attachment_id:string;filename:string;media_type:string;size_bytes:number;state:'available'|'blocked'}[]};
export function attachmentParent(value:unknown,projectionId:string):AttachmentParent{
  const p=attachmentObject(value,['schema_version','ref','label','data','freshness','consent_expires_at','attachments']);
  const ref=attachmentRef(p.ref),data=attachmentObject(p.data),catalog=attachmentObject(p.attachments,['schema_version','attachments']);
  if(p.schema_version!=='deft.app_attachment_parent.v1'||p.freshness!=='unknown'||ref.resource_id!==projectionId
    ||Object.keys(data).length>32||Object.entries(data).some(([k,v])=>!/^[a-z][a-z0-9_]{0,47}$/u.test(k)
      ||!(typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)))
    ||new TextEncoder().encode(JSON.stringify(p)).byteLength>131072||catalog.schema_version!=='deft.app_attachment_catalog.v1'
    ||!Array.isArray(catalog.attachments)||catalog.attachments.length>8)throw invalid();
  const attachments=catalog.attachments.map(v=>{const a=attachmentObject(v,['attachment_id','filename','media_type','size_bytes','state']),filename=text(a.filename,800);
    if(filename.length>400||/[\u0000-\u001f\u007f/\\]/u.test(filename)||!['available','blocked'].includes(String(a.state))
      ||typeof a.size_bytes!=='number'||!Number.isSafeInteger(a.size_bytes)||a.size_bytes<1||a.size_bytes>2097152
      ||!['text/plain','text/csv','application/json','image/png','image/jpeg','image/gif','image/webp'].includes(String(a.media_type)))throw invalid();
    return {attachment_id:attachmentId(a.attachment_id),filename,media_type:String(a.media_type),size_bytes:a.size_bytes,state:a.state as 'available'|'blocked'};});
  if(new Set(attachments.map(a=>a.attachment_id)).size!==attachments.length)throw invalid();
  return {ref,label:text(p.label,800),data:data as AttachmentParent['data'],consent_expires_at:expiry(p.consent_expires_at),attachments};
}
/** A display deadline only. Every read/download independently checks the SID. */
export function attachmentWebDeadline(token:string|null):number{try{if(!token)return 0;const s=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
  const p=JSON.parse(atob(s.padEnd(Math.ceil(s.length/4)*4,'=')));return typeof p.exp==='number'&&Number.isFinite(p.exp)?p.exp*1000:0;}catch{return 0;}}
