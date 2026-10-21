import { AppError, type AppErrorCode } from './app-errors.js';

const unavailable=()=>new AppError('Reviewed connection runtime unavailable','APP_CONNECTION_PROFILE_UNAVAILABLE',503);
const classifications:Readonly<Record<string,{code:AppErrorCode;message:string;status:400|403|404|409|413|503;retryable?:boolean}>>={
 DATA_SOURCE_CHANGED:{code:'APP_RUNTIME_SOURCE_CHANGED',message:'The selected source changed while the app was reading it. Try the read again.',status:409,retryable:true},
 DATA_AUTHORITY_DENIED:{code:'APP_RUNTIME_ACCESS_DENIED',message:'The app Runtime could not confirm current permission for this data.',status:403},
 DATA_CONNECTION_DENIED:{code:'APP_RUNTIME_ACCESS_DENIED',message:'The app Runtime could not confirm the current account connection.',status:403},
 RUNTIME_AUTHORITY_DENIED:{code:'APP_RUNTIME_ACCESS_DENIED',message:'The app Runtime could not confirm current permission.',status:403},
 RUNTIME_SESSION_DENIED:{code:'APP_RUNTIME_ACCESS_DENIED',message:'The app Runtime could not confirm the current connection session.',status:403},
 RUNTIME_ACCOUNT_DENIED:{code:'APP_RUNTIME_ACCESS_DENIED',message:'The app Runtime could not confirm the current account.',status:403},
 DATA_CONFLICT:{code:'APP_RUNTIME_CONFLICT',message:'The app data changed. Reload it before trying again.',status:409},
 DRAFT_CONFLICT:{code:'APP_RUNTIME_CONFLICT',message:'The saved draft changed. Reload it before trying again.',status:409},
 DATA_NOT_FOUND:{code:'APP_RUNTIME_NOT_FOUND',message:'The requested app data is no longer available.',status:404},
 DRAFT_NOT_FOUND:{code:'APP_RUNTIME_NOT_FOUND',message:'The requested saved draft is no longer available.',status:404},
 DATA_INPUT_INVALID:{code:'APP_RUNTIME_INPUT_INVALID',message:'The app Runtime rejected the data request format.',status:400},
 RUNTIME_INPUT_INVALID:{code:'APP_RUNTIME_INPUT_INVALID',message:'The app Runtime rejected the request format.',status:400},
 DRAFT_INVALID:{code:'APP_RUNTIME_INPUT_INVALID',message:'The app Runtime rejected the draft format.',status:400},
 DRAFT_LIMIT:{code:'APP_RUNTIME_LIMIT',message:'The draft exceeds the app Runtime storage limits.',status:413},
 RUNTIME_UNAVAILABLE:{code:'APP_RUNTIME_UNAVAILABLE',message:'The app Runtime is temporarily unavailable. Try again shortly.',status:503,retryable:true},
};

/** A Runtime is untrusted text. Only closed semantic classifications cross the
 * transport; the bounded original identifier is diagnostic metadata. */
export async function appRuntimeResponseError(response:Response,signal:AbortSignal):Promise<AppError>{
 if(response.ok||response.redirected||![400,403,404,409,413,429,503].includes(response.status)
  ||!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')||!response.body){void response.body?.cancel().catch(()=>{});return unavailable();}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{
  for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>4096){cancel();return unavailable();}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const raw=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)) as {code?:unknown;error?:unknown};
  // Legacy Runtime responses use {error: CODE}; structured responses use code.
  const code=typeof raw?.code==='string'?raw.code:raw?.error;
  if(typeof code!=='string'||code.length>64)return unavailable();
  const match=/^[A-Z][A-Z0-9]{0,23}_([A-Z_]+)$/u.exec(code),classification=match&&classifications[match[1]!];
  if(!classification)return unavailable();
  return new AppError(classification.message,classification.code,classification.status,{runtime_code:code,...(classification.retryable?{retryable:true}:{})});
 }catch{return unavailable();}finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}

export function isAppRuntimeSourceChanged(error:unknown):boolean{
 return error instanceof AppError&&error.code==='APP_RUNTIME_SOURCE_CHANGED';
}
