export type SourceFile={file_ref:string;filename:string;media_type:string;size_bytes:number;disposition:'attachment'|'inline';preview:'text'|'image'|'pdf'|'unsupported';content_id?:string};
export type SourcePresentation={format:'plain'|'html';content:string;plain_text:string;truncated:boolean;images:{image_ref:string;kind:'cid'|'remote';index:number;alt:string}[];headers:{label:string;value:string}[];metadata?:Record<string,string|number|boolean>;external_images?:'ask'|'always';omitted_file_count?:number;rendering_fallback?:'plain_text'};
type Scope={exposure_id:string;exposure_epoch:number};
const fail=():never=>{throw Error('SOURCE_VIEW_UNAVAILABLE');};
const object=(raw:unknown):Record<string,unknown>=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();return raw as Record<string,unknown>;};
const keys=(row:Record<string,unknown>,allowed:string[])=>{if(Object.keys(row).some(key=>!allowed.includes(key)))fail();};
const omittedCount=(value:unknown)=>{if(value!==undefined&&(!Number.isInteger(value)||Number(value)<0||Number(value)>256))fail();return value===undefined?0:Number(value);};
export function parseSourceView(raw:unknown,scope:Scope){
 const row=object(raw);keys(row,['exposure_id','exposure_epoch','expires_at','files','presentation','omitted_file_count']);
 const omitted_file_count=omittedCount(row.omitted_file_count);
 if(row.exposure_id!==scope.exposure_id||row.exposure_epoch!==scope.exposure_epoch||typeof row.expires_at!=='string'||!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<=Date.now())fail();
 const rawFiles=row.files;
 if(rawFiles!==undefined){
  if(!Array.isArray(rawFiles)||rawFiles.length>32)throw Error('SOURCE_VIEW_UNAVAILABLE');
  const seen=new Set<string>();
  const files:SourceFile[]=rawFiles.map((rawFile:unknown)=>{const f=object(rawFile);keys(f,['file_ref','filename','media_type','size_bytes','disposition','preview','content_id']);if(typeof f.file_ref!=='string'||!/^[a-f0-9]{64}$/u.test(f.file_ref)||seen.has(f.file_ref)||typeof f.filename!=='string'||!f.filename||f.filename.length>200||/[\u0000-\u001f\u007f/\\]/u.test(f.filename)||typeof f.media_type!=='string'||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(f.media_type)||!Number.isSafeInteger(f.size_bytes)||(f.size_bytes as number)<0||(f.size_bytes as number)>8388608||!['attachment','inline'].includes(String(f.disposition))||!['text','image','pdf','unsupported'].includes(String(f.preview))||f.content_id!==undefined&&(typeof f.content_id!=='string'||f.content_id.length>256))fail();seen.add(f.file_ref as string);return f as SourceFile;});
  if(files.reduce((sum,f)=>sum+f.size_bytes,0)>8388608)fail();return {files,omitted_file_count,expires_at:row.expires_at as string};
 }
 const p=object(row.presentation);keys(p,['format','content','plain_text','truncated','images','headers','metadata','external_images','omitted_file_count','rendering_fallback']);
 omittedCount(p.omitted_file_count);if(p.rendering_fallback!==undefined&&(p.rendering_fallback!=='plain_text'||p.format!=='plain'||!Array.isArray(p.images)||p.images.length!==0))fail();
 if(p.external_images!==undefined&&!['ask','always'].includes(String(p.external_images)))fail();
 if(!['plain','html'].includes(String(p.format))||typeof p.content!=='string'||new TextEncoder().encode(p.content).byteLength>262144||p.content.includes('\0')||typeof p.plain_text!=='string'||new TextEncoder().encode(p.plain_text).byteLength>262144||typeof p.truncated!=='boolean'||!Array.isArray(p.images)||p.images.length>32)fail();
 const seen=new Set<string>();for(const rawImage of p.images as unknown[]){const image=object(rawImage);keys(image,['image_ref','kind','index','alt']);if(typeof image.image_ref!=='string'||!/^[a-f0-9]{64}$/u.test(image.image_ref)||seen.has(image.image_ref)||!['cid','remote'].includes(String(image.kind))||!Number.isInteger(image.index)||(image.index as number)<0||(image.index as number)>31||typeof image.alt!=='string'||image.alt.length>200)fail();seen.add(image.image_ref as string);}
 if(!Array.isArray(p.headers)||p.headers.length>6||p.headers.some(raw=>{const h=object(raw);keys(h,['label','value']);return !['From','To','Cc','Reply-To','Date','Subject'].includes(String(h.label))||typeof h.value!=='string'||h.value.length>2048||/[\r\n\0]/u.test(h.value);}))fail();
 if(p.metadata!==undefined){const metadata=object(p.metadata);if(Object.keys(metadata).length>32||Object.entries(metadata).some(([key,v])=>!/^[a-z][a-z0-9_]{0,47}$/u.test(key)||!['string','number','boolean'].includes(typeof v)||typeof v==='string'&&(v.length>16384||/[\r\n\0]/u.test(v))||typeof v==='number'&&!Number.isFinite(v)))fail();}
 return {presentation:p as SourcePresentation,expires_at:row.expires_at as string};
}
export async function readSourceBinary(response:Response,scope:Scope,current:()=>boolean,{size,maxBytes=8388608,image=false,mediaType='application/octet-stream',signal}:{size?:number;maxBytes?:number;image?:boolean;mediaType?:string;signal?:AbortSignal}={}):Promise<Uint8Array>{
 const reject=async():Promise<never>=>{await response.body?.cancel().catch(()=>{});return fail();};
 if(!current()||signal?.aborted||!response.ok||response.headers.get('x-deft-exposure-id')!==scope.exposure_id||response.headers.get('x-deft-exposure-epoch')!==String(scope.exposure_epoch)||response.headers.get('x-content-type-options')!=='nosniff'||!response.headers.get('content-disposition')?.startsWith('attachment;')||!response.body)return reject();
 const length=Number(response.headers.get('content-length')),type=response.headers.get('content-type');if(!response.headers.has('content-length')||!Number.isSafeInteger(length)||length<0||length>maxBytes||size!==undefined&&length!==size||(image?!['image/png','image/jpeg','image/gif','image/webp'].includes(type??''):type!==mediaType))return reject();
 const body=response.body;
 if(body===null)throw Error('SOURCE_VIEW_UNAVAILABLE');
 const reader=body.getReader(),chunks:Uint8Array[]=[];let count=0;const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 try{signal?.throwIfAborted();for(;;){const row=await reader.read();if(row.done)break;chunks.push(row.value);count+=row.value.byteLength;if(signal?.aborted||count>maxBytes||count>length||!current())fail();}if(signal?.aborted||count!==length||!current())fail();const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;}
 finally{signal?.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
