import {readDraftContent,draftContentDigest} from './native-draft-content.mjs';
import {createHash} from 'node:crypto';
import {triageDigest,triageJson} from './triage-contract.mjs';
import {fail,pathId,text} from './contract.mjs';
const allowed=['compare_before_effect_is_not_atomic_cas','mime_limit_3MiB','graph_update_file_attachments_only','reply_header_changes_unsupported'];
const same=(a,b)=>triageJson(a)===triageJson(b);
const descriptor=row=>({name:row.name,content_type:row.contentType,disposition:row.isInline?'inline':'attachment',content_id:String(row.contentId??'').replace(/^<|>$/gu,'').trim(),content_digest:row.digest});
const metadata=canonical=>{const {attachments,...rest}=canonical;return rest;};
/** Bounded file-attachment saga. The host journal is durable, encrypted, scoped
 * and leased; no SQL transaction spans a provider call. */
export async function updateNativeGraphDraft({input,context,value,api,inspect,result,desired,now}){
 const journal=context.draft_sync_journal,ref=input.provider_draft_ref;
 if(!journal||['create','load','change'].some(key=>typeof journal[key]!=='function'))return result('unsupported',{provider_draft_ref:ref,limitations:[...allowed,'durable_graph_update_journal_required']});
 const scope={org_id:context.org_id,owner_user_id:context.owner_user_id,account_id:context.account_id};
 const bindingDigest=triageDigest([scope,context.installation_id,context.resource_binding_id,value.principal_digest]);
 let wanted,latest,output;
 const reply=(outcome,extra={})=>result(outcome,{provider_draft_ref:ref,limitations:allowed,...extra});
 const observe=async()=>{latest?.mime_bytes?.fill(0);latest=await inspect(ref);await value.check();return {record:latest,content:latest.outcome==='present'?await readDraftContent(latest.mime_bytes):null};};
 const endpoint='https://graph.microsoft.com/v1.0/me/messages/'+pathId(ref),headers={Prefer:'IdType="ImmutableId"'};
 const catalog=async()=>{
  const response=await api.request(endpoint+'/attachments?$top=33',{operation:'modify',headers,maxBytes:4*1024*1024+65536});await value.check();
  if(!Array.isArray(response?.value)||response.value.length>32||response['@odata.nextLink'])return null;
  const ids=new Set();let size=0;const rows=[];
  for(const row of response.value){
   if(row['@odata.type']!=='#microsoft.graph.fileAttachment'&&row['@odata.type']!=='microsoft.graph.fileAttachment')return null;
   text(row.id,256);if(ids.has(row.id))fail('EMAIL_DRAFT_SYNC_RESPONSE_INVALID');ids.add(row.id);
   if(typeof row.name!=='string'||row.name.length>256||typeof row.contentType!=='string'||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(row.contentType)||typeof row.isInline!=='boolean'||row.contentId!=null&&(typeof row.contentId!=='string'||row.contentId.length>256)||typeof row.contentBytes!=='string'||row.contentBytes.length>4*1024*1024||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row.contentBytes))fail('EMAIL_DRAFT_SYNC_RESPONSE_INVALID');
   const bytes=Buffer.from(row.contentBytes,'base64');try{if(bytes.toString('base64')!==row.contentBytes||(size+=bytes.length)>3*1024*1024)fail('EMAIL_DRAFT_SYNC_SIZE_UNSUPPORTED');
    rows.push({...row,digest:createHash('sha256').update(bytes).digest('hex')});
   }finally{bytes.fill(0);}
  }
  // Match MIME content hashes without retaining provider attachment bytes.
  return rows;
 };
 try{
  wanted=await readDraftContent(desired,{keepAttachmentBytes:true});
  if(Buffer.byteLength(JSON.stringify(wanted.patch))>4*1024*1024-65536)return reply('unsupported',{limitations:[...allowed,'json_patch_size_unsupported']});
  if(wanted.parts.some(part=>part.bytes.length>=3000000))return reply('unsupported',{limitations:[...allowed,'single_attachment_under3MB_required']});
  let prior=await journal.load(scope,input.operation_id);await value.check();let plan=prior?.plan;
  if(plan&&(plan.provider_draft_ref!==ref||plan.binding_digest!==bindingDigest||plan.desired_digest!==input.desired.mime_digest||plan.baseline_digest!==input.baseline_digest||plan.baseline_version!==input.provider_version))return reply('conflict');
  if(!plan){
   const observed=await observe();if(observed.record.outcome!=='present')return reply(observed.record.outcome);
   if(observed.record.baseline_digest!==input.baseline_digest||observed.record.provider_version!==input.provider_version)return reply('conflict',{baseline_digest:observed.record.baseline_digest,provider_version:observed.record.provider_version});
   if(!same(observed.content.canonical.in_reply_to,wanted.canonical.in_reply_to)||!same(observed.content.canonical.references,wanted.canonical.references))return reply('unsupported',{limitations:[...allowed,'reply_header_change_not_patchable']});
   if(wanted.canonical.html&&wanted.canonical.text&&!same([observed.content.canonical.text,observed.content.canonical.html],[wanted.canonical.text,wanted.canonical.html]))return reply('unsupported',{limitations:[...allowed,'independent_plain_html_alternatives_not_patchable']});
   const rows=await catalog();if(!rows)return reply('unsupported',{limitations:[...allowed,'non_file_or_over32_attachments']});
   // Existing API catalog and MIME must describe exactly the same multiset.
   const canonicalRows=[];for(const row of rows){const matching=observed.content.parts.find(part=>part.content_digest===row.digest&&part.name===row.name&&part.content_type===row.contentType&&part.disposition===(row.isInline?'inline':'attachment')&&part.content_id===String(row.contentId??'').replace(/^<|>$/gu,'').trim());if(!matching)return reply('conflict',{limitations:[...allowed,'attachment_catalog_mime_mismatch']});canonicalRows.push(descriptor(row));}
   if(draftContentDigest({...observed.content.canonical,attachments:canonicalRows})!==observed.content.digest)return reply('conflict',{limitations:[...allowed,'attachment_catalog_multiplicity_mismatch']});
   let current=structuredClone(observed.content.canonical);const steps=[];
   const add=(kind,extra)=>steps.push({step_id:triageDigest([kind,extra,steps.length]),kind,...extra,after_content_digest:draftContentDigest(current)});
   if(!same(metadata(current),metadata(wanted.canonical))){current={...structuredClone(wanted.canonical),attachments:current.attachments};add('patch',{});}
   const available=new Set(wanted.parts.map((_part,index)=>index)),deletes=[];
   for(const row of rows){const found=[...available].find(index=>same(descriptor(row),wanted.canonical.attachments[index]));if(found===undefined)deletes.push(row);else available.delete(found);}
   for(const row of deletes){const index=current.attachments.findIndex(part=>same(part,descriptor(row)));if(index<0)fail('EMAIL_DRAFT_SYNC_RESPONSE_INVALID');current.attachments.splice(index,1);add('delete_attachment',{target_id:row.id});}
   for(const index of available){current.attachments.push(wanted.canonical.attachments[index]);add('add_attachment',{desired_index:index});}
   const unsigned={schema_version:'deft.email_draft_sync_plan.v1',operation_id:input.operation_id,scope,provider:'microsoft',provider_draft_ref:ref,binding_digest:bindingDigest,baseline_digest:input.baseline_digest,baseline_version:input.provider_version,desired_digest:input.desired.mime_digest,initial_content_digest:observed.content.digest,desired_content_digest:wanted.digest,steps};
   plan={...unsigned,digest:triageDigest(unsigned)};prior=await journal.create(plan);await value.check();
  }
  return await journal.change(scope,input.operation_id,async(state,write)=>{
   if(!state||!same(state.plan,plan))fail('EMAIL_DRAFT_SYNC_PLAN_CONFLICT');
   const save=async(index,next)=>{state.steps[index]={...state.steps[index],...next};await write(state);await value.check();};
   for(let index=0;index<plan.steps.length;index++){
    const step=plan.steps[index],held=state.steps[index];if(held.state==='applied')continue;if(held.state==='conflict')return reply('conflict');
    let observed=await observe();if(observed.record.outcome!=='present'){await save(index,{state:'conflict'});return reply('conflict');}
    const before=index===0?plan.initial_content_digest:plan.steps[index-1].after_content_digest,actual=observed.content.digest;
    if(['started','unknown'].includes(held.state)){
     if(actual===step.after_content_digest){await save(index,{state:'applied',observed_content_digest:actual,observed_version:observed.record.provider_version});continue;}
     if(actual!==before){await save(index,{state:'conflict'});return reply('conflict');}
     if(held.state==='started')await save(index,{state:'unknown'});return reply('unknown');
    }
    if(actual!==before){await save(index,{state:'conflict'});return reply('conflict');}
    await value.check();if(context.expires_at-now()<2000)return reply('unknown',{limitations:[...allowed,'bounded_saga_needs_fresh_claim']});
    const nomination=Object.freeze({operation_id:input.operation_id,operation:'update',account_id:value.account.account_id,authority_epoch:value.account.authority_epoch,provider_draft_ref:ref,baseline_digest:input.baseline_digest,desired_digest:input.desired.mime_digest});
    if(await context.draft_sync_before_effect(nomination)!==true)fail('EMAIL_DRAFT_SYNC_RESERVATION_DENIED');await value.check();await save(index,{state:'started'});
    try{
     if(step.kind==='patch'){const patch=Object.fromEntries(Object.entries(wanted.patch).filter(([key,field])=>key==='body'?!same([observed.content.canonical.text,observed.content.canonical.html],[wanted.canonical.text,wanted.canonical.html]):!same(field,observed.content.patch[key])));const row=await api.request(endpoint,{operation:'modify',method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(patch)});if(row.id!==ref||row.isDraft!==true)fail('EMAIL_DRAFT_SYNC_RESPONSE_INVALID');}
     else if(step.kind==='delete_attachment')await api.request(endpoint+'/attachments/'+pathId(step.target_id),{operation:'modify',method:'DELETE',headers,acceptedStatus:204});
     else{const part=wanted.parts[step.desired_index];if(!part?.bytes||part.bytes.length>=3000000)fail('EMAIL_DRAFT_SYNC_SIZE_UNSUPPORTED');const row=await api.request(endpoint+'/attachments',{operation:'modify',method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({'@odata.type':'#microsoft.graph.fileAttachment',name:part.name,contentType:part.content_type,contentBytes:Buffer.from(part.bytes.buffer,part.bytes.byteOffset,part.bytes.byteLength).toString('base64'),isInline:part.disposition==='inline',...(part.content_id?{contentId:part.content_id}:{})})});text(row.id,256);}
     await value.check();
    }catch(caught){await save(index,{state:'unknown'});}
    try{observed=await observe();}catch(caught){if(state.steps[index].state==='started')await save(index,{state:'unknown'});return reply('unknown');}
    if(observed.record.outcome==='present'&&observed.content.digest===step.after_content_digest){await save(index,{state:'applied',observed_content_digest:observed.content.digest,observed_version:observed.record.provider_version});continue;}
    if(observed.record.outcome==='present'&&observed.content.digest===before){if(state.steps[index].state==='started')await save(index,{state:'unknown'});return reply('unknown');}
    await save(index,{state:'conflict'});return reply('conflict');
   }
   const observed=await observe();if(observed.record.outcome!=='present'||observed.content.digest!==plan.desired_content_digest)return reply('conflict');await value.check();
   output=reply('updated',{baseline_digest:observed.record.baseline_digest,provider_version:observed.record.provider_version,mime_bytes:new Uint8Array(observed.record.mime_bytes)});return output;
  });
 }catch(error){output?.mime_bytes?.fill(0);throw error;}finally{latest?.mime_bytes?.fill(0);for(const part of wanted?.parts??[])part.bytes?.fill(0);}
}
