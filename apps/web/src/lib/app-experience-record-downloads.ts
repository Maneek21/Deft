import {createExperienceFileArchive} from './app-experience-file-archive';
import type {ExperienceRecordRow} from './app-experience-record-writer';
import {recordFormFiles,type RecordFormFile} from './app-experience-record-form';
import type {DeftExperienceRecordFormNode} from '../../../../packages/app-kit/src/app-data';
/** File reads reuse the exact trusted catalog and public binary port. No writer,
 * action or author event participates; all bytes/URLs belong to this lifetime. */
export function createExperienceRecordDownloads(options:{node:DeftExperienceRecordFormNode;row:()=>ExperienceRecordRow;current:()=>boolean;signal:AbortSignal;
 read:(row:ExperienceRecordRow,file:RecordFormFile,signal:AbortSignal)=>Promise<Uint8Array>}){
 const controller=new AbortController(),urls=new Set<string>();let busy=false;
 const current=()=>!controller.signal.aborted&&!options.signal.aborted&&options.current();
 const pin=(row:ExperienceRecordRow,file:RecordFormFile)=>{
  if(row.record_id!==options.node.record_id||!['draft','submitted','archived'].includes(row.status)||!Number.isSafeInteger(row.revision)||row.revision<1||!/^sha256:[a-f0-9]{64}$/u.test(row.content_digest))throw Error('Record changed');
  const catalog=row.files?.find(part=>part.file_id===file.file_id&&part.sha256==='sha256:'+file.sha256);
  const value=recordFormFiles(row.value,options.node.profile).find(part=>part.file_id===file.file_id);
  if(!catalog||!Number.isSafeInteger(catalog.upload_revision)||catalog.upload_revision<1||!value||Object.keys(file).some(key=>value[key as keyof RecordFormFile]!==file[key as keyof RecordFormFile]))throw Error('File custody changed');
  return JSON.stringify([row.record_id,row.revision,row.content_digest,row.status,catalog.upload_revision,file]);
 };
 let archive:ReturnType<typeof createExperienceFileArchive<RecordFormFile>>|undefined;
 const dispose=()=>{archive?.dispose();archive=undefined;controller.abort();for(const url of urls)URL.revokeObjectURL(url);urls.clear();};
 options.signal.addEventListener('abort',dispose,{once:true});
 return {cancelArchive(){archive?.cancel();},async downloadArchive(change?:(busy:boolean,notice:string)=>void):Promise<boolean>{
  if(busy||!current())return false;busy=true;const row=structuredClone(options.row());
  try{const files=recordFormFiles(row.value,options.node.profile),pins=files.map(file=>pin(row,file));
   archive=createExperienceFileArchive({files:()=>files,subject:()=>String(row.value[options.node.profile.subject.field]??'Files'),current:()=>current()&&files.every((file,index)=>pin(options.row(),file)===pins[index]),signal:controller.signal,read:(file,signal)=>options.read(row,file,signal),change});
   return await archive.download();
  }catch{return false;}finally{archive?.dispose();archive=undefined;busy=false;}
 },dispose(){options.signal.removeEventListener('abort',dispose);dispose();},async download(file:RecordFormFile):Promise<boolean>{
  if(busy||!current())return false;busy=true;let bytes:Uint8Array|undefined;
  const timeout=new AbortController(),signal=AbortSignal.any([controller.signal,options.signal,timeout.signal]);
  const timer=setTimeout(()=>timeout.abort(),30000);let removeAbort=()=>{};
  try{
   const row=structuredClone(options.row()),owned=structuredClone(file),identity=pin(row,owned);
   const same=()=>current()&&!signal.aborted&&pin(options.row(),owned)===identity;
   if(!same())return false;
   const request=options.read(row,owned,signal);
   // A port that settles after cancellation must never retain/disclose bytes.
   void request.then(value=>{if(signal.aborted||!current())value.fill(0);},()=>{});
   const cancelled=new Promise<never>((_resolve,reject)=>{const abort=()=>reject(Error('File access ended'));signal.addEventListener('abort',abort,{once:true});removeAbort=()=>signal.removeEventListener('abort',abort);if(signal.aborted)abort();});
   bytes=await Promise.race([request,cancelled]);
   if(!same()||bytes.length!==owned.size_bytes)throw Error('File changed');
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(!same()||digest!==owned.sha256)throw Error('File bytes changed');
   const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:owned.media_type}));urls.add(url);
   try{if(!same())throw Error('File access ended');const anchor=document.createElement('a');anchor.href=url;anchor.download=owned.filename;anchor.click();}finally{URL.revokeObjectURL(url);urls.delete(url);}
   return true;
  }catch{return false;}finally{bytes?.fill(0);clearTimeout(timer);removeAbort();busy=false;}
 }};
}
