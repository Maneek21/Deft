import {APP_DATA_FRAME_MEDIA_TYPE,APP_DATA_LIMITS,AppDataRequestSchema,AppDataResultSchema,AppDataBinaryMetadataSchema,
 AppDataContextSchema,frameAppData,parseAppDataFrame,canonicalAppDataJson,type AppDataRequest} from './app-data.js';
/** Host-only data client. The author Worker receives projected metadata through
 * Experience ports, never this authenticated fetch or account/session locator. */
export function createAppDataClient(options:{fetch:typeof fetch;base_url?:string}){
 const base=options.base_url??'/api/app-data';
 const sha=async(bytes:Uint8Array)=>'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),value=>value.toString(16).padStart(2,'0')).join('');
 async function pair(input:AppDataRequest,result:{request_id:string;operation:string;input_digest:string}){
  if(result.request_id!==input.request_id||result.operation!==input.operation||result.input_digest!==await sha(new TextEncoder().encode(canonicalAppDataJson({operation:input.operation,input:input.input}))))throw new Error('App data response changed');
 }
 async function read(response:Response,maximum:number,signal?:AbortSignal){if(!response.ok||response.redirected)throw new Error('App data request unavailable');
  if(!response.body)throw new Error('App data response missing');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;
  const cancel=()=>{void reader.cancel().catch(()=>undefined);};signal?.addEventListener('abort',cancel,{once:true});
  try{for(;;){signal?.throwIfAborted();const part=await reader.read();if(part.done)break;count+=part.value.byteLength;if(count>maximum)throw new Error('App data response exceeds budget');chunks.push(part.value);}
   signal?.throwIfAborted();const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
  }catch(error){cancel();throw error;}finally{signal?.removeEventListener('abort',cancel);reader.releaseLock();}
 }
 async function json(path:string,input?:unknown,signal?:AbortSignal){const response=await options.fetch(`${base}${path}`,{method:input===undefined?'GET':'POST',redirect:'error',signal,
  headers:{Accept:'application/json',...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});
  if(!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??''))throw new Error('Invalid App data response');
  return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await read(response,APP_DATA_LIMITS.result_json_bytes,signal)));
 }
 return {
  context:async(installationId:string,signal?:AbortSignal)=>AppDataContextSchema.parse(await json(`/installations/${encodeURIComponent(installationId)}/context`,undefined,signal)),
  review:(sessionId:string,input:unknown,signal?:AbortSignal)=>json(`/connections/${encodeURIComponent(sessionId)}/consent/review`,input,signal),
  activate:(sessionId:string,input:unknown,signal?:AbortSignal)=>json(`/connections/${encodeURIComponent(sessionId)}/consent/activate`,input,signal),
  revoke:(sessionId:string,consentId:string,signal?:AbortSignal)=>json(`/connections/${encodeURIComponent(sessionId)}/consent/revoke`,{consent_id:consentId},signal),
  request:async(sessionId:string,raw:AppDataRequest,signal?:AbortSignal)=>{
   const input=AppDataRequestSchema.parse(raw),response=await options.fetch(`${base}/connections/${encodeURIComponent(sessionId)}/requests`,{method:'POST',redirect:'error',signal,
    headers:{'Content-Type':'application/json',Accept:`application/json, ${APP_DATA_FRAME_MEDIA_TYPE}`},body:JSON.stringify(input)});
   if(response.headers.get('content-type')===APP_DATA_FRAME_MEDIA_TYPE){const frame=parseAppDataFrame(await read(response,APP_DATA_LIMITS.source_bytes+APP_DATA_LIMITS.frame_header_bytes+4,signal));const metadata=AppDataBinaryMetadataSchema.parse(frame.header);await pair(input,metadata);
    if(metadata.size_bytes!==frame.bytes.byteLength||metadata.sha256!==await sha(frame.bytes)||metadata.record_id!==input.input.record_id)throw new Error('App data binary changed');return {metadata,bytes:frame.bytes};}
   if(!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??''))throw new Error('Invalid App data response');
   const result=AppDataResultSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await read(response,APP_DATA_LIMITS.result_json_bytes,signal))));await pair(input,result);return {result};
  },
  upload:async(sessionId:string,raw:AppDataRequest,bytes:Uint8Array,signal?:AbortSignal)=>{const input=AppDataRequestSchema.parse(raw);if(input.operation!=='file_upload'||bytes.byteLength>APP_DATA_LIMITS.file_bytes)throw new TypeError('Invalid file upload');
   const response=await options.fetch(`${base}/connections/${encodeURIComponent(sessionId)}/binary`,{method:'POST',redirect:'error',signal,headers:{'Content-Type':APP_DATA_FRAME_MEDIA_TYPE,Accept:'application/json'},body:frameAppData(input,bytes) as BodyInit});
   const result=AppDataResultSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await read(response,APP_DATA_LIMITS.result_json_bytes,signal))));await pair(input,result);return result;}
 };
}
