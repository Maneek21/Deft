import {parseTrustedRichtextHtml} from '../../../../packages/app-kit/src/safe-rich-text';
import type {DeftExperienceRecordFormV2Node,DeftExperienceRecordFormV2Profile} from '../../../../packages/app-kit/src/app-data';
import type {ExperienceRecordValue,ExperienceRecordRow} from './app-experience-record-writer';
import type {RecordFormIdentity} from './app-experience-record-form';
const controls=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
export function validateRecordFields(value:ExperienceRecordValue,profile:DeftExperienceRecordFormV2Profile,baseline?:ExperienceRecordValue){
 if(!value||typeof value!=='object'||Array.isArray(value)||new TextEncoder().encode(JSON.stringify(value)).byteLength>profile.max_record_bytes)throw Error('Record limit');
 for(const field of profile.fields){const text=value[field.field];
  if(field.kind==='text'&&(typeof text!=='string'||!text.isWellFormed()||text.length>field.max_characters||controls.test(text)||field.required&&!text.trim()))throw Error(field.label+' needs correction');
  if(field.kind==='boolean'&&typeof text!=='boolean')throw Error(field.label+' unavailable');
  if(field.kind==='choice'&&field.activation){const marker=value[field.activation.field];if(marker!==undefined&&(!marker||typeof marker!=='object'||Array.isArray(marker)||Object.keys(marker).sort().join(',')!=='enabled,schema_version'||(marker as Record<string,unknown>).schema_version!==field.activation.schema_version||typeof (marker as Record<string,unknown>).enabled!=='boolean'))throw Error('Saved placement changed');}
  if(field.kind==='choice'&&!field.options.some(option=>option.value===text))throw Error(field.label+' unavailable');
  if(field.kind==='verified_identity'&&(typeof text!=='string'||text.length>320||!text||/[\s\u0000-\u001f\u007f<>]/u.test(text)||baseline&&baseline[field.field]!==text))throw Error('Verified identity changed');
 }
 for(const group of profile.repeated_fields??[]){const rows=value[group.field];if(!Array.isArray(rows)||rows.length<group.min_rows||rows.length>group.max_rows)throw Error(group.label+' row limit');
  const definition=group.row;if(definition.kind==='choice'){if(rows.some(row=>!definition.options.some(option=>option.value===row))||definition.unique&&new Set(rows).size!==rows.length)throw Error(group.label+' needs distinct choices');}
  else{const fields=definition.fields;for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!==fields.map(field=>field.field).sort().join(','))throw Error(group.label+' row changed');validateRecordFields(row,{schema_version:'deft.record_form_profile.v2',max_record_bytes:profile.max_record_bytes,fields});}}
 }
 const rich=profile.richtext;if(rich){const html=value[rich.html_field],plain=value[rich.plain_field];
  if(typeof html!=='string'||typeof plain!=='string'||html.length>rich.max_html_characters||plain.length>rich.max_plain_characters||!plain.isWellFormed()||controls.test(plain))throw Error('Record text limit');
  if(html&&parseTrustedRichtextHtml(html,{maxCharacters:rich.max_html_characters,maxBytes:profile.max_record_bytes}).plainText!==plain)throw Error('Record text pair changed');
 }
}
export function recordChoiceValue(value:ExperienceRecordValue,field:Extract<DeftExperienceRecordFormV2Profile['fields'][number],{kind:'choice'}>){
 const marker=field.activation?value[field.activation.field] as Record<string,unknown>|undefined:undefined;
 return field.activation&&marker?.enabled!==true?field.activation.inactive_value:value[field.field] as string;
}
export function recordChoiceEdit(value:ExperienceRecordValue,field:Extract<DeftExperienceRecordFormV2Profile['fields'][number],{kind:'choice'}>,next:string){
 if(!field.options.some(option=>option.value===next))throw Error('Saved choice changed');
 return {...value,[field.field]:next,...(field.activation?{[field.activation.field]:{schema_version:field.activation.schema_version,enabled:true}}:{})};
}
export function recordFieldsMode(node:DeftExperienceRecordFormV2Node,row:ExperienceRecordRow,identities:readonly RecordFormIdentity[]){
 if(row.record_id!==node.record_id||!['draft','submitted','archived'].includes(row.status))throw Error('Record changed');validateRecordFields(row.value,node.profile);
 const unavailable=node.profile.fields.some(field=>field.kind==='verified_identity'&&!identities.some(identity=>identity.address===row.value[field.field]));
 if(row.status!=='draft'||node.disabled||unavailable)return {readonly:true,unavailable};
 if(row.revision!==node.expected_revision||row.content_digest!==node.content_digest)throw Error('Record revision changed');return {readonly:false,unavailable:false};
}

export function repeatedRecordEdit(value:ExperienceRecordValue,group:NonNullable<DeftExperienceRecordFormV2Profile['repeated_fields']>[number],operation:{kind:'add'}|{kind:'remove';index:number}|{kind:'edit';index:number;field?:string;value:unknown}){
 const existing=value[group.field];if(!Array.isArray(existing)||existing.length>group.max_rows)throw Error('Repeated rows unavailable');const rows=structuredClone(existing),definition=group.row;
 if(operation.kind==='add'){if(rows.length>=group.max_rows)throw Error('Repeated row limit');if(definition.kind==='choice'){const option=definition.options.find(option=>!definition.unique||!rows.includes(option.value));if(!option)throw Error('Distinct choice limit');rows.push(option.value);}else rows.push(Object.fromEntries(definition.fields.map(field=>[field.field,field.kind==='boolean'?false:field.kind==='choice'?field.options[0].value:''])));}
 else{if(!Number.isSafeInteger(operation.index)||operation.index<0||operation.index>=rows.length)throw Error('Repeated row changed');if(operation.kind==='remove'){if(rows.length<=group.min_rows)throw Error('Repeated row minimum');rows.splice(operation.index,1);}else if(definition.kind==='choice'){if(operation.field!==undefined||!definition.options.some(option=>option.value===operation.value))throw Error('Repeated choice changed');rows[operation.index]=operation.value;}else{if(!definition.fields.some(field=>field.field===operation.field))throw Error('Repeated field changed');rows[operation.index]={...rows[operation.index],[operation.field!]:operation.value};}}
 return {...value,[group.field]:rows};
}
