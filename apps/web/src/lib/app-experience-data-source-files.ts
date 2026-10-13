import {readExperienceScopedBinary} from './app-experience-scoped-binary';
import {createExperienceFileArchive} from './app-experience-file-archive';
import type {AppDataSourceFileSchema} from '../../../../packages/app-kit/src/app-data';
type SourceFile=ReturnType<typeof AppDataSourceFileSchema.parse>;
/** Public scoped file bytes remain in the trusted host. Preview URLs belong to
 * this exact document lifetime and are revoked on every scope/render disposal. */
export function mountExperienceDataSourceFiles(options:{wrapper:HTMLElement;signal:AbortSignal;current:()=>boolean;
 list:(signal:AbortSignal)=>Promise<readonly SourceFile[]>;
 read:(file:SourceFile,signal:AbortSignal)=>Promise<{bytes:Uint8Array;media_type:string;filename:string}>;
 source:(signal:AbortSignal)=>Promise<{bytes:Uint8Array;media_type:string;filename:string}>}){
 const controller=new AbortController(),signal=AbortSignal.any([controller.signal,options.signal]),urls=new Set<string>();let alive=true,archiveBusy=false,archive:ReturnType<typeof createExperienceFileArchive<SourceFile>>|undefined;
 const current=()=>alive&&!signal.aborted&&options.current();
 const section=document.createElement('details');section.className='ex-stack';const summary=document.createElement('summary');summary.textContent='Files and original message';summary.className='ex-button-ghost';section.append(summary);options.wrapper.append(section);
 const status=document.createElement('p');status.className='ex-text ex-text-caption';status.setAttribute('role','status');section.append(status);
 const original=document.createElement('button');original.type='button';original.className='ex-button-ghost';original.textContent='Download original';section.append(original);
 const download=(bytes:Uint8Array,type:string,filename:string)=>{if(!current())return;const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type}));urls.add(url);
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();URL.revokeObjectURL(url);urls.delete(url);};
 original.onclick=async()=>{if(!current()||original.disabled||archiveBusy)return;original.disabled=true;try{const value=await readExperienceScopedBinary({signal,current,read:options.source,mediaType:'message/rfc822',maxBytes:36700160});try{download(value.bytes,value.media_type,value.filename);}finally{value.bytes.fill(0);}}
  catch{if(current())status.textContent='The original message could not be downloaded.';}finally{if(current())original.disabled=false;}};
 void options.list(signal).then(files=>{if(!current())return;summary.textContent=files.length?`Files (${files.length}) and original message`:'Original message';
  const attachments=files.filter(file=>file.disposition==='attachment');
  if(attachments.length){const button=document.createElement('button'),cancel=document.createElement('button');button.type=cancel.type='button';button.className=cancel.className='ex-button-ghost';button.textContent='Download listed attachments (.zip)';cancel.textContent='Cancel ZIP';cancel.hidden=true;
   archive=createExperienceFileArchive({files:()=>attachments,current,signal,read:async(file,signal)=>{const value=await readExperienceScopedBinary({signal,current,read:signal=>options.read(file,signal),mediaType:file.media_type,maxBytes:26214400,size:file.size_bytes,filename:file.filename});if(value.media_type!==file.media_type||value.filename!==file.filename){value.bytes.fill(0);throw Error('File metadata changed');}return value.bytes;},change:(busy,notice)=>{if(current()){archiveBusy=busy;original.disabled=busy;button.disabled=busy;cancel.hidden=!busy;status.textContent=notice;}}});
   button.onclick=async()=>{if(current()&&!button.disabled)await archive?.download();};cancel.onclick=()=>archive?.cancel();section.append(button,cancel);
  }
  for(const file of files){const row=document.createElement('div');row.className='ex-stack ex-stack-horizontal';const name=document.createElement('span');name.textContent=`${file.filename} · ${(file.size_bytes/1024).toLocaleString(undefined,{maximumFractionDigits:1})} KiB`;row.append(name);
   const button=document.createElement('button');button.type='button';button.className='ex-button-ghost';button.textContent='Download';button.setAttribute('aria-label',`Download ${file.filename}`);row.append(button);
   button.onclick=async()=>{if(!current()||button.disabled||archiveBusy)return;button.disabled=true;try{const value=await readExperienceScopedBinary({signal,current,read:signal=>options.read(file,signal),mediaType:file.media_type,maxBytes:26214400,size:file.size_bytes,filename:file.filename});try{if(value.media_type!==file.media_type||value.bytes.length!==file.size_bytes)throw Error('File changed');download(value.bytes,value.media_type,file.filename);}finally{value.bytes.fill(0);}}
    catch{if(current())status.textContent='The file could not be downloaded. Refresh this message to check its current source.';}finally{if(current())button.disabled=false;}};
   if(['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain'].includes(file.media_type)&&file.size_bytes<=2097152){
    const preview=document.createElement('button');preview.type='button';preview.className='ex-button-ghost';preview.textContent='Preview';preview.setAttribute('aria-label',`Preview ${file.filename}`);row.append(preview);
    preview.onclick=async()=>{if(!current()||preview.disabled||archiveBusy)return;preview.disabled=true;try{const value=await readExperienceScopedBinary({signal,current,read:signal=>options.read(file,signal),mediaType:file.media_type,maxBytes:26214400,size:file.size_bytes,filename:file.filename});try{
      if(!current()||value.media_type!==file.media_type||value.bytes.length!==file.size_bytes)throw Error('File changed');
      if(value.media_type==='text/plain'){const pre=document.createElement('pre');pre.className='max-h-80 overflow-auto whitespace-pre-wrap break-words';pre.textContent=new TextDecoder('utf8',{fatal:true}).decode(value.bytes);section.append(pre);}
      else{const url=URL.createObjectURL(new Blob([new Uint8Array(value.bytes)],{type:value.media_type}));urls.add(url);
       if(value.media_type==='application/pdf'){
        const notice=document.createElement('p');notice.className='ex-text ex-text-caption';notice.textContent='Preview uses your browser’s PDF viewer. If the viewer is unavailable, use Download to open the file.';
        const link=document.createElement('a');link.className='ex-button-ghost';link.textContent='Open PDF preview';link.href=url;link.target='_blank';link.rel='noopener noreferrer';
        link.onclick=event=>{if(!current())event.preventDefault();};section.append(notice,link);
       }
       else{const image=document.createElement('img');image.alt=file.filename;image.className='max-h-80 max-w-full object-contain';image.src=url;section.append(image);}}
     }finally{value.bytes.fill(0);}}
     catch{if(current())status.textContent='This file preview is unavailable. You can download the file.';}finally{if(current())preview.disabled=false;}};
   }section.append(row);
  }
 }).catch(()=>{if(current())status.textContent='File details are unavailable. Refresh the message to retry.';});
 return()=>{alive=false;archive?.dispose();controller.abort();for(const url of urls)URL.revokeObjectURL(url);urls.clear();section.remove();};
}
