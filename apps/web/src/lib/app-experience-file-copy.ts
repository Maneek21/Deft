import {AppDataSourceReferencesSchema,type AppDataSourceReference,type AppDataSourceFile} from '../../../../packages/app-kit/src/app-data';
import {recordFormFiles,type RecordFormProfile} from './app-experience-record-form';
import type {ExperienceRecordRow,createExperienceRecordWriter} from './app-experience-record-writer';
export type FileCopyNode={store_key:string;record_id:string;source_refs?:readonly AppDataSourceReference[];profile:RecordFormProfile};
export type FileCopyPorts={
 listOriginals:(node:FileCopyNode,row:ExperienceRecordRow,signal:AbortSignal)=>Promise<AppDataSourceFile[]>;
 copyOriginal:(node:FileCopyNode,row:ExperienceRecordRow,source:AppDataSourceReference,file:AppDataSourceFile,fileId:string,requestId:string,signal:AbortSignal)=>Promise<ExperienceRecordRow>;
 copyStatus:(node:FileCopyNode,row:ExperienceRecordRow,source:AppDataSourceReference,file:AppDataSourceFile,fileId:string,requestId:string,signal:AbortSignal)=>Promise<ExperienceRecordRow|null>;
};
const equal=(a:unknown,b:unknown):boolean=>{const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sort(v)])):v;return JSON.stringify(sort(a))===JSON.stringify(sort(b));};
export function recordCopySource(node:FileCopyNode,row:ExperienceRecordRow){
 if(row.record_id!==node.record_id)throw Error('Draft identity changed');
 const nominated=AppDataSourceReferencesSchema.parse(node.source_refs??[]),owned=AppDataSourceReferencesSchema.parse(row.source_refs??[]);
 if(!nominated.length)return null;
 if(!equal(nominated,owned))throw Error('Original message reference changed');return owned[0]??null;
}
export function verifyFileCopy(node:FileCopyNode,before:ExperienceRecordRow,next:ExperienceRecordRow,source:AppDataSourceReference,file:AppDataSourceFile,fileId:string){
 if(before.status!=='draft'||next.status!=='draft'||next.record_id!==before.record_id||next.revision!==before.revision+1||!equal(recordCopySource(node,next),source))throw Error('Copy revision changed');
 const old=recordFormFiles(before.value,node.profile),files=recordFormFiles(next.value,node.profile),added=files.filter(f=>!old.some(o=>o.file_id===f.file_id));
 if(added.length!==1||files.length!==old.length+1||added[0].file_id!==fileId||added[0].filename!==file.filename||added[0].media_type!==file.media_type||added[0].size_bytes!==file.size_bytes||old.some(o=>!equal(o,files.find(f=>f.file_id===o.file_id))))throw Error('Original file copy changed');
 if(!equal(before.value,{...next.value,[node.profile.files.field]:before.value[node.profile.files.field]})||!equal(before.files??[],next.files?.filter(f=>f.file_id!==fileId)??[]))throw Error('Draft contents changed');
 const active=next.files?.find(f=>f.file_id===fileId);if(!active||active.upload_revision!==next.revision||active.sha256!=='sha256:'+added[0].sha256)throw Error('Copied file custody changed');return next;
}
export type OriginalFileState={file:AppDataSourceFile;state:'available'|'loading'|'saved'|'failed'|'unconfirmed'|'omitted'|'source_only';notice:string};
export function createOriginalFileCopies(options:{node:FileCopyNode;writer:()=>ReturnType<typeof createExperienceRecordWriter>|null;ports:FileCopyPorts;current:()=>boolean;locked:()=>boolean;signal:AbortSignal;change:(files:readonly OriginalFileState[],busy:boolean,notice:string)=>void}){
 let active=true,busy=false,files:OriginalFileState[]=[],notice='';let pending:{before:ExperienceRecordRow;source:AppDataSourceReference;file:AppDataSourceFile;fileId:string;requestId:string}|null=null;
 const current=()=>active&&!options.signal.aborted&&options.current(),emit=()=>{if(current())options.change(files.map(f=>({...f})),busy,notice);};
 const patch=(ref:string,state:OriginalFileState['state'],message='')=>{files=files.map(f=>f.file.file_ref===ref?{...f,state,notice:message}:f);emit();};
 const signal=()=>AbortSignal.any([options.signal,AbortSignal.timeout(30000)]);
 return {
 async load(){if(!current())return;const writer=options.writer();if(!writer||writer.snapshot.row.status!=='draft')return;const source=recordCopySource(options.node,writer.snapshot.row);if(!source)return;busy=true;emit();try{const values=await options.ports.listOriginals(options.node,writer.snapshot.row,signal());if(!current())return;
  files=values.filter(f=>f.disposition==='attachment').map(file=>({file,state:file.size_bytes>options.node.profile.files.max_file_bytes||file.size_bytes>options.node.profile.files.max_total_bytes?'source_only':'available',notice:file.size_bytes>options.node.profile.files.max_file_bytes?'Download the original message to access this file. It cannot be included.':''}));
 }catch{if(current())notice='Original files unavailable. Reopen the message to check access.';}finally{if(current()){busy=false;emit();}}},
 async include(ref:string){const writer=options.writer(),entry=files.find(f=>f.file.file_ref===ref);if(!current()||busy||pending||options.locked()||!writer||writer.snapshot.row.status!=='draft'||writer.snapshot.state==='blocked'||!entry||!['available','failed','omitted'].includes(entry.state))return false;
  const existing=recordFormFiles(writer.snapshot.value,options.node.profile);if(existing.length>=options.node.profile.files.max_files||existing.reduce((n,f)=>n+f.size_bytes,0)+entry.file.size_bytes>options.node.profile.files.max_total_bytes){notice='Selected originals exceed the draft file limits.';emit();return false;}
  busy=true;notice='';patch(ref,'loading');try{const ok=await writer.mutate(async()=>{const before=writer.snapshot.row,source=recordCopySource(options.node,before);if(!source||!current())throw Error('Source ended');const existing=recordFormFiles(before.value,options.node.profile);
   if(existing.length>=options.node.profile.files.max_files||existing.reduce((n,f)=>n+f.size_bytes,0)+entry.file.size_bytes>options.node.profile.files.max_total_bytes)throw Error('Selected files exceed draft limits');
   pending={before,source,file:entry.file,fileId:crypto.randomUUID(),requestId:crypto.randomUUID()};const p=pending;return verifyFileCopy(options.node,before,await options.ports.copyOriginal(options.node,before,source,entry.file,p.fileId,p.requestId,signal()),source,entry.file,p.fileId);});
  if(!current())return false;if(ok){pending=null;patch(ref,'saved');return true;}if(pending)patch(ref,'unconfirmed','Copy not confirmed. Check status before another file change.');else patch(ref,'failed','Save the current draft and check its limits before including this file.');return false;
  }finally{if(current()){busy=false;emit();}}},
 async check(){const writer=options.writer(),p=pending;if(!current()||busy||!p||!writer)return false;busy=true;emit();try{const next=await options.ports.copyStatus(options.node,p.before,p.source,p.file,p.fileId,p.requestId,signal());if(!current()||!next)return false;verifyFileCopy(options.node,p.before,next,p.source,p.file,p.fileId);
  if(!await writer.reopen({record_id:next.record_id,revision:next.revision,content_digest:next.content_digest})||!current())return false;pending=null;patch(p.file.file_ref,'saved');notice='Original file copied. Saved version reopened.';return true;
 }catch{if(current())notice='Copy status remains uncertain. No copy was repeated.';return false;}finally{if(current()){busy=false;emit();}}},
 omit(ref:string){if(!current()||busy||pending)return;patch(ref,'omitted');},
 dispose(){active=false;},
 };
}
