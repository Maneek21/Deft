import type { ExperienceStartupPhase } from './app-experience-startup';

// Only declared public Host errors can supply display text. Details, stacks and
// arbitrary exceptions never enter the owner-facing failure message.
const publicCodes=new Set(['APP_ACCESS_DENIED','APP_CONNECTION_PROFILE_UNAVAILABLE','APP_DISABLED','APP_FEATURE_DISABLED',
 'APP_NOT_FOUND','APP_REVIEW_REQUIRED','APP_STATE_CONFLICT','APP_STALE','APP_ACTION_UNAVAILABLE','APP_PROVIDER_UNAVAILABLE',
 'APP_EXPERIENCE_BUSY','APP_EXPERIENCE_RESOURCE_UNAVAILABLE','APP_EXPERIENCE_EXPOSURE_STALE','APP_EXPERIENCE_EXPOSURE_DISABLED',
 'RESOURCE_PAYLOAD_TOO_LARGE','RESOURCE_CURSOR_STALE','VALIDATION_ERROR','APP_RUNTIME_SOURCE_CHANGED','APP_RUNTIME_ACCESS_DENIED',
 'APP_RUNTIME_CONFLICT','APP_RUNTIME_NOT_FOUND','APP_RUNTIME_INPUT_INVALID','APP_RUNTIME_LIMIT','APP_RUNTIME_UNAVAILABLE']);

export class AppRequestError extends Error {
 constructor(message:string,readonly code:string,readonly retryable=false,readonly runtimeCode?:string){super(message);this.name='AppRequestError';}
}

export async function readAppRequestError(response:Response,fallback:string):Promise<AppRequestError>{
 const unavailable=()=>new AppRequestError(response.status===401?'Your Deft sign-in could not be confirmed. Sign in again if your session ended.'
  :response.status===403?'The app access check was denied for your current account.':fallback,
  `APP_HTTP_${response.status}`,response.status===408||response.status===429||response.status>=500);
 if(!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')||!response.body){void response.body?.cancel().catch(()=>{});return unavailable();}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>4096){void reader.cancel().catch(()=>{});return unavailable();}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)) as {code?:unknown;error?:unknown;retryable?:unknown;details?:{reason?:unknown;runtime_code?:unknown}};
  if(typeof body?.code!=='string'||!publicCodes.has(body.code)||typeof body.error!=='string'||!body.error.trim()||body.error.length>512||/[\u0000-\u001f\u007f]/u.test(body.error))return unavailable();
  const reason=body.code==='APP_EXPERIENCE_BUSY'&&body.details?.reason;
  const message=reason==='acquisition'?'App access could not obtain a database connection in time. Please try again.'
   :reason==='deadline'?'The app access check exceeded its database deadline. Please try again.':body.error;
  const runtimeCode=body.code.startsWith('APP_RUNTIME_')&&typeof body.details?.runtime_code==='string'
   &&/^[A-Z][A-Z0-9]{0,23}_(?:DATA_SOURCE_CHANGED|DATA_AUTHORITY_DENIED|DATA_CONNECTION_DENIED|RUNTIME_AUTHORITY_DENIED|RUNTIME_SESSION_DENIED|RUNTIME_ACCOUNT_DENIED|DATA_CONFLICT|DRAFT_CONFLICT|DATA_NOT_FOUND|DRAFT_NOT_FOUND|DATA_INPUT_INVALID|RUNTIME_INPUT_INVALID|DRAFT_INVALID|DRAFT_LIMIT|RUNTIME_UNAVAILABLE)$/u.test(body.details.runtime_code)?body.details.runtime_code:undefined;
  return new AppRequestError(message,body.code,body.retryable===true||response.status===408||response.status===429||response.status>=500,runtimeCode);
 }catch{return unavailable();}finally{reader.releaseLock();}
}

export function appRequestFailureMessage(error:unknown,fallback:string):string{
 if(error instanceof AppRequestError)return `${error.message} (${error.code}${error.runtimeCode?`; ${error.runtimeCode}`:''})`;
 if(error instanceof Error&&error.name==='SessionRefreshUnavailableError')return 'Your Deft sign-in check is temporarily unavailable. Deft will try again. (APP_SIGN_IN_CHECK_UNAVAILABLE)';
 if(error instanceof TypeError)return 'The request could not reach Deft. (APP_NETWORK_UNAVAILABLE)';
 if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name))return 'The request timed out. (APP_REQUEST_TIMEOUT)';
 return `${fallback} (APP_REQUEST_FAILED)`;
}

/** Host-only notice: the original response and Worker protocol stay unchanged. */
export async function reportAppRequestFailure(response:Response,current:()=>boolean,notice:(message:string)=>void):Promise<Response>{
 if(!response.ok){
  const error=await readAppRequestError(response.clone(),'App data could not be loaded.');
  // Optional stores can have no existing consent. Their existing feature-level
  // access state handles this denial; it is not an app-wide connection failure.
  if(response.status===403&&error.code==='APP_ACCESS_DENIED')return response;
  if(current())notice(appRequestFailureMessage(error,'App data could not be loaded.'));
 }
 return response;
}

export function experienceStartupFailureMessage(phase:ExperienceStartupPhase):string{
 const reason={bootstrap:'The app startup frame did not become ready.',worker_start:'The app could not start its screen worker.',
  worker_runtime:'The app screen worker stopped unexpectedly.',first_view:'The app did not publish its first screen before the startup deadline.'}[phase];
 return `${reason} (APP_EXPERIENCE_STARTUP_FAILED: ${phase})`;
}
