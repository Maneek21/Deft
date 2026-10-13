import {createAttachmentZip,attachmentArchiveFilename} from './app-experience-attachment-zip';
export type ExperienceArchiveFile={filename:string;size_bytes:number;sha256?:string};
/** Reuse the frozen root-only store ZIP algorithm. Reads remain scoped host
 * ports; the archive never becomes a Worker value or a mutation identity. */
export function createExperienceFileArchive<T extends ExperienceArchiveFile>(options:{files:()=>readonly T[];subject?:()=>string;current:()=>boolean;signal:AbortSignal;read:(file:T,signal:AbortSignal)=>Promise<Uint8Array>;change?:(busy:boolean,notice:string)=>void}){
 let request:AbortController|undefined,disposed=false;
 const current=()=>{try{return !disposed&&!options.signal.aborted&&options.current();}catch{return false;}};
 const cancel=()=>request?.abort();const dispose=()=>{disposed=true;cancel();};options.signal.addEventListener('abort',dispose,{once:true});
 return {cancel,dispose(){options.signal.removeEventListener('abort',dispose);dispose();},async download():Promise<boolean>{
  if(request||!current())return false;const files=structuredClone(options.files()),pin=JSON.stringify(files);
  if(!files.length||files.length>32||files.some(file=>!file.filename||file.filename.length>200||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0)||files.reduce((sum,file)=>sum+file.size_bytes,0)>26214400){options.change?.(false,'ZIP supports up to 32 files, 25 MiB total and 200-character filenames. Download files individually or use the original message.');return false;}
  const own=new AbortController();request=own;const deadline=new AbortController(),signal=AbortSignal.any([own.signal,options.signal,deadline.signal]);const timer=setTimeout(()=>deadline.abort(),60000);let removeAbort=()=>{};
  const held:Uint8Array[]=[],entries:{filename:string;bytes:Uint8Array}[]=[],same=()=>{try{return current()&&!signal.aborted&&JSON.stringify(options.files())===pin;}catch{return false;}};
  const cancelled=new Promise<never>((_resolve,reject)=>{const abort=()=>reject(Error('Archive access ended'));signal.addEventListener('abort',abort,{once:true});removeAbort=()=>signal.removeEventListener('abort',abort);});
  options.change?.(true,`Preparing ${files.length} files…`);
  try{for(const file of files){if(!same())throw Error('Files changed');const read=options.read(file,signal);void read.then(bytes=>{if(!same())bytes.fill(0);},()=>{});
   const bytes=await Promise.race([read,cancelled]);held.push(bytes);if(!same()||bytes.length!==file.size_bytes)throw Error('File changed');
   if(file.sha256){if(!/^[a-f0-9]{64}$/u.test(file.sha256))throw Error('File digest changed');const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('');if(hash!==file.sha256||!same())throw Error('File bytes changed');}
   entries.push({filename:file.filename,bytes});options.change?.(true,`Preparing files: ${entries.length} of ${files.length} checked…`);
  }
  if(!same())throw Error('Files changed');const zip=createAttachmentZip(entries);held.push(zip);const url=URL.createObjectURL(new Blob([new Uint8Array(zip)],{type:'application/zip'}));
  try{if(!same())throw Error('File access ended');const anchor=document.createElement('a');anchor.href=url;anchor.download=attachmentArchiveFilename(options.subject?.()??'Files');anchor.click();}finally{URL.revokeObjectURL(url);}
  if(same())options.change?.(false,`ZIP download started for ${files.length} ${files.length===1?'file':'files'}.`);return true;
  }catch{if(current())options.change?.(false,'The ZIP could not be completed. No ZIP was saved. Download files individually or try again.');return false;}
  finally{for(const bytes of held)bytes.fill(0);clearTimeout(timer);removeAbort();if(request===own)request=undefined;}
 }};
}
