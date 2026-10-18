import {Node as TiptapNode} from '@tiptap/core';
import {nativeComposeImageCid} from '../../../../packages/app-kit/src/safe-compose-html';
import {inspectNativeComposeRaster} from '../../../../packages/app-kit/src/native-compose-raster';
import type {RecordFormFile} from './app-experience-record-form';
export const inlineRaster=(file:RecordFormFile)=>['image/png','image/jpeg','image/gif','image/webp'].includes(file.media_type);
type Preview={url:string;pixels:number;bytes:number};
/** Optional previews never modify the persisted document. Each controller is
 * owned by one current draft/account/session; no URLs outlive that owner. */
export function createInlinePreviews(options:{current:()=>boolean;read:(file:RecordFormFile,signal:AbortSignal)=>Promise<Uint8Array>;denied:()=>void}){
 const abort=new AbortController();let active=true,readers=0,encoded=0,pixels=0;
 const rows=new Map<string,{file:RecordFormFile;users:number;controller:AbortController;value:Preview|null;promise:Promise<string|null>}>();
 const waiting:Array<()=>void>=[];const current=()=>active&&!abort.signal.aborted&&options.current();
 const wake=()=>{while(readers<2&&waiting.length)waiting.shift()!();};
 const enter=(signal:AbortSignal)=>new Promise<boolean>(resolve=>{const run=()=>{if(!current()||signal.aborted){resolve(false);return;}readers++;resolve(true);};if(readers<2)run();else{waiting.push(run);signal.addEventListener('abort',()=>{const at=waiting.indexOf(run);if(at>=0){waiting.splice(at,1);resolve(false);}},{once:true});}});
 const clear=(row:(typeof rows extends Map<string,infer R>?R:never))=>{row.controller.abort();if(row.value){URL.revokeObjectURL(row.value.url);pixels-=row.value.pixels;row.value=null;}encoded-=row.file.size_bytes;};
 const api={
 acquire(file:RecordFormFile):{ready:Promise<string|null>;release:()=>void;current:()=>boolean}{
  if(!current()){api.dispose();return {ready:Promise.resolve(null),release:()=>{},current:()=>false};}
  const key=JSON.stringify(file),existing=rows.get(key);if(existing){existing.users++;return {ready:existing.promise,release:()=>release(key),current};}
  if(!current()||!inlineRaster(file)||file.size_bytes>8*1024*1024||encoded+file.size_bytes>16*1024*1024||rows.size>=32)return {ready:Promise.resolve(null),release:()=>{},current:()=>false};
  const controller=new AbortController(),signal=AbortSignal.any([abort.signal,controller.signal,AbortSignal.timeout(15000)]);
  const row={file,users:1,controller,value:null as Preview|null,promise:Promise.resolve(null) as Promise<string|null>};encoded+=file.size_bytes;rows.set(key,row);
  row.promise=(async()=>{if(!await enter(signal))return null;let bytes:Uint8Array|undefined;
   try{bytes=await options.read(file,signal);if(!current()||signal.aborted||rows.get(key)!==row)return null;
    const shape=inspectNativeComposeRaster(bytes,file.media_type,'preview');if(!shape||pixels+shape.pixels>32_000_000)return null;
    const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:file.media_type}));row.value={url,pixels:shape.pixels,bytes:bytes.byteLength};pixels+=shape.pixels;return url;
   }catch(error){if(current()&&!signal.aborted&&error&&typeof error==='object'&&'kind' in error&&error.kind==='denied'){api.dispose();options.denied();}return null;}
   finally{bytes?.fill(0);readers--;wake();}
  })();return {ready:row.promise,release:()=>release(key),current};
 },dispose(){if(!active)return;active=false;abort.abort();for(const row of rows.values())clear(row);rows.clear();wake();}
 };
 return api;
 function release(key:string){const row=rows.get(key);if(!row||--row.users>0)return;rows.delete(key);clear(row);}
}
export type InlinePreviews=ReturnType<typeof createInlinePreviews>;
export function inlineImageExtension(options:{files:()=>readonly RecordFormFile[];preview:(file:RecordFormFile)=>{ready:Promise<string|null>;release:()=>void;current?:()=>boolean}}){
 return TiptapNode.create({name:'nativeInlineImage',inline:true,group:'inline',atom:true,selectable:true,
  addAttributes(){return {fileId:{default:null},alt:{default:''}};},
  parseHTML(){return [{tag:'img[src]',getAttrs:element=>{if(typeof element==='string')return false;const file=options.files().find(file=>{try{return 'cid:'+nativeComposeImageCid(file.file_id)===element.getAttribute('src');}catch{return false;}});return file?{fileId:file.file_id,alt:element.getAttribute('alt')??''}:false;}}];},
  renderHTML({node}){return ['img',{src:'cid:'+nativeComposeImageCid(String(node.attrs.fileId)),alt:String(node.attrs.alt)}];},
  addNodeView(){return ({node})=>{const dom=document.createElement('span');dom.contentEditable='false';dom.className='inline-flex max-w-full items-center rounded-lg bg-[var(--surface-container-low)] px-2 py-1 align-middle';
   const label=document.createElement('span');label.textContent='[Image: '+String(node.attrs.alt)+']';dom.append(label);
   const file=options.files().find(file=>file.file_id===node.attrs.fileId),lease=file?options.preview(file):null;let alive=true,released=false,image:HTMLImageElement|null=null;
   const release=()=>{if(!released){released=true;lease?.release();}},owned=()=>alive&&lease?.current?.()!==false;
   const unavailable=()=>{label.textContent='[Image: '+String(node.attrs.alt)+'] · preview unavailable';dom.replaceChildren(label);};
   void lease?.ready.then(url=>{if(!owned()){release();return;}if(!url){unavailable();return;}image=document.createElement('img');image.alt=String(node.attrs.alt);image.className='max-h-64 max-w-full object-contain';
    image.onerror=()=>{if(owned())unavailable();if(image)image.onerror=null;release();};image.src=url;dom.replaceChildren(image);});
   return {dom,update:()=>false,destroy(){alive=false;if(image){image.onerror=null;image.removeAttribute('src');}release();}};
  };}
 });
}
