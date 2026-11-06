import type { ExperienceStartupPhase } from './app-experience-startup';
import {AppDataRequestSchema} from '../../../../packages/app-kit/src/app-data';

// Only declared public Host errors can supply display text. Details, stacks and
// arbitrary exceptions never enter the owner-facing failure message.
const publicCodes=new Set(['APP_ACCESS_DENIED','APP_CONNECTION_PROFILE_UNAVAILABLE','APP_DISABLED','APP_FEATURE_DISABLED',
  'APP_NOT_FOUND','APP_REVIEW_REQUIRED','APP_STATE_CONFLICT','APP_STALE','APP_ACTION_UNAVAILABLE','APP_PROVIDER_UNAVAILABLE',
  'APP_EXPERIENCE_BUSY','APP_EXPERIENCE_RESOURCE_UNAVAILABLE','APP_EXPERIENCE_EXPOSURE_STALE','APP_EXPERIENCE_EXPOSURE_DISABLED',
  'RESOURCE_PAYLOAD_TOO_LARGE','RESOURCE_CURSOR_STALE','VALIDATION_ERROR','APP_RUNTIME_SOURCE_CHANGED','APP_RUNTIME_ACCESS_DENIED',
  'APP_RUNTIME_CONFLICT','APP_RUNTIME_NOT_FOUND','APP_RUNTIME_INPUT_INVALID','APP_RUNTIME_LIMIT','APP_RUNTIME_UNAVAILABLE']);

/** A concrete recovery step the Host may attach to a lapsed/reauth-required
 * denial. The kind is a fixed enum and every id field is validated before it is
 * ever surfaced; free text, provider callbacks and unknown keys never reach the
 * owner-facing failure path. */
export type AppNextStepKind = 'restore_access' | 'reconnect' | 'review_consent';
export type AppNextStep = {
  readonly kind: AppNextStepKind;
  readonly installation_id?: string;
  readonly target_key?: string;
  readonly consent_id?: string;
};
const NEXT_STEP_KINDS: ReadonlySet<string> = new Set(['restore_access', 'reconnect', 'review_consent']);
const NEXT_STEP_KEYS: ReadonlySet<string> = new Set(['kind', 'installation_id', 'target_key', 'consent_id']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TARGET_KEY = /^[a-z][a-z0-9_]{0,47}$/u;

/** Whitelist `details.next_step` onto a bounded AppNextStep, or drop it entirely
 * when the kind or any id is malformed or off-whitelist. Never returns free
 * text, extra keys or non-enum kinds. */
export function parseAppNextStep(value: unknown): AppNextStep | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!NEXT_STEP_KINDS.has(String(raw.kind))) return undefined;
  if (!Object.keys(raw).every((key) => NEXT_STEP_KEYS.has(key))) return undefined;
  const step: { kind: AppNextStepKind; installation_id?: string; target_key?: string; consent_id?: string } = { kind: raw.kind as AppNextStepKind };
  if ('installation_id' in raw) {
    if (typeof raw.installation_id !== 'string' || !UUID.test(raw.installation_id)) return undefined;
    step.installation_id = raw.installation_id;
  }
  if ('target_key' in raw) {
    if (typeof raw.target_key !== 'string' || !TARGET_KEY.test(raw.target_key)) return undefined;
    step.target_key = raw.target_key;
  }
  if ('consent_id' in raw) {
    if (typeof raw.consent_id !== 'string' || !UUID.test(raw.consent_id)) return undefined;
    step.consent_id = raw.consent_id;
  }
  return step;
}

export class AppRequestError extends Error {
  constructor(message:string,readonly code:string,readonly retryable=false,readonly runtimeCode?:string,readonly nextStep?:AppNextStep){super(message);this.name='AppRequestError';}
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
    const body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes)) as {code?:unknown;error?:unknown;retryable?:unknown;details?:{reason?:unknown;runtime_code?:unknown;next_step?:unknown}};
    if(typeof body?.code!=='string'||!publicCodes.has(body.code)||typeof body.error!=='string'||!body.error.trim()||body.error.length>512||/[\u0000-\u001f\u007f]/u.test(body.error))return unavailable();
    const reason=body.code==='APP_EXPERIENCE_BUSY'&&body.details?.reason;
    const message=reason==='acquisition'?'App access could not obtain a database connection in time. Please try again.'
      :reason==='deadline'?'The app access check exceeded its database deadline. Please try again.':body.error;
    const runtimeCode=body.code.startsWith('APP_RUNTIME_')&&typeof body.details?.runtime_code==='string'
      &&/^[A-Z][A-Z0-9]{0,23}_(?:DATA_SOURCE_CHANGED|DATA_AUTHORITY_DENIED|DATA_CONNECTION_DENIED|RUNTIME_AUTHORITY_DENIED|RUNTIME_SESSION_DENIED|RUNTIME_ACCOUNT_DENIED|DATA_CONFLICT|DRAFT_CONFLICT|DATA_NOT_FOUND|DRAFT_NOT_FOUND|DATA_INPUT_INVALID|RUNTIME_INPUT_INVALID|DRAFT_INVALID|DRAFT_LIMIT|RUNTIME_UNAVAILABLE)$/u.test(body.details.runtime_code)?body.details.runtime_code:undefined;
    const nextStep=parseAppNextStep(body.details?.next_step);
    return new AppRequestError(message,body.code,body.retryable===true||response.status===408||response.status===429||response.status>=500,runtimeCode,nextStep);
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
export async function reportAppRequestFailure(response:Response,current:()=>boolean,notice:(message:string)=>void,request?:RequestInit):Promise<Response>{
  if(!response.ok){
    // A list read can finish after its screen closes or while an account status
    // check briefly withholds authority. Its caller retries or reports locally;
    // it must not leave a Runtime-outage banner on an unrelated healthy screen.
    if(request?.method==='POST'&&typeof request.body==='string'){
      let intent:unknown;try{intent=JSON.parse(request.body);}catch{}
      const parsed=AppDataRequestSchema.safeParse(intent);
      if(parsed.success&&['resource_list','record_list'].includes(parsed.data.operation))return response;
    }
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
